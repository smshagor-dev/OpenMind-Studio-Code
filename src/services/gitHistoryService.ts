import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { GitService } from "./gitService";
import type { GitCommit, GitCommitFile } from "./ipc";

/** How many commits the History panel loads. */
export const HISTORY_LIMIT = 100;

/** `2026-01-02T03:04:05+00:00` as a local date and time ("" if it can't be read). */
export function formatCommitDate(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? "" : new Date(time).toLocaleString();
}

/** What a status letter means, for tooltips and the file rows. */
export function commitFileWord(status: string): string {
  const words: Record<string, string> = {
    A: "Added",
    M: "Modified",
    D: "Deleted",
    R: "Renamed",
    C: "Copied",
    T: "Type changed",
  };
  return words[status] ?? status;
}

export interface HistoryState {
  commits: GitCommit[];
  loading: boolean;
  error: string | null;
  /** The commit whose files are shown. */
  selected: string | null;
  files: GitCommitFile[];
  filesLoading: boolean;
  loaded: boolean;
}

const INITIAL: HistoryState = {
  commits: [],
  loading: false,
  error: null,
  selected: null,
  files: [],
  filesLoading: false,
  loaded: false,
};

/**
 * The History panel: the latest commits of the current branch, and the files of
 * the selected one. A file opens its diff for that commit. No graph — a plain
 * list, newest first.
 */
export class GitHistoryService {
  private state: HistoryState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private seq = 0;

  constructor(
    private readonly git: GitService,
    private readonly events: EventBus<AppEvents>,
    /** Shows a commit's diff of one file (`SourceControlService.openCommitDiff`). */
    private readonly showDiff: (hash: string, file: GitCommitFile) => Promise<void>,
  ) {}

  getState(): HistoryState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The selected commit, if it is in the list. */
  selectedCommit(): GitCommit | null {
    return this.state.commits.find((commit) => commit.hash === this.state.selected) ?? null;
  }

  async load(): Promise<void> {
    const seq = ++this.seq;
    this.update({ loading: true, error: null });
    try {
      const commits = await this.git.ipc.gitHistory(HISTORY_LIMIT);
      if (seq !== this.seq) return;
      const stillThere = commits.some((commit) => commit.hash === this.state.selected);
      this.update({
        commits,
        loading: false,
        loaded: true,
        ...(stillThere ? {} : { selected: null, files: [] }),
      });
    } catch (error) {
      if (seq !== this.seq) return;
      this.update({ loading: false, error: String(error) });
      this.git.log(`Error: ${String(error)}`);
    }
  }

  /** Selects a commit and loads the files it changed; selecting it again closes it. */
  async select(hash: string): Promise<void> {
    if (this.state.selected === hash) {
      this.update({ selected: null, files: [], error: null });
      return;
    }
    this.update({ selected: hash, files: [], filesLoading: true, error: null });
    try {
      const files = await this.git.ipc.gitCommitFiles(hash);
      if (this.state.selected === hash) this.update({ files, filesLoading: false });
    } catch (error) {
      if (this.state.selected !== hash) return;
      this.update({ filesLoading: false, error: String(error) });
      this.events.emit("appError", { message: String(error) });
    }
  }

  async openFile(file: GitCommitFile): Promise<void> {
    const hash = this.state.selected;
    if (hash !== null) await this.showDiff(hash, file);
  }

  /** Forget everything (another repository was opened). */
  reset(): void {
    this.seq++;
    this.update({ ...INITIAL });
  }

  private update(patch: Partial<HistoryState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
