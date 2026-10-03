import { entryNameProblem } from "./entryNames";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { FileSystemService } from "./fileSystemService";
import type { DirEntryInfo, IpcClient } from "./ipc";
import { safely } from "./safely";
import { pathKey } from "./textSync";

export interface ExplorerNode {
  path: string;
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  /** The directory this node lives in — `rootPath` for top-level entries. */
  parentPath: string;
}

/** A new file or folder being named in the tree (VS Code): nothing exists on disk until the name is confirmed. */
export interface PendingCreate {
  parentDir: string;
  kind: "file" | "folder";
}

export interface ExplorerSnapshot {
  rootPath: string | null;
  rootName: string | null;
  nodesByPath: Map<string, ExplorerNode>;
  childrenByPath: Map<string, string[]>;
  expandedPaths: Set<string>;
  selectedPath: string | null;
  /** The name box shown in the tree, if any. */
  pendingCreate?: PendingCreate | null;
}

/**
 * What the Explorer tells the rest of the app after an operation it performed itself succeeded — at once, never by
 * waiting for the file watcher (which reports the same change later; handling it again changes nothing).
 */
export interface ExplorerHost {
  /** A file the user just created: open it in the editor (which takes the keyboard focus). */
  openFile(path: string): Promise<unknown>;
  /** A file or folder now lives at `to`: open tabs, recent files and language tools follow. */
  pathMoved(from: string, to: string): void;
  /** A file or folder was deleted: open tabs for it show the deleted state. */
  pathDeleted(path: string): Promise<unknown>;
}

const NO_HOST: ExplorerHost = {
  openFile: () => Promise.resolve(),
  pathMoved: () => undefined,
  pathDeleted: () => Promise.resolve(),
};

const EMPTY_SNAPSHOT: ExplorerSnapshot = {
  rootPath: null,
  rootName: null,
  nodesByPath: new Map(),
  childrenByPath: new Map(),
  expandedPaths: new Set(),
  selectedPath: null,
  pendingCreate: null,
};

export type ClipboardMode = "copy" | "cut";

/** Where "New File/Folder" and "Paste" land: the given/selected folder, else that file's folder, else the root. */
export function targetDirFor(snapshot: ExplorerSnapshot, node: ExplorerNode | null): string {
  const selected =
    node ?? (snapshot.selectedPath ? snapshot.nodesByPath.get(snapshot.selectedPath) : undefined);
  if (!selected) return snapshot.rootPath ?? "";
  return selected.isDir ? selected.path : selected.parentPath;
}

/**
 * The one owner of the Explorer tree: the open folder's root, the lazily-loaded nodes (one `readDir` per folder,
 * never a recursive walk of `node_modules`/`.git`), expanded and selected entries, and the name box of a new entry —
 * outside React, per the architecture rule. Its own create/rename/move/delete update the tree from the backend's
 * answer immediately; the watcher's later report re-reads the same folder and finds nothing new (a folder's children
 * are always replaced as a whole, keyed by path, so an entry can never appear twice).
 */
export class ExplorerService {
  private snapshot: ExplorerSnapshot = EMPTY_SNAPSHOT;
  /** The explorer's own Copy/Cut clipboard (an entry path, not file contents), as in VS Code. */
  private clipboard: { path: string; mode: ClipboardMode } | null = null;
  private host: ExplorerHost = NO_HOST;

  constructor(
    private readonly fs: FileSystemService,
    private readonly ipc: IpcClient,
    private readonly events: EventBus<AppEvents>,
  ) {}

  setHost(host: ExplorerHost): void {
    this.host = host;
  }

