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

export interface ExplorerSnapshot {
  rootPath: string | null;
  rootName: string | null;
  nodesByPath: Map<string, ExplorerNode>;
  childrenByPath: Map<string, string[]>;
  expandedPaths: Set<string>;
  selectedPath: string | null;
}

const EMPTY_SNAPSHOT: ExplorerSnapshot = {
  rootPath: null,
  rootName: null,
  nodesByPath: new Map(),
  childrenByPath: new Map(),
  expandedPaths: new Set(),
  selectedPath: null,
};

/**
 * Owns the explorer file tree: which directories are expanded, which entry
 * is selected, and the lazily-loaded node data itself — outside React
 * entirely, per the architecture rule. Directories are only ever read one
 * level at a time (`FileSystemService.readDir` per expand/refresh), so this
 * never recursively walks `node_modules`/`.git`/etc. on its own.
 */
export type ClipboardMode = "copy" | "cut";

export class ExplorerService {
  private snapshot: ExplorerSnapshot = EMPTY_SNAPSHOT;
  /** The explorer's own Copy/Cut clipboard (an entry path, not file contents), as in VS Code. */
  private clipboard: { path: string; mode: ClipboardMode } | null = null;

  constructor(
    private readonly fs: FileSystemService,
    private readonly ipc: IpcClient,
    private readonly events: EventBus<AppEvents>,
  ) {}

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
      rootPath,
      rootName,
      nodesByPath: new Map(),
      childrenByPath: new Map(),
      expandedPaths: new Set(saved.expandedPaths),
      selectedPath: saved.selectedPath,
    };

    await this.loadChildren(rootPath);
    for (const path of this.snapshot.expandedPaths) {
      await this.loadChildren(path);
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
    if (wasExpanded) {
      expandedPaths.delete(path);
    } else {
      expandedPaths.add(path);
    }
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
    if (!target) {
      return;
    }
    await this.loadChildren(target);
    this.emitChanged();
  }

  async collapseAll(): Promise<void> {
    this.snapshot = { ...this.snapshot, expandedPaths: new Set() };
    this.emitChanged();
    await this.persistState();
  }

  async select(path: string): Promise<void> {
    if (this.snapshot.selectedPath === path) {
      return;
    }
    this.snapshot = { ...this.snapshot, selectedPath: path };
    this.emitChanged();
    await this.persistState();
  }

  /** Expands every ancestor directory of `path` and selects it. */
  async revealPath(path: string): Promise<void> {
    const { rootPath } = this.snapshot;
    if (!rootPath || !path.startsWith(rootPath)) {
      return;
    }

    const rootDepth = splitPath(rootPath).length;
    const targetSegments = splitPath(path);
    const expandedPaths = new Set(this.snapshot.expandedPaths);
    let currentDir = rootPath;

    for (let depth = rootDepth; depth < targetSegments.length - 1; depth++) {
      if (!this.snapshot.childrenByPath.has(currentDir)) {
        await this.loadChildren(currentDir);
      }
      const children = this.snapshot.childrenByPath.get(currentDir) ?? [];
      const expectedName = targetSegments[depth];
      const match = children.find(
        (childPath) => this.snapshot.nodesByPath.get(childPath)?.name === expectedName,
      );
      if (!match) {
        break;
      }
      currentDir = match;
      expandedPaths.add(currentDir);
    }

    this.snapshot = { ...this.snapshot, expandedPaths, selectedPath: path };
    this.emitChanged();
    await this.persistState();
  }

  /** Creates a uniquely-named file in `parentDir` and returns its path, for the caller to enter rename mode on. */
  /** Before a new item is named in the tree: its folder's contents are loaded and the folder is open. */
  async prepareCreate(parentDir: string): Promise<void> {
    const { rootPath } = this.snapshot;
    if (!rootPath) return;
    if (parentDir !== rootPath && !this.snapshot.expandedPaths.has(parentDir)) {
      await this.toggleExpand(parentDir);
    } else if (!this.snapshot.childrenByPath.has(parentDir)) {
      await this.loadChildren(parentDir);
      this.emitChanged();
    }
  }

  /**
   * Creates a file or folder with the name the user typed (VS Code: nothing exists until a name is given). An existing
   * name is refused with a message; the new entry's path, or `null`.
   */
  async createNamed(parentDir: string, name: string, kind: "file" | "folder"): Promise<string | null> {
    const { rootPath } = this.snapshot;
    if (!rootPath || name === "") return null;
    const taken = (this.snapshot.childrenByPath.get(parentDir) ?? []).some(
      (child) => this.snapshot.nodesByPath.get(child)?.name.toLowerCase() === name.toLowerCase(),
    );
    if (taken) {
      this.events.emit("appError", {
        message: `A file or folder "${name}" already exists here. Choose a different name.`,
      });
      return null;
    }
    const created = await safely(
      this.events,
      () =>
        kind === "file"
          ? this.fs.createFile(rootPath, parentDir, name)
          : this.fs.createFolder(rootPath, parentDir, name),
      `create "${name}"`,
      null,
    );
    if (created === null) return null;
    await this.refresh(parentDir);
    return created;
  }

  async createFile(parentDir: string): Promise<string | null> {
    return this.createEntry(parentDir, "Untitled", (root, dir, name) =>
      this.fs.createFile(root, dir, name),
    );
  }

  async createFolder(parentDir: string): Promise<string | null> {
    return this.createEntry(parentDir, "New Folder", (root, dir, name) =>
      this.fs.createFolder(root, dir, name),
    );
  }

  /** Renames an entry; the new path, or `null` when it failed (the error is shown). */
  async rename(parentDir: string, path: string, newName: string): Promise<string | null> {
    const { rootPath } = this.snapshot;
    if (!rootPath) {
      return null;
    }
    const renamed = await safely<string | null>(
      this.events,
      () => this.fs.rename(rootPath, path, newName),
      "rename that item",
      null,
    );
    await this.refresh(parentDir);
    return renamed;
  }

  async deleteEntry(parentDir: string, path: string): Promise<void> {
    const { rootPath } = this.snapshot;
    if (!rootPath) {
      return;
    }
    await safely(this.events, () => this.fs.delete(rootPath, path), "delete that item", undefined);
    await this.refresh(parentDir);
  }

  async moveEntry(parentDir: string, source: string, destDir: string): Promise<void> {
    const { rootPath } = this.snapshot;
    if (!rootPath) {
      return;
    }
    await safely(
      this.events,
      () => this.fs.move(rootPath, source, destDir),
      "move that item",
      undefined,
    );
    await this.refresh(parentDir);
    await this.refresh(destDir);
  }

  setClipboard(path: string, mode: ClipboardMode): void {
    this.clipboard = { path, mode };
  }

  hasClipboard(): boolean {
    return this.clipboard !== null;
  }

  /**
   * Pastes the Copy/Cut entry into `destDir`: cut moves it (and clears the
   * clipboard); copy into its own folder duplicates under a "copy" name,
   * copy elsewhere keeps the original name.
   */
  async paste(destDir: string): Promise<void> {
    const { rootPath } = this.snapshot;
    const clip = this.clipboard;
    if (!rootPath || !clip) {
      return;
    }
    const sourceParent =
      this.snapshot.nodesByPath.get(clip.path)?.parentPath ?? parentOf(clip.path);
    if (clip.mode === "cut") {
      this.clipboard = null;
      if (sourceParent !== destDir) {
        await this.moveEntry(sourceParent, clip.path, destDir);
      }
      return;
    }
    if (sourceParent === destDir) {
      await this.duplicate(destDir, clip.path);
      return;
    }
    await safely(
      this.events,
      () => this.fs.copy(rootPath, clip.path, destDir),
      "paste that item",
      undefined,
    );
    await this.refresh(destDir);
  }

  async duplicate(parentDir: string, path: string): Promise<void> {
    const { rootPath } = this.snapshot;
    if (!rootPath) {
      return;
    }
    await safely(
      this.events,
      () => this.fs.duplicate(rootPath, path),
      "duplicate that item",
      undefined,
    );
    await this.refresh(parentDir);
  }

  private async createEntry(
    parentDir: string,
    baseName: string,
    create: (root: string, dir: string, name: string) => Promise<string>,
  ): Promise<string | null> {
    const { rootPath } = this.snapshot;
    if (!rootPath) {
      return null;
    }
    if (!this.snapshot.childrenByPath.has(parentDir)) {
      await this.loadChildren(parentDir);
    }
    const siblingNames = new Set(
      (this.snapshot.childrenByPath.get(parentDir) ?? [])
        .map((childPath) => this.snapshot.nodesByPath.get(childPath)?.name)
        .filter((name): name is string => name !== undefined),
    );
    const name = nextAvailableName(baseName, siblingNames);

    const created = await safely(
      this.events,
      () => create(rootPath, parentDir, name),
      `create "${name}"`,
      null,
    );
    if (created === null) {
      return null;
    }
    await this.refresh(parentDir);
    return created;
  }

  /**
   * Re-reads the folders that changed on disk — only those already loaded (the
   * root and expanded folders), so a change deep in a folder nobody opened
   * costs nothing. A folder that has vanished is skipped without an error
   * toast. `dirs` may spell paths with either slash style.
   */
  /** The root and every folder whose contents are loaded. */
  loadedFolders(): string[] {
    const root = this.snapshot.rootPath;
    return [...(root ? [root] : []), ...this.snapshot.childrenByPath.keys()];
  }

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

  private async loadChildren(dirPath: string, quiet = false): Promise<boolean> {
    let entries: DirEntryInfo[] | null;
    if (quiet) {
      entries = await this.fs.readDir(dirPath).catch(() => null);
    } else {
      entries = await safely(this.events, () => this.fs.readDir(dirPath), "read that folder", null);
    }
    if (entries === null) {
      return false;
    }

    const nodesByPath = new Map(this.snapshot.nodesByPath);
    const childPaths: string[] = [];
    for (const entry of entries) {
      nodesByPath.set(entry.path, {
        path: entry.path,
        name: entry.name,
        isDir: entry.isDir,
        isSymlink: entry.isSymlink,
        parentPath: dirPath,
      });
      childPaths.push(entry.path);
    }
    const childrenByPath = new Map(this.snapshot.childrenByPath);
    childrenByPath.set(dirPath, childPaths);
    this.snapshot = { ...this.snapshot, nodesByPath, childrenByPath };
    return true;
  }

  private async persistState(): Promise<void> {
    const { rootPath } = this.snapshot;
    if (!rootPath) {
      return;
    }
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

function parentOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : path;
}

function splitPath(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

function nextAvailableName(baseName: string, taken: Set<string>): string {
  if (!taken.has(baseName)) {
    return baseName;
  }
  let attempt = 2;
  let candidate = `${baseName} ${attempt}`;
  while (taken.has(candidate)) {
    attempt += 1;
    candidate = `${baseName} ${attempt}`;
  }
  return candidate;
}
