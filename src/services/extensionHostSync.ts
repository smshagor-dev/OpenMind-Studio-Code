import type { DocumentService } from "./documentService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { HostDocument } from "./extensionHostBridge";

/** How long typing waits before the host is told the new text. */
export const CHANGE_DELAY_MS = 200;

export interface HostSyncDeps {
  documents: DocumentService;
  events: EventBus<AppEvents>;
  notify: (method: string, params: unknown) => void;
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

  constructor(private readonly deps: HostSyncDeps) {}

  /** What `host/init` starts from. */
  initial(): { documents: HostDocument[]; activeEditor: { path: string } | null } {
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
        this.deps.notify("host/activeEditorChanged", { editor: this.activeEditor() });
      }),
    );
    for (const id of documents.fileBackedIds()) this.watch(id);
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    for (const off of this.watchers.values()) off();
    this.watchers.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Sends any edit still waiting for its delay, so a language feature request sees the current text. */
  flush(): void {
    for (const [id, timer] of [...this.timers]) {
      clearTimeout(timer);
      this.timers.delete(id);
      this.sendChange(id);
    }
  }

  private activeEditor(): { path: string } | null {
    if (this.activeId === null || !this.deps.documents.has(this.activeId)) return null;
    const path = this.deps.documents.snapshot(this.activeId).path;
    return path === null ? null : { path };
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