  getSnapshot(): ExplorerSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    return this.events.on("explorerChanged", listener);
  }

  async setRoot(rootPath: string, rootName: string): Promise<void> {
    const saved = await safely(
      this.events,
      () => this.ipc.explorerStateLoad(rootPath),
      "load the saved explorer state",
      { expandedPaths: [], selectedPath: null },
    );
    this.snapshot = {
      ...EMPTY_SNAPSHOT,
      rootPath,
      rootName,
      nodesByPath: new Map(),
      childrenByPath: new Map(),
      expandedPaths: new Set(saved.expandedPaths),
      selectedPath: saved.selectedPath,
    };
    await this.loadChildren(rootPath);
    for (const path of this.snapshot.expandedPaths) {
      await this.loadChildren(path, true);
    }
    this.emitChanged();
  }

  clear(): void {
    this.snapshot = EMPTY_SNAPSHOT;
    this.emitChanged();
  }

  async toggleExpand(path: string): Promise<void> {
    const expandedPaths = new Set(this.snapshot.expandedPaths);
    const wasExpanded = expandedPaths.has(path);
    if (wasExpanded) expandedPaths.delete(path);
    else expandedPaths.add(path);
    this.snapshot = { ...this.snapshot, expandedPaths };
    this.emitChanged();
    if (!wasExpanded) {
      await this.loadChildren(path);
      this.emitChanged();
    }
    await this.persistState();
  }

  async refresh(path?: string): Promise<void> {
    const target = path ?? this.snapshot.rootPath;
    if (!target) return;
    await this.loadChildren(target);
    this.emitChanged();
  }

  async collapseAll(): Promise<void> {
    this.snapshot = { ...this.snapshot, expandedPaths: new Set() };
    this.emitChanged();
    await this.persistState();
  }

  async select(path: string): Promise<void> {
    if (this.snapshot.selectedPath === path) return;
    this.snapshot = { ...this.snapshot, selectedPath: path };
    this.emitChanged();
    await this.persistState();
  }

  /** Expands every ancestor folder of `path` (loading them as needed) and selects it. Paths compare as Windows does. */
  async revealPath(path: string): Promise<void> {
    const { rootPath } = this.snapshot;
    if (!rootPath || !isInside(rootPath, path)) return;
    const rootDepth = splitPath(rootPath).length;
    const targetSegments = splitPath(path);
    const expandedPaths = new Set(this.snapshot.expandedPaths);
    let currentDir = rootPath;
    let target = path;
    for (let depth = rootDepth; depth < targetSegments.length; depth++) {
      if (!this.snapshot.childrenByPath.has(currentDir)) await this.loadChildren(currentDir, true);
      const expectedName = (targetSegments[depth] ?? "").toLowerCase();
      const match = (this.snapshot.childrenByPath.get(currentDir) ?? []).find(
        (childPath) => this.snapshot.nodesByPath.get(childPath)?.name.toLowerCase() === expectedName,
      );
      if (!match) break;
      if (depth === targetSegments.length - 1) {
        target = match; // the tree's own spelling of the path
        break;
      }
      currentDir = match;
      expandedPaths.add(currentDir);
    }
    this.snapshot = { ...this.snapshot, expandedPaths, selectedPath: target };
    this.emitChanged();
    await this.persistState();
  }

  // --- New file / new folder: the name box in the tree ---

  /** Shows the name box for a new entry in the target folder (opening that folder first). Nothing is created yet. */
  async beginCreate(kind: "file" | "folder", node: ExplorerNode | null = null): Promise<void> {
    const { rootPath } = this.snapshot;
    if (!rootPath) return;
    const parentDir = targetDirFor(this.snapshot, node);
    if (parentDir !== rootPath && !this.snapshot.expandedPaths.has(parentDir)) {
      const expandedPaths = new Set(this.snapshot.expandedPaths).add(parentDir);
      this.snapshot = { ...this.snapshot, expandedPaths };
      void this.persistState();
    }
    if (!this.snapshot.childrenByPath.has(parentDir)) await this.loadChildren(parentDir);
    this.snapshot = { ...this.snapshot, pendingCreate: { parentDir, kind } };
    this.emitChanged();
  }

  cancelCreate(): void {
    if (!this.snapshot.pendingCreate) return;
    this.snapshot = { ...this.snapshot, pendingCreate: null };
    this.emitChanged();
  }

  /** Why the name typed into the box can't be used (shown under the box while typing), or `null`. */
  createNameProblem(name: string): string | null {
    const pending = this.snapshot.pendingCreate;
    if (!pending) return null;
    return entryNameProblem(name, { nested: true, siblings: this.childNames(pending.parentDir) });
  }

  /**
   * Creates the entry the user named (an empty name, or a name the rules refuse, creates nothing). The tree shows and
   * selects it at once, and a new file opens in the editor. The new entry's path, or `null`.
   */
  async commitCreate(name: string): Promise<string | null> {
    const pending = this.snapshot.pendingCreate;
    const { rootPath } = this.snapshot;
    this.cancelCreate();
    if (!pending || !rootPath || name === "") return null;
    const problem = entryNameProblem(name, { nested: true, siblings: this.childNames(pending.parentDir) });
    if (problem !== null) {
      this.events.emit("appError", { message: problem });
      return null;
    }
    const created = await safely(
      this.events,
      () =>
        pending.kind === "file"
          ? this.fs.createFile(rootPath, pending.parentDir, name)
          : this.fs.createFolder(rootPath, pending.parentDir, name),
      `create "${name}"`,
      null,
    );
    if (created === null) return null;
    await this.loadChildren(pending.parentDir, true);
    await this.revealPath(created);
    if (pending.kind === "file") await this.host.openFile(created);
    return created;
  }

  // --- Rename, delete, move, paste ---

  /** Why `newName` can't be used for renaming `path`, or `null`. */
  renameProblem(path: string, newName: string): string | null {
    const node = this.snapshot.nodesByPath.get(path);
    if (!node) return null;
    return entryNameProblem(newName, {
      nested: false,
      siblings: this.childNames(node.parentPath),
      current: node.name,
    });
  }

  /** Renames an entry; the new path, or `null` when it failed (the error is shown). Open tabs follow at once. */
  async rename(parentDir: string, path: string, newName: string): Promise<string | null> {
    const { rootPath } = this.snapshot;
    if (!rootPath) return null;
    const problem = this.renameProblem(path, newName);
    if (problem !== null) {
      this.events.emit("appError", { message: problem });
      return null;
    }
    const renamed = await safely<string | null>(
      this.events,
      () => this.fs.rename(rootPath, path, newName),
      "rename that item",
      null,
    );
    if (renamed === null) return null;
    this.forgetSubtree(path, renamed);
    await this.loadChildren(parentDir, true);
    this.emitChanged();
    this.host.pathMoved(path, renamed);
    await this.persistState();
    return renamed;
  }

  async deleteEntry(parentDir: string, path: string): Promise<void> {
    const { rootPath } = this.snapshot;
    if (!rootPath) return;
    const deleted = await safely(
      this.events,
      () => this.fs.delete(rootPath, path).then(() => true),
      "delete that item",
      false,
    );
    if (!deleted) return;
    this.forgetSubtree(path, null);
    await this.loadChildren(parentDir, true);
    this.emitChanged();
    await this.host.pathDeleted(path);
    await this.persistState();
  }

  async moveEntry(parentDir: string, source: string, destDir: string): Promise<void> {
    const { rootPath } = this.snapshot;
    if (!rootPath) return;
    const moved = await safely<string | null>(
      this.events,
      () => this.fs.move(rootPath, source, destDir),
      "move that item",
      null,
    );
    if (moved === null) return;
    this.forgetSubtree(source, moved);
    await this.loadChildren(parentDir, true);
    await this.loadChildren(destDir, true);
    this.emitChanged();
    this.host.pathMoved(source, moved);
    await this.persistState();
  }

  setClipboard(path: string, mode: ClipboardMode): void {
    this.clipboard = { path, mode };
  }

  hasClipboard(): boolean {
    return this.clipboard !== null;
  }

  /**
   * Pastes the Copy/Cut entry into `destDir`: cut moves it (and clears the clipboard); copy into its own folder
   * duplicates under a "copy" name, copy elsewhere keeps the original name.
   */
  async paste(destDir: string): Promise<void> {
    const { rootPath } = this.snapshot;
    const clip = this.clipboard;
    if (!rootPath || !clip) return;
    const sourceParent = this.snapshot.nodesByPath.get(clip.path)?.parentPath ?? parentOf(clip.path);
    if (clip.mode === "cut") {
      this.clipboard = null;
      if (sourceParent !== destDir) await this.moveEntry(sourceParent, clip.path, destDir);
      return;
    }
    if (sourceParent === destDir) {
      await this.duplicate(destDir, clip.path);
      return;
    }
    await safely(this.events, () => this.fs.copy(rootPath, clip.path, destDir), "paste that item", undefined);
    await this.refresh(destDir);
  }

  async duplicate(parentDir: string, path: string): Promise<void> {
    const { rootPath } = this.snapshot;
    if (!rootPath) return;
    await safely(this.events, () => this.fs.duplicate(rootPath, path), "duplicate that item", undefined);
    await this.refresh(parentDir);
  }

  // --- Changes made outside the app (the watcher) ---

  /** The root and every folder whose contents are loaded. */
  loadedFolders(): string[] {
    const root = this.snapshot.rootPath;
    return [...(root ? [root] : []), ...this.snapshot.childrenByPath.keys()];
  }

  /**
   * Re-reads the folders that changed on disk — only those already loaded (the root and expanded folders), so a
   * change deep in a folder nobody opened costs nothing. A folder that has vanished is skipped without an error
   * toast. `dirs` may spell paths with either slash style or another letter case.
   */
  async refreshLoaded(dirs: readonly string[]): Promise<number> {
    const loaded = new Map<string, string>();
    if (this.snapshot.rootPath) loaded.set(pathKey(this.snapshot.rootPath), this.snapshot.rootPath);
    for (const path of this.snapshot.childrenByPath.keys()) loaded.set(pathKey(path), path);
    const targets = new Set<string>();
    for (const dir of dirs) {
      const actual = loaded.get(pathKey(dir));
      if (actual !== undefined) targets.add(actual);
    }
    let refreshed = 0;
    for (const target of targets) {
      if (await this.loadChildren(target, true)) refreshed++;
    }
    if (refreshed > 0) this.emitChanged();
    return refreshed;
  }

  // --- Internals ---

  private childNames(dir: string): string[] {
    return (this.snapshot.childrenByPath.get(dir) ?? [])
      .map((child) => this.snapshot.nodesByPath.get(child)?.name)
      .filter((name): name is string => name !== undefined);
  }

  /**
   * Reads one folder and replaces its children as a whole. Entries that are gone take their loaded sub-folders with
   * them (no stale nodes, no stale expanded state), so the tree after a read is exactly what is on disk.
   */
  private async loadChildren(dirPath: string, quiet = false): Promise<boolean> {
    const entries: DirEntryInfo[] | null = quiet
      ? await this.fs.readDir(dirPath).catch(() => null)
      : await safely(this.events, () => this.fs.readDir(dirPath), "read that folder", null);
    if (entries === null) return false;
    const fresh = new Set(entries.map((entry) => entry.path));
    for (const old of this.snapshot.childrenByPath.get(dirPath) ?? []) {
      if (!fresh.has(old)) this.forgetSubtree(old, null);
    }
    const nodesByPath = new Map(this.snapshot.nodesByPath);
    for (const entry of entries) {
      nodesByPath.set(entry.path, {
        path: entry.path,
        name: entry.name,
        isDir: entry.isDir,
        isSymlink: entry.isSymlink,
        parentPath: dirPath,
      });
    }
    const childrenByPath = new Map(this.snapshot.childrenByPath);
    childrenByPath.set(dirPath, [...fresh]);
    this.snapshot = { ...this.snapshot, nodesByPath, childrenByPath };
    return true;
  }

  /**
   * Drops `path` and everything loaded under it. When it moved to `to`, its expanded sub-folders and the selection
   * move along (re-read on demand); when it is gone, they are dropped.
   */
  private forgetSubtree(path: string, to: string | null): void {
    const key = pathKey(path);
    const inside = (candidate: string) => {
      const candidateKey = pathKey(candidate);
      return candidateKey === key || candidateKey.startsWith(`${key}/`);
    };
    const moved = (candidate: string) => (to === null ? null : to + candidate.slice(path.length));
    const nodesByPath = new Map([...this.snapshot.nodesByPath].filter(([p]) => !inside(p)));
    const childrenByPath = new Map([...this.snapshot.childrenByPath].filter(([p]) => !inside(p)));
    const expandedPaths = new Set<string>();
    for (const expanded of this.snapshot.expandedPaths) {
      if (!inside(expanded)) expandedPaths.add(expanded);
      else {
        const next = moved(expanded);
        if (next !== null) expandedPaths.add(next);
      }
    }
    const selected = this.snapshot.selectedPath;
    const selectedPath = selected !== null && inside(selected) ? moved(selected) : selected;
    this.snapshot = { ...this.snapshot, nodesByPath, childrenByPath, expandedPaths, selectedPath };
  }

  private async persistState(): Promise<void> {
    const { rootPath } = this.snapshot;
    if (!rootPath) return;
    await safely(
      this.events,
      () =>
        this.ipc.explorerStateSave(rootPath, {
          expandedPaths: [...this.snapshot.expandedPaths],
          selectedPath: this.snapshot.selectedPath,
        }),
      "save explorer state",
      undefined,
    );
  }

  private emitChanged(): void {
    this.events.emit("explorerChanged", undefined);
  }
}

/** Whether `path` is `root` or inside it, compared the way the file system does (slash style; drive paths ignore case). */
function isInside(root: string, path: string): boolean {
  const rootKey = pathKey(root).replace(/\/+$/, "");
  const key = pathKey(path);
  return key === rootKey || key.startsWith(`${rootKey}/`);
}

function parentOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : path;
}

function splitPath(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}
