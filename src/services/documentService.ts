import type { BufferManager } from "./bufferManager";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient, LineEnding, TextEncoding } from "./ipc";

export interface DocumentSnapshot {
  id: string;
  path: string | null;
  title: string;
  dirty: boolean;
  encoding: TextEncoding;
  lineEnding: LineEnding;
}

interface DocumentRecord {
  path: string | null;
  encoding: TextEncoding;
  lineEnding: LineEnding;
  savedContent: string;
}

/**
 * Owns document identity and lifecycle: which file (if any) a buffer is
 * bound to, its encoding/line-ending, dirty tracking, and open/save/save-as
 * orchestration. Delegates actual buffer content to `BufferManager` and
 * actual file I/O to `IpcClient` — this class is the business logic that
 * connects the two, independent of any UI framework.
 */
export class DocumentService {
  private readonly documents = new Map<string, DocumentRecord>();
  private nextId = 0;

  constructor(
    private readonly ipc: IpcClient,
    private readonly buffers: BufferManager,
    private readonly events: EventBus<AppEvents>,
  ) {}

  createUntitled(): string {
    const id = `untitled-${++this.nextId}`;
    this.documents.set(id, {
      path: null,
      encoding: "utf8",
      lineEnding: "lf",
      savedContent: "",
    });
    this.buffers.create(id, "");
    this.watchDirtyState(id);
    return id;
  }

  /** Opens `path`, reusing the existing document id if already open. */
  async openFromPath(path: string): Promise<string> {
    const existing = [...this.documents.entries()].find(([, doc]) => doc.path === path);
    if (existing) {
      return existing[0];
    }

    const opened = await this.ipc.documentOpen(path);
    const id = `doc-${++this.nextId}`;
    this.documents.set(id, {
      path: opened.path,
      encoding: opened.encoding,
      lineEnding: opened.lineEnding,
      savedContent: opened.content,
    });
    this.buffers.create(id, opened.content, languageIdForPath(opened.path));
    this.watchDirtyState(id);
    return id;
  }

  /** Saves to the document's current path, or delegates to `saveAs` if it has none yet. */
  async save(id: string): Promise<void> {
    const doc = this.requireDocument(id);
    if (doc.path === null) {
      await this.saveAs(id);
      return;
    }
    await this.writeAndMarkClean(id, doc, doc.path);
  }

  /** Prompts for a path via the native save dialog, then saves there. */
  async saveAs(id: string): Promise<void> {
    const doc = this.requireDocument(id);
    const chosenPath = await this.ipc.saveDocumentDialog(doc.path ?? undefined);
    if (chosenPath === null) {
      return;
    }
    await this.writeAndMarkClean(id, doc, chosenPath);
  }

  has(id: string): boolean {
    return this.documents.has(id);
  }

  /** The URI of the document's Monaco model, or `null` if it isn't open. */
  modelUri(id: string): string | null {
    return this.buffers.get(id)?.uri.toString() ?? null;
  }

  /** The open document whose model has this URI (used to label editor markers). */
  idForModelUri(uri: string): string | undefined {
    return this.buffers.idForUri(uri);
  }

  languageOf(id: string): string {
    return this.buffers.getLanguage(id);
  }

  /** Switches the syntax mode of an open document (e.g. Markdown Editor vs Text Editor). */
  setLanguage(id: string, languageId: string): void {
    this.requireDocument(id);
    this.buffers.setLanguage(id, languageId);
  }

  /** The current text of an open document (the Markdown preview renders this live). */
  contentOf(id: string): string {
    return this.buffers.getValue(id);
  }

  /** Calls `listener` whenever the document's text changes; returns the unsubscribe function. */
  onDidChangeContent(id: string, listener: () => void): () => void {
    this.requireDocument(id);
    return this.buffers.onDidChangeContent(id, listener);
  }

  isDirty(id: string): boolean {
    const doc = this.requireDocument(id);
    return this.buffers.getValue(id) !== doc.savedContent;
  }

  snapshot(id: string): DocumentSnapshot {
    const doc = this.requireDocument(id);
    return {
      id,
      path: doc.path,
      title: doc.path ? basename(doc.path) : "Untitled",
      dirty: this.isDirty(id),
      encoding: doc.encoding,
      lineEnding: doc.lineEnding,
    };
  }

  /** Replaces the buffer with the last-saved content (VS Code's "Revert File"). */
  revert(id: string): void {
    const doc = this.requireDocument(id);
    if (this.buffers.getValue(id) !== doc.savedContent) {
      this.buffers.setValue(id, doc.savedContent);
    }
  }

  close(id: string): void {
    this.buffers.dispose(id);
    this.documents.delete(id);
  }

  private async writeAndMarkClean(id: string, doc: DocumentRecord, path: string): Promise<void> {
    const content = this.buffers.getValue(id);
    await this.ipc.documentSave(path, content, doc.encoding);
    doc.path = path;
    doc.savedContent = content;
    this.events.emit("documentDirtyChanged", { id, dirty: false });
    this.events.emit("documentSaved", { id, path });
  }

  private watchDirtyState(id: string): void {
    this.buffers.onDidChangeContent(id, () => {
      this.events.emit("documentDirtyChanged", { id, dirty: this.isDirty(id) });
    });
  }

  private requireDocument(id: string): DocumentRecord {
    const doc = this.documents.get(id);
    if (!doc) {
      throw new Error(`document "${id}" does not exist`);
    }
    return doc;
  }
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const segments = normalized.split("/");
  return segments[segments.length - 1] || path;
}

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  md: "markdown",
  rs: "rust",
  py: "python",
  css: "css",
  html: "html",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  sql: "sql",
};

function languageIdForPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  return (extension && EXTENSION_LANGUAGE_MAP[extension]) || "plaintext";
}
