import type { DocumentService } from "./documentService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { HostDocument } from "./extensionHostBridge";
import type { HostRange, HostSelection } from "./hostEdits";

/** How long typing waits before the host is told the new text. */
export const CHANGE_DELAY_MS = 200;
/** How long cursor movement waits before the host is told the new selection. */
export const SELECTION_DELAY_MS = 60;

/** The active text editor as the host sees it. */
export interface HostEditorInfo {
  id?: string;
  viewColumn?: number;
  active?: boolean;
  visibleRanges?: HostRange[];
  selectionKind?: number;
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
  visibleEditors?: () => HostEditorInfo[];
  editorState?: (
    id: string,
  ) => { selections: HostSelection[]; tabSize: number; insertSpaces: boolean } | null;
  /** Subscribes to cursor/selection movement in the editors; returns the unsubscribe function. */
  onSelectionChange?: (listener: () => void) => () => void;
  /** The tab that is active right now (a text tab's id is its document id), so a host that starts later still knows it. */
  currentActiveId?: () => string | null;
  /** True while something that isn't a text editor (an extension webview panel) covers the editors. */
  editorsCovered?: () => boolean;
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
  private lastOptionsSent = "";
  private lastActiveSent = "";
  private lastEditorSnapshot = "";

  constructor(private readonly deps: HostSyncDeps) {}

  /** What `host/init` starts from. */
  initial(): { documents: HostDocument[]; activeEditor: HostEditorInfo | null; visibleEditors?: HostEditorInfo[] } {
    this.hydrate();
    const documents = this.deps.documents
      .fileBackedIds()
      .map((id) => this.describe(id))
      .filter((document): document is HostDocument => document !== null);
    return { documents, activeEditor: this.activeEditor(), ...(this.deps.visibleEditors ? { visibleEditors: this.visibleEditors() } : {}) };
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
        this.announceActive(true);
      }),
    );
    const offSelection = this.deps.onSelectionChange?.(() => {
      this.scheduleSelection();
    });
    if (offSelection) this.offs.push(offSelection);
    for (const id of documents.fileBackedIds()) this.watch(id);
    // The tab that is active now is known to the host from the start, without waiting for a tab change.
    this.hydrate();
    const editor = this.activeEditor();
    this.lastActiveSent = JSON.stringify(editor);
    this.lastSelectionSent = JSON.stringify(editor?.selections ?? null);
    this.lastOptionsSent = JSON.stringify(editor && { path: editor.path, tabSize: editor.tabSize, insertSpaces: editor.insertSpaces });
    if (this.deps.visibleEditors) { this.lastEditorSnapshot = ""; this.announceEditors(); }
  }

  /** Reads the active tab from the workbench (used at start and after a restart, when no event announces it). */
  private hydrate(): void {
    if (this.deps.currentActiveId) this.activeId = this.deps.currentActiveId();
  }

  /** Something that covers or uncovers the editors changed (a webview panel): tell the host if its editor view changed. */
  refreshActive(): void {
    this.announceActive(false);
  }

  private visibleEditors(): HostEditorInfo[] {
    return this.deps.editorsCovered?.() === true ? [] : this.deps.visibleEditors?.() ?? [];
  }

  private announceEditors(): void {
    const editors = this.visibleEditors();
    const active = this.activeEditor(editors);
    const snapshot = { editors, activeId: active?.id ?? active?.path ?? null };
    const serialized = JSON.stringify(snapshot);
    if (serialized === this.lastEditorSnapshot) return;
    this.lastEditorSnapshot = serialized;
    this.deps.notify("host/editorSnapshot", snapshot);
  }

  private announceActive(force: boolean): void {
    if (this.deps.visibleEditors) { this.announceEditors(); return; }
    const editor = this.activeEditor();
    const serialized = JSON.stringify(editor);
    if (!force && serialized === this.lastActiveSent) return;
    this.lastActiveSent = serialized;
    this.lastSelectionSent = JSON.stringify(editor?.selections ?? null);
    this.lastOptionsSent = JSON.stringify(editor && { path: editor.path, tabSize: editor.tabSize, insertSpaces: editor.insertSpaces });
    this.deps.notify("host/activeEditorChanged", { editor });
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

  private activeEditor(visible?: HostEditorInfo[]): HostEditorInfo | null {
    if (this.deps.visibleEditors) return (visible ?? this.visibleEditors()).find(editor => editor.active) ?? null;
    if (this.deps.editorsCovered?.() === true) return null;
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
      if (this.deps.visibleEditors) { this.announceEditors(); return; }
      const editor = this.activeEditor();
      if (editor === null) return;
      const options = { path: editor.path, tabSize: editor.tabSize, insertSpaces: editor.insertSpaces };
      const serializedOptions = JSON.stringify(options);
      if (serializedOptions !== this.lastOptionsSent) {
        this.lastOptionsSent = serializedOptions;
        this.deps.notify("host/editorOptionsChanged", options);
      }
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
      eol: this.deps.documents.eolOf(id) === "\r\n" ? 2 : 1,
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

