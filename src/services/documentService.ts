import type * as monaco from "monaco-editor";

import type { BufferManager } from "./bufferManager";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { HostTextEdit } from "./hostEdits";
import type { IpcClient, LineEnding, TextEncoding } from "./ipc";
import { pathKey, sameText } from "./textSync";

export interface DocumentSnapshot {
  id: string;
  path: string | null;
  title: string;
  dirty: boolean;
  encoding: TextEncoding;
  lineEnding: LineEnding;
  /** How the file on disk relates to this document: in sync, changed by someone else while it has unsaved edits, or gone. */
  external: ExternalState;
}

export type ExternalState = "none" | "changed" | "deleted";

/** What looking at the file on disk again found. */
export type DiskCheck = "same" | "reloaded" | "conflict" | "deleted" | "unavailable";

interface DocumentRecord {
  path: string | null;
  encoding: TextEncoding;
  lineEnding: LineEnding;
  savedContent: string;
  external: ExternalState;
  /** The disk text behind a "changed" state (for Compare and Keep My Changes). */
  diskContent: string | null;
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
  private languageResolver: ((path: string) => string | null) | null = null;

  constructor(
    private readonly ipc: IpcClient,
    private readonly buffers: BufferManager,
    private readonly events: EventBus<AppEvents>,
  ) {}

  /** Languages the app doesn't know by itself (contributed by extensions), asked when the built-in table has none. */
  setLanguageResolver(resolver: (path: string) => string | null): void {
    this.languageResolver = resolver;
  }

  createUntitled(): string {
    const id = `untitled-${++this.nextId}`;
    this.documents.set(id, {
      path: null,
      encoding: "utf8",
      lineEnding: "lf",
      savedContent: "",
      external: "none",
      diskContent: null,
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
      external: "none",
      diskContent: null,
    });
    const builtIn = languageIdForPath(opened.path);
    const language =
      builtIn === "plaintext" ? (this.languageResolver?.(opened.path) ?? builtIn) : builtIn;
    const model = this.buffers.create(id, opened.content, language);
    // Monaco holds one line ending per model, so a mixed (or lone-CR) file reads back
    // slightly different from the file. The baseline is what the model holds right
    // after loading; otherwise such a file would look edited the moment it opens.
    const loaded = this.documents.get(id);
    if (loaded) loaded.savedContent = model.getValue();
    this.watchDirtyState(id);
    this.events.emit("documentOpened", { id });
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

  /** Edits from an extension, applied to the open buffer only (nothing is written to disk). */
  applyHostEdits(id: string, edits: HostTextEdit[]): void {
    this.requireDocument(id);
    this.buffers.applyHostEdits(id, edits);
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
      external: doc.external,
    };
  }

  // --- The file on disk changed underneath an open document ---

  /** The open document bound to this path (any slash style), if any. */
  idForPath(path: string): string | null {
    const key = pathKey(path);
    for (const [id, doc] of this.documents) {
      if (doc.path !== null && pathKey(doc.path) === key) return id;
    }
    return null;
  }

  /** Every open document that has a file behind it. */
  fileBackedIds(): string[] {
    return [...this.documents.entries()].filter(([, doc]) => doc.path !== null).map(([id]) => id);
  }

  externalState(id: string): ExternalState {
    return this.requireDocument(id).external;
  }

  /** The disk text behind a "changed" state. */
  diskContentOf(id: string): string | null {
    return this.requireDocument(id).diskContent;
  }

  /**
   * Looks at the file again. A clean document takes the new text (cursor and
   * scroll are kept where the text is unchanged); a document with unsaved
   * edits is never touched — it is marked "changed" instead; a missing file
   * marks it "deleted" and keeps its text. Never saves anything.
   */
  async checkDisk(id: string): Promise<DiskCheck> {
    const doc = this.requireDocument(id);
    if (doc.path === null) return "same";
    let read;
    try {
      read = await this.ipc.documentRead(doc.path);
    } catch {
      return "unavailable";
    }
    if (!this.documents.has(id)) return "unavailable";
    if (read.state === "unreadable") return "unavailable";
    if (read.state === "missing") {
      if (doc.external === "deleted") return "deleted";
      this.setExternal(id, "deleted", null);
      return "deleted";
    }
    const dirty = this.isDirty(id);
    if (sameText(read.content, doc.savedContent)) {
      if (doc.external !== "none") this.setExternal(id, "none", null);
      return "same";
    }
    if (!dirty || sameText(read.content, this.buffers.getValue(id))) {
      this.applyDisk(id, doc, read);
      return "reloaded";
    }
    const already = doc.external === "changed" && doc.diskContent === read.content;
    this.setExternal(id, "changed", read.content);
    return already ? "unavailable" : "conflict";
  }

