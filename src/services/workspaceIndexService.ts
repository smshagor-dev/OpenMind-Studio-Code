import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient } from "./ipc";
import type { IndexSettingsRequest, IndexStatus } from "./searchIpc";

/** What the index service reads from the settings. */
export interface IndexSettingsSource {
  bool: (id: string, fallback: boolean) => boolean;
  number: (id: string, fallback: number) => number;
  string: (id: string, fallback: string) => string;
}

/** The ids of the `search.indexing.*` settings (a change restarts indexing with the new values). */
export const INDEX_SETTING_IDS = [
  "search.indexing.enabled",
  "search.indexing.exclude",
  "search.indexing.maxFileSizeKb",
  "search.indexing.useGitignore",
  "search.indexing.indexHiddenFiles",
];

/** The most indexed text a workspace may hold (files beyond it are listed by name only). */
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export function indexSettingsFrom(settings: IndexSettingsSource): IndexSettingsRequest {
  return {
    enabled: settings.bool("search.indexing.enabled", true),
    maxFileBytes: Math.max(64, settings.number("search.indexing.maxFileSizeKb", 1024)) * 1024,
    maxTotalBytes: MAX_TOTAL_BYTES,
    useGitignore: settings.bool("search.indexing.useGitignore", true),
    indexHidden: settings.bool("search.indexing.indexHiddenFiles", false),
    exclude: settings
      .string("search.indexing.exclude", "")
      .split(",")
      .map((pattern) => pattern.trim())
      .filter((pattern) => pattern !== ""),
  };
}

export interface IndexState {
  status: IndexStatus | null;
  /** A command (rebuild, clear, start) is being sent. */
  busy: boolean;
  /** The last command failed. */
  error: string | null;
}

function sameFolder(a: string | null, b: string | null): boolean {
  const norm = (path: string | null) =>
    path === null ? null : path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) !== null && norm(a) === norm(b);
}

/**
 * The background index of the open folder, as the UI sees it: its status (pushed by the backend while it runs),
 * and the actions — start, refresh, rebuild, clear, cancel. It starts indexing when a folder opens (unless the
 * setting turns it off), follows the `search.indexing.*` settings, and tells the backend about saved files. Search
 * services ask `isReady()` to decide between the index and a plain search of the disk. UI-free.
 */
export class WorkspaceIndexService {
  private state: IndexState = { status: null, busy: false, error: null };
  private readonly listeners = new Set<() => void>();
  private unlisten: (() => void) | null = null;

  constructor(
    private readonly ipc: IpcClient,
    private readonly events: EventBus<AppEvents>,
    private readonly getRoot: () => string | null,
    private readonly readSettings: () => IndexSettingsRequest,
  ) {}

