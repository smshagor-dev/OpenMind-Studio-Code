import type { GitService } from "./gitService";
import type { GitBlameLine, GitRepoStatus } from "./ipc";
import type { Availability } from "./runtimeService";

/** `path` relative to the repository `root` in either slash style (case-insensitive on Windows paths), or `null` outside it. */
export function relativeToRoot(root: string, path: string): string | null {
  const unify = (text: string) => text.replace(/\\/g, "/");
  const base = unify(root).replace(/\/+$/, "");
  const target = unify(path);
  const windows = /^[A-Za-z]:/.test(base);
  const head = target.slice(0, base.length);
  const same = windows ? head.toLowerCase() === base.toLowerCase() : head === base;
  if (!same || target.charAt(base.length) !== "/" || target.length === base.length + 1) return null;
  const relative = target.slice(base.length + 1);
  return relative.split("/").includes("..") ? null : relative;
}

export interface BlameInput {
  repo: { root: string; status: GitRepoStatus } | null;
  activePath: string | null;
  busy: boolean;
}

/** Pure: whether Blame can run for the active file, and if not, why. */
export function blameAvailability(input: BlameInput): Availability {
  if (input.repo === null) return { enabled: false, reason: "Open a Git repository first." };
  if (input.activePath === null)
    return { enabled: false, reason: "Open a saved file to blame it." };
  const relative = relativeToRoot(input.repo.root, input.activePath);
  if (relative === null) return { enabled: false, reason: "This file is outside the repository." };
  const change = input.repo.status.changes.find((entry) => entry.path === relative);
  if (change?.worktree === "untracked") {
    return { enabled: false, reason: "This file is untracked — it has no history to blame." };
  }
  if (input.busy) return { enabled: false, reason: "Please wait — Git is busy." };
  return { enabled: true };
}

/** `1700000000` as a local date ("" for 0 = not committed). */
export function formatBlameTime(seconds: number): string {
  return seconds > 0 ? new Date(seconds * 1000).toLocaleDateString() : "";
}

export interface BlameView {
  path: string;
  loading: boolean;
  lines: GitBlameLine[];
  error: string | null;
}

/**
 * Blame for the active file, shown over the editor area (never in the file
 * itself, so nothing is modified). It reads what Git knows: the saved file on
 * disk, line by line, with commit, author, date and summary.
 */
export class GitBlameService {
  private view: BlameView | null = null;
  private busy = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly git: GitService,
    private readonly activePath: () => string | null,
    private readonly repo: () => { root: string; status: GitRepoStatus } | null,
  ) {}

  getView(): BlameView | null {
    return this.view;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  state(): Availability {
    return blameAvailability({ repo: this.repo(), activePath: this.activePath(), busy: this.busy });
  }

  async open(): Promise<boolean> {
    const path = this.activePath();
    if (!this.state().enabled || path === null) return false;
    this.busy = true;
    this.set({ path, loading: true, lines: [], error: null });
    try {
      const lines = await this.git.ipc.gitBlame(path);
      this.set({ path, loading: false, lines, error: null });
      return true;
    } catch (error) {
      // Untracked / binary / too large / no commits: Git's reason, shown in the panel.
      this.set({ path, loading: false, lines: [], error: String(error) });
      this.git.log(`Blame: ${String(error)}`);
      return false;
    } finally {
      this.busy = false;
      this.notify();
    }
  }

  close(): void {
    if (this.view !== null) this.set(null);
  }

  private set(view: BlameView | null): void {
    this.view = view;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