  /** Discards unsaved edits and takes what is on disk ("Reload from Disk"). */
  async reloadFromDisk(id: string): Promise<boolean> {
    const doc = this.requireDocument(id);
    if (doc.path === null) return false;
    const read = await this.ipc.documentRead(doc.path);
    if (read.state !== "file" || !this.documents.has(id)) return false;
    this.applyDisk(id, doc, read);
    return true;
  }

  /** "Keep My Changes": what is on disk becomes the base the edits are compared with; the edits stay (and saving overwrites the file, on purpose). */
  keepMine(id: string): void {
    const doc = this.requireDocument(id);
    if (doc.external === "changed" && doc.diskContent !== null) doc.savedContent = doc.diskContent;
    this.setExternal(id, "none", null);
    this.events.emit("documentDirtyChanged", { id, dirty: this.isDirty(id) });
  }

  /** The file was renamed/moved: the open document follows it (text and edits untouched). */
  retarget(id: string, newPath: string): void {
    const doc = this.requireDocument(id);
    doc.path = newPath;
    this.setExternal(id, "none", null);
  }

  private applyDisk(
    id: string,
    doc: DocumentRecord,
    read: { content: string; encoding: TextEncoding; lineEnding: LineEnding },
  ): void {
    this.buffers.replaceContent(id, read.content);
    doc.encoding = read.encoding;
    doc.lineEnding = read.lineEnding;
    doc.savedContent = this.buffers.getValue(id);
    this.setExternal(id, "none", null);
    this.events.emit("documentDirtyChanged", { id, dirty: false });
  }

  private setExternal(id: string, external: ExternalState, diskContent: string | null): void {
    const doc = this.requireDocument(id);
    doc.external = external;
    doc.diskContent = diskContent;
    this.events.emit("documentExternalChanged", { id });
  }

  /** Replaces the buffer with the last-saved content (VS Code's "Revert File"). */
  revert(id: string): void {
    const doc = this.requireDocument(id);
    if (this.buffers.getValue(id) !== doc.savedContent) {
      this.buffers.setValue(id, doc.savedContent);
    }
  }

  /** Sets the markers `owner` reports for a document (a language server's diagnostics); empty clears them. */
  setMarkers(id: string, owner: string, markers: monaco.editor.IMarkerData[]): void {
    this.requireDocument(id);
    this.buffers.setMarkers(id, owner, markers);
  }

  close(id: string): void {
    this.events.emit("documentClosed", { id, path: this.documents.get(id)?.path ?? null });
    this.buffers.dispose(id);
    this.documents.delete(id);
  }

  private async writeAndMarkClean(id: string, doc: DocumentRecord, path: string): Promise<void> {
    const content = this.buffers.getValue(id);
    // Nothing was edited and the file is where it was: leave the bytes on disk alone
    // (a mixed-line-ending file must not be rewritten just because Save was pressed).
    const untouched = content === doc.savedContent && doc.external === "none" && doc.path === path;
    if (!untouched) await this.ipc.documentSave(path, content, doc.encoding);
    doc.path = path;
    doc.savedContent = content;
    doc.external = "none";
    doc.diskContent = null;
    this.events.emit("documentExternalChanged", { id });
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
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  json: "json",
  jsonc: "json",
  md: "markdown",
  rs: "rust",
  py: "python",
  pyi: "python",
  pyw: "python",
  php: "php",
  phtml: "php",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  sql: "sql",
};

function languageIdForPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  return (extension && EXTENSION_LANGUAGE_MAP[extension]) || "plaintext";
}
