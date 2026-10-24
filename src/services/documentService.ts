import { parseSavedBuffer, type SavedBuffer } from "./documentSession";
import type * as monaco from "monaco-editor";

import { assemblyIncludeLanguage } from "../editor/assemblyGrammars";
import type { BufferManager } from "./bufferManager";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { HostEditOptions, HostTextEdit } from "./hostEdits";
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
  recoveredConflict?: boolean;
  virtualUri?: string;
  virtualReadOnly?: boolean;
  initialHostVersion?: number;
  untitledUri?: string;
  untitledName?: string;
  associatedPath?: string;
  path: string | null;
  /** An untitled document's number (VS Code: Untitled-1, Untitled-2 ...); `null` once it has a file. */
  untitled: number | null;
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
  private virtualSaver: ((uri: string, text: string) => Promise<void>) | null = null;
  private beforeSave: ((id: string) => Promise<void>) | null = null;
  /** Opens still reading the file: a second open of the same path waits for the first instead of making a second document. */
  private readonly opening = new Map<string, Promise<string>>();
  /** Documents kept open without a tab (a collaborative document participants edit), and closes they postponed. */
  private readonly holds = new Map<string, number>();
  private readonly closeWhenReleased = new Set<string>();

  constructor(
    private readonly ipc: IpcClient,
    private readonly buffers: BufferManager,
    private readonly events: EventBus<AppEvents>,
  ) {}

  /** Languages the app doesn't know by itself (contributed by extensions), asked when the built-in table has none. */
  setLanguageResolver(resolver: (path: string) => string | null): void {
    this.languageResolver = resolver;
  }

  createUntitled(content = "", language = "plaintext", named?: { uri: string; associatedPath?: string }, virtual?: { uri: string; readonly: boolean; version: number; recovery?: SavedBuffer }): string {
    const recovery = virtual?.recovery;
    const virtualUri = recovery?.kind === "untitled" ? undefined : virtual?.uri;
    let namedPath: string | undefined;
    if (named) {
      const resource = new URL(named.uri);
      if (resource.protocol !== "untitled:" || resource.search || resource.hash) throw new Error("Invalid untitled URI.");
      namedPath = decodeURIComponent(resource.pathname);
      if (!namedPath) throw new Error("An untitled URI needs a name.");
      const existing = this.idForHostPath(named.uri);
      if (existing !== null) return existing;
      language = this.languageFor(named.associatedPath ?? namedPath);
    }
    let id: string;
    do { id = `untitled-${++this.nextId}`; } while (this.idForHostPath(`untitled://openmind/${id}`) !== null);
    this.documents.set(id, {
      path: null,
      ...(virtualUri && virtual ? { virtualUri, virtualReadOnly: virtual.readonly, initialHostVersion: virtual.version } : {}),
      ...(recovery?.kind === "untitled" ? { untitledUri: recovery.uri, untitledName: recovery.name, associatedPath: recovery.associatedPath } : {}),
      untitled: virtualUri ? null : recovery?.number ?? this.freeUntitledNumber(),
      ...(named ? { untitledUri: named.uri, untitledName: basename(namedPath ?? ""), associatedPath: named.associatedPath } : {}),
      encoding: "utf8",
      lineEnding: "lf",
      savedContent: recovery?.savedText ?? (virtualUri ? content : ""),
      external: "none",
      diskContent: null,
    });
    this.buffers.create(id, content, language);
    if (virtualUri && !recovery) this.requireDocument(id).savedContent = this.buffers.getValue(id);
    this.watchDirtyState(id);
    this.events.emit("documentOpened", { id });
    return id;
  }

  recoverySnapshot(id: string): SavedBuffer | null {
    const doc = this.requireDocument(id);
    if (doc.path !== null && !this.isDirty(id) && doc.external === "none") return null;
    return { uri: this.hostPath(id), kind: doc.path !== null ? "file" : doc.virtualUri ? "virtual" : "untitled",
      ...(doc.path !== null ? { encoding: doc.encoding, lineEnding: doc.lineEnding } : {}),
      text: this.buffers.getValue(id), savedText: doc.savedContent, language: this.languageOf(id), readonly: this.isReadOnly(id),
      ...(doc.associatedPath ? { associatedPath: doc.associatedPath } : {}), ...(doc.untitledName ? { name: doc.untitledName } : {}),
      ...(doc.untitled !== null ? { number: doc.untitled } : {}) };
  }

  restoreBuffer(value: SavedBuffer): string {
    const saved = parseSavedBuffer(value);
    if (!saved || saved.kind === "file") throw new Error("Invalid saved editor buffer.");
    const existing = this.idForHostPath(saved.uri);
    if (existing !== null) return existing;
    const id = this.createUntitled(saved.text, saved.language, undefined, { uri: saved.uri, readonly: saved.readonly, version: 1, recovery: saved });
    this.events.emit("documentDirtyChanged", { id, dirty: this.isDirty(id) });
    return id;
  }

  /** Rebuild the user's buffer first; disk is checked for conflicts, never written during recovery. */
  async restoreFileBuffer(value: SavedBuffer): Promise<string> {
    const saved = parseSavedBuffer(value);
    if (!saved || saved.kind !== "file") throw new Error("Invalid saved file buffer.");
    const existing = this.idForPath(saved.uri);
    if (existing !== null) return existing;
    const read = await this.ipc.documentRead(saved.uri).catch(() => ({ state: "unreadable" as const, reason: "The file could not be read." }));
    // A concurrent open wins; never replace newer in-memory work.
    const opened = this.idForPath(saved.uri);
    if (opened !== null) return opened;
    const id = `doc-${++this.nextId}`;
    const currentMatches = read.state === "file" && read.content === saved.text;
    const conflict = read.state === "unreadable" || (read.state === "file" && !currentMatches && (!sameText(read.content, saved.savedText) || read.encoding !== saved.encoding));
    this.documents.set(id, { path: saved.uri, untitled: null,
      encoding: currentMatches ? read.encoding : saved.encoding ?? "utf8",
      lineEnding: currentMatches ? read.lineEnding : saved.lineEnding ?? "lf", savedContent: saved.savedText,
      external: read.state === "missing" ? "deleted" : conflict ? "changed" : "none",
      diskContent: conflict && read.state === "file" ? read.content : null, recoveredConflict: conflict });
    const model = this.buffers.create(id, saved.text, saved.language);
    if (currentMatches) this.requireDocument(id).savedContent = model.getValue();
    this.watchDirtyState(id);
    this.events.emit("documentOpened", { id });
    this.events.emit("documentExternalChanged", { id });
    this.events.emit("documentDirtyChanged", { id, dirty: this.isDirty(id) });
    return id;
  }

  autoSaveIds(): string[] {
    return [...this.documents].filter(([, doc]) => doc.path !== null || (!!doc.virtualUri && !doc.virtualReadOnly)).map(([id]) => id);
  }

  /** Provider resources own native models, but never native filesystem paths. */
  openVirtual(uri: string, text: string, language: string, readOnly = false, version = 1): string {
    if (!/^[a-z][a-z0-9+.-]*:\/\//.test(uri) || /^(file|untitled):/.test(uri)) throw new Error("Invalid virtual document URI.");
    decodeURIComponent(new URL(uri).pathname);
    const existing = this.idForHostPath(uri);
    if (existing !== null) {
      const doc = this.requireDocument(existing);
      if (doc.virtualReadOnly !== readOnly) {
        doc.virtualReadOnly = readOnly;
        this.events.emit("documentDirtyChanged", { id: existing, dirty: this.isDirty(existing) });
      }
      return existing;
    }
    const id = this.createUntitled(text, language, undefined, { uri, readonly: readOnly, version });
    return id;
  }

  isReadOnly(id: string): boolean { return this.requireDocument(id).virtualReadOnly === true; }
  initialHostVersion(id: string): number { return this.requireDocument(id).initialHostVersion ?? 1; }

  setVirtualSaver(save: (uri: string, text: string) => Promise<void>): void { this.virtualSaver = save; }
  isVirtual(id: string): boolean { return this.requireDocument(id).virtualUri !== undefined; }

  updateVirtual(uri: string, text: string): boolean {
    const id = this.idForHostPath(uri);
    if (id === null || !this.isVirtual(id) || this.isDirty(id)) return false;
    const doc = this.requireDocument(id);
    doc.savedContent = text.replace(/\r\n|\r|\n/g, this.eolOf(id));
    this.buffers.replaceContent(id, text);
    return true;
  }

  /** The lowest Untitled-N number no open document uses (VS Code reuses freed numbers). */
  private freeUntitledNumber(): number {
    const used = new Set([...this.documents.values()].map((doc) => doc.untitled));
    let number = 1;
    while (used.has(number)) number++;
    return number;
  }

  /**
   * Opens `path`, reusing the existing document id if already open (or still opening). Paths are compared the way the
   * file system does (either slash style; drive paths ignore case), so one file never becomes two documents.
   */
  async openFromPath(path: string): Promise<string> {
    const existing = this.idForPath(path);
    if (existing !== null) return existing;
    const key = pathKey(path);
    const pending = this.opening.get(key);
    if (pending) return pending;
    const opening = this.load(path).finally(() => {
      this.opening.delete(key);
    });
    this.opening.set(key, opening);
    return opening;
  }

  /** The editor language for a file: the built-in table first, then the extensions' and language registry's. */
  private languageFor(path: string): string {
    const builtIn = languageIdForPath(path);
    return builtIn === "plaintext" ? (this.languageResolver?.(path) ?? builtIn) : builtIn;
  }

  /**
   * The document's file is now `newPath`. Its language follows the new name unless the user picked one by hand (a
   * language that differs from what the old name gave), and everything that shows a path is told.
   */
  private movePath(id: string, doc: DocumentRecord, newPath: string): void {
    const from = doc.path;
    if (from !== null && from === newPath) return;
    const sourceName = doc.associatedPath ?? (doc.virtualUri ? decodeURIComponent(new URL(doc.virtualUri).pathname) : null);
    const automatic = from === null ? (sourceName ? this.languageFor(sourceName) : "plaintext") : this.languageFor(from);
    doc.path = newPath;
    doc.untitled = null;
    delete doc.virtualUri;
    delete doc.virtualReadOnly;
    delete doc.initialHostVersion;
    delete doc.recoveredConflict;
    if (this.buffers.getLanguage(id) === automatic) {
      const language = this.languageFor(newPath);
      if (language !== automatic) this.buffers.setLanguage(id, language);
    }
    this.events.emit("documentPathChanged", { id, from, to: newPath });
  }

  private async load(path: string): Promise<string> {
    const opened = await this.ipc.documentOpen(path);
    const id = `doc-${++this.nextId}`;
    this.documents.set(id, {
      path: opened.path,
      untitled: null,
      encoding: opened.encoding,
      lineEnding: opened.lineEnding,
      savedContent: opened.content,
      external: "none",
      diskContent: null,
    });
    // `.inc` is PHP's as often as NASM's: an include whose text looks like assembly opens as NASM.
    const include = opened.path.toLowerCase().endsWith(".inc")
      ? assemblyIncludeLanguage(opened.content)
      : null;
    const model = this.buffers.create(id, opened.content, include ?? this.languageFor(opened.path));
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
  async save(id: string, options: { format?: boolean } = {}): Promise<void> {
    const doc = this.requireDocument(id);
    if (doc.virtualUri) {
      if (doc.virtualReadOnly) throw new Error("The virtual document is read-only.");
      if (!this.virtualSaver) throw new Error("The virtual filesystem is unavailable.");
      const uri = doc.virtualUri;
      const content = this.buffers.getValue(id);
      await this.virtualSaver(uri, content);
      if (!this.has(id) || doc.virtualUri !== uri) return;
      doc.savedContent = content;
      this.events.emit("documentDirtyChanged", { id, dirty: this.isDirty(id) });
      this.events.emit("documentSaved", { id, path: uri });
      return;
    }
    if (doc.path === null) {
      if (doc.associatedPath) { await this.writeAndMarkClean(id, doc, doc.associatedPath); return; }
      await this.saveAs(id);
      return;
    }
    if (doc.recoveredConflict) throw new Error("The recovered file differs from disk. Reload, Keep My Changes, or Save As before saving.");
    if (this.beforeSave !== null && options.format !== false) {
      try {
        await this.beforeSave(id);
      } catch {
        // A hook that fails must never keep the file from being saved.
      }
    }
    await this.writeAndMarkClean(id, doc, doc.path);
  }

  /** Prompts for a path via the native save dialog, then saves there. */
  async saveAs(id: string): Promise<void> {
    const doc = this.requireDocument(id);
    const suggested = doc.path ?? doc.associatedPath ?? (doc.virtualUri ? basename(decodeURIComponent(new URL(doc.virtualUri).pathname)) : undefined);
    const chosenPath = await this.ipc.saveDocumentDialog(suggested);
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
    const from = this.languageOf(id);
    if (from === languageId) return;
    this.buffers.setLanguage(id, languageId);
    this.events.emit("documentLanguageChanged", { id, from });
  }

  /**
   * The languages the editor knows changed (an extension added one, the language registry loaded): an open file still
   * shown as Plain Text gets the language its name now has, so it is coloured at once instead of after a restart. A
   * language the user chose by hand is never replaced. Returns how many documents changed.
   */
  refreshLanguages(): number {
    let changed = 0;
    for (const [id, doc] of this.documents) {
      if (doc.path === null || this.buffers.getLanguage(id) !== "plaintext") continue;
      const language = this.languageFor(doc.path);
      if (language === "plaintext") continue;
      this.setLanguage(id, language);
      changed++;
    }
    return changed;
  }

  /** The current text of an open document (the Markdown preview renders this live). */
  contentOf(id: string): string {
    return this.buffers.getValue(id);
  }

  /** The editor model behind a document (for language-server requests). */
  modelFor(id: string): monaco.editor.ITextModel | null {
    return this.buffers.get(id) ?? null;
  }

  /** The line ending of the open buffer. */
  eolOf(id: string): "\n" | "\r\n" {
    this.requireDocument(id);
    return this.buffers.eolOf(id);
  }

  /** One indentation level as the buffer uses it. */
  indentUnitOf(id: string): string {
    this.requireDocument(id);
    return this.buffers.indentUnitOf(id);
  }

  /** Replaces the text as one undoable edit that touches only what differs (the cursor stays where it can). Nothing is saved. */
  replaceText(id: string, text: string): void {
    if (this.isReadOnly(id)) throw new Error("The virtual document is read-only.");
    this.buffers.replaceContent(id, text);
  }

  /** The text that results from applying `edits` (line/column ranges) to the buffer; the buffer is not changed. */
  textWithEdits(id: string, edits: { range: monaco.IRange; text: string }[]): string {
    this.requireDocument(id);
    return this.buffers.textWithEdits(id, edits);
  }

  /** Runs `hook` before a save to the document's own path (Format on Save). It must not throw; a failure never stops the save. */
  setBeforeSave(hook: ((id: string) => Promise<void>) | null): void {
    this.beforeSave = hook;
  }

  /** Edits from an extension, applied to the open buffer only (nothing is written to disk). */
  validateHostEdits(id: string, edits: HostTextEdit[]): void {
    this.requireDocument(id);
    this.buffers.validateHostEdits(id, edits);
  }

  applyHostEdits(id: string, edits: HostTextEdit[], options: HostEditOptions = {}): void {
    if (this.isReadOnly(id)) throw new Error("The virtual document is read-only.");
    this.buffers.applyHostEdits(id, edits, options);
  }

  /** Calls `listener` whenever the document's text changes; returns the unsubscribe function. */
  onDidChangeContent(id: string, listener: () => void): () => void {
    this.requireDocument(id);
    return this.buffers.onDidChangeContent(id, listener);
  }

  isDirty(id: string): boolean {
    const doc = this.requireDocument(id);
    return (doc.path === null && !!doc.associatedPath) || this.buffers.getValue(id) !== doc.savedContent;
  }

  /** The text the buffer was last saved as (or opened from): what its unsaved edits are relative to. */
  savedText(id: string): string {
    return this.requireDocument(id).savedContent;
  }

  snapshot(id: string): DocumentSnapshot {
    const doc = this.requireDocument(id);
    return {
      id,
      path: doc.path,
      title: doc.path ? basename(doc.path) : doc.virtualUri ? basename(decodeURIComponent(new URL(doc.virtualUri).pathname)) : doc.untitledName ?? `Untitled-${String(doc.untitled ?? 1)}`,
      dirty: this.isDirty(id),
      encoding: doc.encoding,
      lineEnding: doc.lineEnding === "mixed" && !this.isDirty(id) ? "mixed" : this.eolOf(id) === "\r\n" ? "crlf" : "lf",
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

  /** Stable extension-host identity; untitled URIs never enter filesystem APIs. */
  hostPath(id: string): string { const doc = this.requireDocument(id); return doc.path ?? doc.virtualUri ?? doc.untitledUri ?? `untitled://openmind/${id}`; }

  idForHostPath(path: string): string | null {
    if (/^[a-z][a-z0-9+.-]*:/.test(path) && !/^[a-z]:[\\/]/i.test(path)) {
      for (const [id, doc] of this.documents) if (doc.path === null && this.hostPath(id) === path) return id;
      return null;
    }
    return this.idForPath(path);
  }

  allIds(): string[] { return [...this.documents.keys()]; }

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

  /** The file was renamed/moved: the open document follows it (text, edits, cursor and undo history untouched). */
  retarget(id: string, newPath: string): void {
    const doc = this.requireDocument(id);
    this.movePath(id, doc, newPath);
    this.setExternal(id, "none", null);
  }

  /**
   * `from` (a file or a folder) is now `to`: every open document at or inside it follows. Returns how many did.
   * Used right after a rename/move done from the Explorer, before any watcher event arrives.
   */
  retargetPath(from: string, to: string): number {
    let moved = 0;
    for (const id of this.idsAtOrUnder(from)) {
      const path = this.requireDocument(id).path ?? "";
      this.retarget(id, to + path.slice(from.length));
      moved++;
    }
    return moved;
  }

  /** Open documents whose file is `path` or inside the folder `path`. */
  idsAtOrUnder(path: string): string[] {
    const key = pathKey(path).replace(/\/+$/, "");
    return [...this.documents.entries()]
      .filter(([, doc]) => {
        if (doc.path === null) return false;
        const docKey = pathKey(doc.path);
        return docKey === key || docKey.startsWith(`${key}/`);
      })
      .map(([id]) => id);
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
    if (external === "none") delete doc.recoveredConflict;
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

  /**
   * Keeps a document open even when no tab shows it (Milestone 24: the Owner's copy of a file participants edit). Its
   * dirty state, Save, Save All and Auto Save work as for any document; a close while held waits for the release.
   */
  hold(id: string): void {
    this.holds.set(id, (this.holds.get(id) ?? 0) + 1);
  }

  release(id: string): void {
    const left = (this.holds.get(id) ?? 1) - 1;
    if (left > 0) {
      this.holds.set(id, left);
      return;
    }
    this.holds.delete(id);
    if (this.closeWhenReleased.delete(id)) this.close(id);
  }

  isHeld(id: string): boolean {
    return this.holds.has(id);
  }

  close(id: string): void {
    if (this.holds.has(id)) {
      this.closeWhenReleased.add(id); // no tab shows it any more; it closes when the hold ends
      return;
    }
    this.events.emit("documentClosed", { id, path: this.documents.get(id)?.path ?? null });
    this.buffers.dispose(id);
    this.documents.delete(id);
  }

  private async writeAndMarkClean(id: string, doc: DocumentRecord, path: string): Promise<void> {
    if (doc.recoveredConflict && doc.path !== null && pathKey(doc.path) === pathKey(path)) throw new Error("Resolve the recovered file's disk conflict before overwriting it.");
    const other = this.idForPath(path);
    if (other !== null && other !== id) throw new Error("That file is already open in another document.");
    const content = this.buffers.getValue(id);
    // Nothing was edited and the file is where it was: leave the bytes on disk alone
    // (a mixed-line-ending file must not be rewritten just because Save was pressed).
    const untouched = content === doc.savedContent && doc.external === "none" && doc.path === path;
    if (!untouched) await this.ipc.documentSave(path, content, doc.encoding);
    this.movePath(id, doc, path);
    doc.savedContent = content;
    doc.external = "none";
    doc.diskContent = null;
    this.events.emit("documentExternalChanged", { id });
    this.events.emit("documentDirtyChanged", { id, dirty: this.isDirty(id) });
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
  // Assembly: Monaco's own MIPS grammar also claims `.s`; OpenMind's x86 GNU as grammar wins.
  asm: "nasm",
  nasm: "nasm",
  s: "gas",
};

function languageIdForPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  return (extension && EXTENSION_LANGUAGE_MAP[extension]) || "plaintext";
}

