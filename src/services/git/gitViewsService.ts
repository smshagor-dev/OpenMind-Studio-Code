import type { CommitDetails, FileCommit, FileGitIpc, FileLogPage } from "./fileGitIpc";

/** Two texts side by side (or inline), e.g. a file at a revision against the working buffer. */
export interface CompareView {
  title: string;
  leftLabel: string;
  rightLabel: string;
  /** `null`: the file doesn't exist on that side. */
  original: string | null;
  modified: string | null;
  /** Picks the syntax highlighting. */
  path: string;
  /** A line of the right side to scroll to. */
  revealLine: number | null;
  inline: boolean;
}

export type HistoryMode = "list" | "graph" | "visual";

export interface HistoryView {
  path: string;
  name: string;
  mode: HistoryMode;
  commits: FileCommit[];
  more: boolean;
  loading: boolean;
  error: string | null;
  selected: string | null;
}

export interface CommitView {
  path: string;
  details: CommitDetails | null;
  loading: boolean;
  error: string | null;
  /** Quick Show: the commit's headline and actions only. */
  compact: boolean;
  /** The line it was opened for (Inspect Line Commit Details), if any. */
  line: number | null;
}

export interface GitViewsState {
  compare: CompareView | null;
  history: HistoryView | null;
  commit: CommitView | null;
}

/** Commits per page of a file's history. */
export const HISTORY_PAGE = 100;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What the per-file Git views show: the compare overlay, the file history (list, graph or timeline) and the
 * commit details. UI-free; loads history page by page and drops an answer that arrives after the view moved on.
 */
export class GitViewsService {
  private state: GitViewsState = { compare: null, history: null, commit: null };
  private readonly listeners = new Set<() => void>();
  private historySeq = 0;
  private commitSeq = 0;

  constructor(private readonly ipc: FileGitIpc) {}

  getState(): GitViewsState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(change: Partial<GitViewsState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }

  showCompare(view: Omit<CompareView, "inline">): void {
    this.set({ compare: { ...view, inline: this.state.compare?.inline ?? false } });
  }

  toggleCompareInline(): void {
    const compare = this.state.compare;
    if (compare) this.set({ compare: { ...compare, inline: !compare.inline } });
  }

  closeCompare(): void {
    this.set({ compare: null });
  }

  /** Opens the history of `path` (or switches its mode) and loads the first page. */
  async openHistory(path: string, mode: HistoryMode): Promise<void> {
    const current = this.state.history;
    if (current && current.path === path && current.error === null) {
      this.set({ history: { ...current, mode } });
      return;
    }
    const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
    this.set({
      history: { path, name, mode, commits: [], more: false, loading: true, error: null, selected: null },
    });
    await this.loadPage(0);
  }

  setHistoryMode(mode: HistoryMode): void {
    const history = this.state.history;
    if (history) this.set({ history: { ...history, mode } });
  }

  selectCommit(hash: string | null): void {
    const history = this.state.history;
    if (history) this.set({ history: { ...history, selected: hash } });
  }

  async loadMore(): Promise<void> {
    const history = this.state.history;
    if (!history || history.loading || !history.more) return;
    this.set({ history: { ...history, loading: true } });
    await this.loadPage(history.commits.length);
  }

  private async loadPage(skip: number): Promise<void> {
    const seq = ++this.historySeq;
    const path = this.state.history?.path;
    if (path === undefined) return;
    let page: FileLogPage | null = null;
    let error: string | null = null;
    try {
      page = await this.ipc.log(path, skip, HISTORY_PAGE);
    } catch (caught) {
      error = message(caught);
    }
    const history = this.state.history;
    if (seq !== this.historySeq || history?.path !== path) return;
    this.set({
      history: {
        ...history,
        commits: page ? [...history.commits.slice(0, skip), ...page.commits] : history.commits,
        more: page?.more ?? false,
        loading: false,
        error,
      },
    });
  }

  closeHistory(): void {
    this.historySeq++;
    this.set({ history: null });
  }

  /** Shows one commit's details (loading them). */
  async showCommit(path: string, hash: string, compact: boolean, line: number | null): Promise<void> {
    const seq = ++this.commitSeq;
    this.set({ commit: { path, details: null, loading: true, error: null, compact, line } });
    try {
      const details = await this.ipc.commit(path, hash);
      if (seq === this.commitSeq) this.set({ commit: { path, details, loading: false, error: null, compact, line } });
    } catch (error) {
      if (seq === this.commitSeq)
        this.set({ commit: { path, details: null, loading: false, error: message(error), compact, line } });
    }
  }

  expandCommit(): void {
    const commit = this.state.commit;
    if (commit) this.set({ commit: { ...commit, compact: false } });
  }

  closeCommit(): void {
    this.commitSeq++;
    this.set({ commit: null });
  }

  /** Everything closes when the folder changes (the paths belong to the old one). */
  closeAll(): void {
    this.historySeq++;
    this.commitSeq++;
    this.set({ compare: null, history: null, commit: null });
  }
}
