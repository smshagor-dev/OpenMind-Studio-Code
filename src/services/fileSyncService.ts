import type { DocumentService } from "./documentService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { ExplorerService } from "./explorerService";
import type { FsChange, FsChangeBatch, IpcClient } from "./ipc";
import { parentOf } from "./textSync";

export interface SyncResult {
  reloaded: number;
  conflicts: number;
  deleted: number;
}

const NOTHING: SyncResult = { reloaded: 0, conflicts: 0, deleted: 0 };

/** The titles of the documents each kind of outcome happened to. */
interface Outcome {
  reloaded: string[];
  conflicts: string[];
  deleted: string[];
}

function counts(outcome: Outcome): SyncResult {
  return {
    reloaded: outcome.reloaded.length,
    conflicts: outcome.conflicts.length,
    deleted: outcome.deleted.length,
  };
}

export interface CompareView {
  docId: string;
  title: string;
  /** The file as it is on disk now. */
  disk: string;
  /** The editor's text with the user's unsaved edits. */
  buffer: string;
}

export interface FileSyncState {
  compare: CompareView | null;
}

export interface FileSyncDeps {
  /** The open workspace folder, or `null`. */
  workspacePath: () => string | null;
  /** Something in the working tree changed (Source Control re-reads its status). */
  workingTreeChanged: () => Promise<unknown>;
  /** Every folder the Explorer has loaded (for a big burst of changes). */
  loadedFolders: () => string[];
}

/**
 * Keeps open editors honest about files that change outside the editor: Git
 * (stash, switch, discard, pull), a terminal, Composer/npm, another program.
 * The backend watcher reports debounced batches for the open workspace (never
 * `node_modules`, `.git`, `target`, `dist`, `build`, `vendor`); this decides
 * what each change means for an open document —
 *  - clean: reloaded (cursor and scroll stay where the text is unchanged);
 *  - with unsaved edits: never overwritten, marked "changed on disk" with a
 *    banner (Compare / Reload from Disk / Keep My Changes / Save As);
 *  - file gone: marked "deleted", text kept;
 *  - renamed or moved: the tab follows the file —
 * and refreshes the Explorer and Source Control. It also re-checks everything
 * when the window gets focus back and after Git operations, so files outside
 * the watched folder or missed events are caught too. It never saves.
 */
