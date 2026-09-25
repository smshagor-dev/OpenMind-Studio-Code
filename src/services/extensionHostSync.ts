import type { DocumentService } from "./documentService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { HostDocument } from "./extensionHostBridge";
import type { HostSelection } from "./hostEdits";

/** How long typing waits before the host is told the new text. */
export const CHANGE_DELAY_MS = 200;
/** How long cursor movement waits before the host is told the new selection. */
export const SELECTION_DELAY_MS = 60;

/** The active text editor as the host sees it. */
export interface HostEditorInfo {
  path: string;
  selections: HostSelection[];
  tabSize: number;
  insertSpaces: boolean;
}

export interface HostSyncDeps {
  documents: DocumentService;
  events: EventBus<AppEvents>;
  notify: (method: string, params: unknown) => void;
  /** Selections and options of the editor showing a document (by document id), when one does. */
  editorState?: (
    id: string,
  ) => { selections: HostSelection[]; tabSize: number; insertSpaces: boolean } | null;
  /** Subscribes to cursor/selection movement in the editors; returns the unsubscribe function. */
  onSelectionChange?: (listener: () => void) => () => void;
}

/**
 * Keeps the extension host's idea of the open files (text, language, version, active editor) current
 * while it runs. Only files with a path are shared. UI-free.
 */
export class HostDocumentSync {
  private offs: (() => void)[] = [];
  private readonly watchers = new Map<string, () => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly versions = new Map<string, number>();
  private activeId: string | null = null;
  private selectionTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSelectionSent = "";

  constructor(private readonly deps: HostSyncDeps) {}

  /** What `host/init` starts from. */
  initial(): { documents: HostDocument[]; activeEditor: HostEditorInfo | null } {
    const documents = this.deps.documents
      .fileBackedIds()
      .map((id) => this.describe(id))
      .filter((document): document is HostDocument => document !== null);
    return { documents, activeEditor: this.activeEditor() };
  }

  start(): void {
    this.stop();
    const { events, documents } = this.deps;
    this.offs.push(
      events.on("documentOpened", ({ id }) => {
        this.opened(id);
      }),
      events.on("documentClosed", ({ id, path }) => {
        this.closed(id, path);
      }),
      events.on("documentSaved", ({ id }) => {
        const document = this.describe(id);
        if (document) this.deps.notify("host/documentSaved", document);
      }),
      events.on("tabsChanged", ({ activeId }) => {
        this.activeId = activeId;
        const editor = this.activeEditor();
        this.lastSelectionSent = JSON.stringify(editor?.selections ?? null);
        this.deps.notify("host/activeEditorChanged", { editor });
      }),
    );
    const offSelection = this.deps.onSelectionChange?.(() => {
      this.scheduleSelection();
    });
    if (offSelection) this.offs.push(offSelection);
    for (const id of documents.fileBackedIds()) this.watch(id);
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    for (const off of this.watchers.values()) off();
    this.watchers.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.selectionTimer !== null) clearTimeout(this.selectionTimer);
    this.selectionTimer = null;
  }

  /** Sends any edit still waiting for its delay, so a language feature request sees the current text. */
  flush(): void {
    for (const [id, timer] of [...this.timers]) {
      clearTimeout(timer);
      this.timers.delete(id);
      this.sendChange(id);
    }
  }

  /** Whether typed text is still waiting to be sent (the host's copy is behind the buffer). */
  hasPending(id: string): boolean {
    return this.timers.has(id);
  }

  /** The version the host has of a document. */
  versionOf(id: string): number {
    return this.versions.get(id) ?? 1;
  }

  /** After the app itself changed a buffer (an extension's edit): the host hears it now, not after the delay. */
  commitChange(id: string): void {
    const pending = this.timers.get(id);
    if (pending !== undefined) clearTimeout(pending);
    this.timers.delete(id);
    this.sendChange(id);
  }

  private activeEditor(): HostEditorInfo | null {
    if (this.activeId === null || !this.deps.documents.has(this.activeId)) return null;
    const path = this.deps.documents.snapshot(this.activeId).path;
    if (path === null) return null;
    const state = this.deps.editorState?.(this.activeId) ?? null;
    return {
      path,
      selections: state?.selections ?? [
        { anchorLine: 0, anchorColumn: 0, activeLine: 0, activeColumn: 0 },
      ],
      tabSize: state?.tabSize ?? 4,
      insertSpaces: state?.insertSpaces ?? true,
    };
  }

  private scheduleSelection(): void {
    if (this.selectionTimer !== null) clearTimeout(this.selectionTimer);
    this.selectionTimer = setTimeout(() => {
      this.selectionTimer = null;
      const editor = this.activeEditor();
      if (editor === null) return;
      const serialized = JSON.stringify(editor.selections);
      if (serialized === this.lastSelectionSent) return;
      this.lastSelectionSent = serialized;
      this.deps.notify("host/selectionChanged", {
        path: editor.path,
        selections: editor.selections,
      });
    }, SELECTION_DELAY_MS);
  }

  private describe(id: string): HostDocument | null {
    if (!this.deps.documents.has(id)) return null;
    const { path, dirty } = this.deps.documents.snapshot(id);
    if (path === null) return null;
    return {
      path,
      languageId: this.deps.documents.languageOf(id),
      version: this.versions.get(id) ?? 1,
      text: this.deps.documents.contentOf(id),
      isDirty: dirty,
    };
  }

  private opened(id: string): void {
    const document = this.describe(id);
    if (document === null) return;
    this.watch(id);
    this.deps.notify("host/documentOpened", document);
  }

  private closed(id: string, path: string | null): void {
    this.watchers.get(id)?.();
    this.watchers.delete(id);
    const timer = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(id);
    this.versions.delete(id);
    if (path !== null) this.deps.notify("host/documentClosed", { path });
  }

  private watch(id: string): void {
    if (this.watchers.has(id) || !this.deps.documents.has(id)) return;
    this.watchers.set(
      id,
      this.deps.documents.onDidChangeContent(id, () => {
        const pending = this.timers.get(id);
        if (pending !== undefined) clearTimeout(pending);
        this.timers.set(
          id,
          setTimeout(() => {
            this.timers.delete(id);
            this.sendChange(id);
          }, CHANGE_DELAY_MS),
        );
      }),
    );
  }

  private sendChange(id: string): void {
    this.versions.set(id, (this.versions.get(id) ?? 1) + 1);
    const document = this.describe(id);
    if (document) this.deps.notify("host/documentChanged", document);
  }
}