  getState(): IndexState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private update(patch: Partial<IndexState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Listens for status pushed by the backend. Call once. */
  async listen(): Promise<void> {
    this.unlisten = await this.ipc.onIndexStatus((status) => {
      if (sameFolder(status.root, this.getRoot())) this.update({ status });
    });
  }

  dispose(): void {
    this.unlisten?.();
    this.unlisten = null;
  }

  /** The folder changed: index the new one (or forget the status when none is open). */
  async onWorkspaceChanged(): Promise<void> {
    if (this.getRoot() === null) {
      this.update({ status: null, error: null });
      return;
    }
    this.update({ status: null, error: null });
    await this.start(false);
  }

  /** Starts (or, with `restart`, restarts with the current settings) an incremental pass. */
  async start(restart: boolean): Promise<void> {
    if (this.getRoot() === null) return;
    await this.run(async () => {
      const status = await this.ipc.indexStart(this.readSettings(), restart);
      if (sameFolder(status.root, this.getRoot())) this.update({ status });
    });
  }

  /** Refresh Index: look at the folder again; only what changed is read. */
  refresh(): Promise<void> {
    return this.start(false);
  }

  /** Rebuild Workspace Index: delete everything and index again. */
  async rebuild(): Promise<void> {
    await this.run(async () => {
      await this.ipc.indexRebuild(this.readSettings());
    });
  }

  /** Clear Search Index: delete everything the index holds. Nothing is indexed until a pass starts. */
  async clear(): Promise<void> {
    await this.run(async () => {
      await this.ipc.indexClear();
      this.update({ status: await this.ipc.indexStatus() });
    });
  }

  async cancel(): Promise<void> {
    await this.run(async () => {
      await this.ipc.indexCancel();
    });
  }

  /** A file the editor just saved: the index takes it now (the file watcher would also see it). */
  async touch(path: string): Promise<void> {
    const root = this.getRoot();
    if (root === null || !this.state.status || this.state.status.state === "disabled") return;
    const inside = path
      .replace(/\\/g, "/")
      .toLowerCase()
      .startsWith(`${root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()}/`);
    if (!inside) return;
    try {
      await this.ipc.indexTouch([path]);
    } catch {
      // The file watcher and Refresh Index still bring the index up to date.
    }
  }

  private async run(action: () => Promise<void>): Promise<void> {
    this.update({ busy: true, error: null });
    try {
      await action();
      this.update({ busy: false });
    } catch (error) {
      this.update({ busy: false, error: String(error) });
      this.events.emit("appError", { message: `Search index: ${String(error)}` });
    }
  }

  /** The index can answer searches: it finished a pass and holds indexed text. */
  isReady(): boolean {
    const status = this.state.status;
    return status !== null && status.state === "idle" && status.indexed > 0;
  }

  /** The index has anything to search by name (also while it is still being built). */
  hasFiles(): boolean {
    const status = this.state.status;
    return (
      status !== null &&
      (status.state === "indexing" || status.state === "idle") &&
      status.indexed + status.skipped + status.errors + status.processed > 0
    );
  }

  /** Why an index action can't run now, or `null` when it can. */
  actionReason(action: "start" | "rebuild" | "clear" | "cancel"): string | null {
    if (this.getRoot() === null) return "Open a folder first.";
    const status = this.state.status;
    if (action === "cancel") {
      return status?.state === "indexing" ? null : "Nothing is being indexed.";
    }
    if (action === "clear" && (status === null || status.state === "none")) {
      return "The search index is empty.";
    }
    if (action !== "clear" && !this.readSettings().enabled) {
      return "Indexing is turned off (setting search.indexing.enabled).";
    }
    return null;
  }

  /** A short line for the status bar and the Search view. */
  label(): string {
    const status = this.state.status;
    if (this.getRoot() === null) return "";
    if (status === null || status.state === "none") return "Index: not built";
    switch (status.state) {
      case "disabled":
        return "Index: off";
      case "indexing":
        return status.processed > 0
          ? `Indexing ${String(status.processed)}/${String(status.discovered)}`
          : `Scanning ${String(status.discovered)} files…`;
      case "error":
        return "Index error";
      default:
        return `Index: ${String(status.indexed)} files`;
    }
  }

  /** The longer explanation shown as a tooltip and in the Search view. */
  detail(): string {
    const status = this.state.status;
    if (status === null || status.state === "none") {
      return "The workspace hasn't been indexed. Searching reads the files directly.";
    }
    if (status.state === "disabled") return "Indexing is turned off in the settings.";
    if (status.state === "error") return status.error ?? "The index couldn't be used.";
    const parts = [
      `${String(status.indexed)} files indexed`,
      `${String(status.skipped)} skipped (binary or too large)`,
      `${String(status.symbols)} symbols`,
    ];
    if (status.errors > 0) parts.push(`${String(status.errors)} unreadable`);
    if (status.lastIndexedMs !== null) {
      parts.push(`last updated ${new Date(status.lastIndexedMs).toLocaleTimeString()}`);
    }
    if (status.dbBytes > 0) parts.push(`${(status.dbBytes / (1024 * 1024)).toFixed(1)} MB on disk`);
    return parts.join(" · ");
  }
}