export class FileSyncService {
  private state: FileSyncState = { compare: null };
  private readonly listeners = new Set<() => void>();
  private offs: (() => void)[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private watching: string | null = null;

  constructor(
    private readonly ipc: IpcClient,
    private readonly events: EventBus<AppEvents>,
    private readonly documents: DocumentService,
    private readonly explorer: ExplorerService,
    private readonly deps: FileSyncDeps,
  ) {}

  getState(): FileSyncState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async initialize(): Promise<void> {
    this.dispose();
    try {
      this.offs.push(
        await this.ipc.onFsChanged((batch) => {
          void this.enqueue(() => this.handleBatch(batch));
        }),
      );
    } catch (error) {
      this.events.emit("appError", { message: `File watching unavailable: ${String(error)}` });
    }
    this.offs.push(
      this.events.on("workspaceFolderChanged", () => {
        void this.restartWatch();
      }),
      this.events.on("documentExternalChanged", ({ id }) => {
        if (this.state.compare?.docId === id) this.closeCompare();
      }),
    );
    if (typeof window !== "undefined") {
      const onFocus = () => {
        void this.enqueue(() => this.syncAll());
      };
      window.addEventListener("focus", onFocus);
      this.offs.push(() => {
        window.removeEventListener("focus", onFocus);
      });
    }
    await this.restartWatch();
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
  }

  /** (Re)starts the watcher for the open workspace, or stops it when there is none. */
  async restartWatch(): Promise<void> {
    const path = this.deps.workspacePath();
    if (path === this.watching) return;
    this.watching = path;
    try {
      if (path === null) await this.ipc.fileWatchStop();
      else await this.ipc.fileWatchStart(path);
    } catch (error) {
      this.watching = null;
      this.events.emit("appError", {
        message: `Couldn't watch the folder for changes: ${String(error)}`,
      });
    }
  }

  // --- Reacting to changes ---

  /** One batch from the watcher. */
  async handleBatch(batch: FsChangeBatch): Promise<SyncResult> {
    if (batch.overflow) {
      const result = await this.syncAll();
      await this.explorer.refreshLoaded(this.deps.loadedFolders());
      await this.deps.workingTreeChanged();
      return result;
    }
    if (batch.changes.length === 0) return NOTHING;
    const ids = new Set<string>();
    const folders = new Set<string>();
    for (const change of batch.changes) {
      this.collect(change, ids, folders);
    }
    const outcome = await this.check([...ids]);
    this.announce(outcome, false);
    if (folders.size > 0) await this.explorer.refreshLoaded([...folders]);
    await this.deps.workingTreeChanged();
    return counts(outcome);
  }

  /** Looks at every open file again (window focus, Git operations). */
  async syncAll(quiet = false): Promise<SyncResult> {
    const outcome = await this.check(this.documents.fileBackedIds());
    this.announce(outcome, quiet);
    return counts(outcome);
  }

  /**
   * After Git changed files (stash apply/pop, switch, discard, pull, delete
   * untracked): open buffers, the Explorer and Source Control are brought up
   * to date, and one notice says so if any editor changed.
   */
  async afterGitOperation(): Promise<SyncResult> {
    const result = await this.syncAll(true);
    await this.explorer.refreshLoaded(this.deps.loadedFolders());
    if (result.reloaded + result.conflicts + result.deleted > 0) {
      this.events.emit("appNotice", {
        message: "Git operation changed files; editor buffers refreshed.",
      });
    }
    return result;
  }

  // --- Conflict actions (the banner's buttons) ---

  compare(id: string): boolean {
    if (this.documents.externalState(id) !== "changed") return false;
    const disk = this.documents.diskContentOf(id);
    if (disk === null) return false;
    this.state = {
      compare: {
        docId: id,
        title: this.documents.snapshot(id).title,
        disk,
        buffer: this.documents.contentOf(id),
      },
    };
    this.notify();
    return true;
  }

  closeCompare(): void {
    if (this.state.compare === null) return;
    this.state = { compare: null };
    this.notify();
  }

  /** "Reload from Disk": the user's unsaved edits are dropped (the UI asks first). */
  async reloadFromDisk(id: string): Promise<boolean> {
    const title = this.documents.snapshot(id).title;
    const done = await this.documents.reloadFromDisk(id);
    if (done) this.events.emit("appNotice", { message: `${title} reloaded from disk.` });
    return done;
  }

  keepMine(id: string): void {
    this.documents.keepMine(id);
  }

  // --- Internals ---

  private collect(change: FsChange, ids: Set<string>, folders: Set<string>): void {
    if (change.kind === "renamed" && change.from !== null) {
      const fromId = this.documents.idForPath(change.from);
      if (fromId !== null && this.documents.idForPath(change.path) === null) {
        this.documents.retarget(fromId, change.path);
        const title = this.documents.snapshot(fromId).title;
        this.events.emit("appNotice", {
          message: `${title} was renamed or moved on disk; the tab follows it.`,
        });
        ids.add(fromId);
      }
      folders.add(parentOf(change.from));
    }
    const id = this.documents.idForPath(change.path);
    if (id !== null) ids.add(id);
    if (change.kind !== "modified") folders.add(parentOf(change.path));
  }

  private async check(ids: string[]): Promise<Outcome> {
    const outcome: Outcome = { reloaded: [], conflicts: [], deleted: [] };
    for (const id of ids) {
      if (!this.documents.has(id)) continue;
      const result = await this.documents.checkDisk(id);
      if (!this.documents.has(id)) continue;
      const title = this.documents.snapshot(id).title;
      if (result === "reloaded") outcome.reloaded.push(title);
      if (result === "conflict") outcome.conflicts.push(title);
      // `checkDisk` says "deleted" on every look; tell the user only the first time.
      if (result === "deleted" && !this.announcedDeleted.has(id)) {
        this.announcedDeleted.add(id);
        outcome.deleted.push(title);
      }
      if (result !== "deleted") this.announcedDeleted.delete(id);
    }
    return outcome;
  }

  private readonly announcedDeleted = new Set<string>();

  /** One short notice per kind, never one per file event. `quiet` leaves out plain reloads (the caller says something better). */
  private announce(outcome: Outcome, quiet: boolean): void {
    const { reloaded, conflicts, deleted } = outcome;
    if (!quiet && reloaded.length > 0) {
      this.events.emit("appNotice", {
        message:
          reloaded.length === 1
            ? `${reloaded[0] ?? "File"} reloaded from disk.`
            : `${String(reloaded.length)} files reloaded from disk.`,
      });
    }
    if (conflicts.length > 0) {
      this.events.emit("appNotice", {
        message:
          conflicts.length === 1
            ? `${conflicts[0] ?? "File"}: File changed on disk while you have unsaved changes.`
            : `${String(conflicts.length)} files changed on disk while you have unsaved changes.`,
      });
    }
    if (deleted.length > 0) {
      this.events.emit("appNotice", {
        message:
          deleted.length === 1
            ? `${deleted[0] ?? "File"} was deleted on disk.`
            : `${String(deleted.length)} open files were deleted on disk.`,
      });
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
