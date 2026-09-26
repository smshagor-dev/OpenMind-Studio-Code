import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type {
  IpcClient,
  SearchFileMatches,
  SearchLineMatch,
  SearchOutcome,
  SearchQueryRequest,
} from "./ipc";
import type { OutputService } from "./outputService";
import { stamped } from "./outputService";

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
}

export type SearchStatus = "idle" | "searching" | "done" | "error";

export interface SearchState {
  query: string;
  options: SearchOptions;
  /** Comma-separated glob patterns, as typed. */
  include: string;
  exclude: string;
  status: SearchStatus;
  outcome: SearchOutcome | null;
  error: string | null;
  /** Relative paths of result files whose matches are folded away. */
  collapsed: readonly string[];
  /** Where the answer came from: the workspace index, or a plain read of the files (no index yet). */
  source: "index" | "disk" | null;
  /** How many result files are drawn (more are added on request, so a huge result set never freezes the panel). */
  visibleFiles: number;
  /** Result files whose long match list is shown in full. */
  expandedFiles: readonly string[];
}

export const RESULT_PAGE = 40;
export const MATCHES_PER_FILE = 100;

export const SEARCH_CHANNEL = "Search";
const DEBOUNCE_MS = 350;
const MAX_RESULTS = 10_000;

const INITIAL: SearchState = {
  query: "",
  options: { caseSensitive: false, wholeWord: false, useRegex: false },
  include: "",
  exclude: "",
  status: "idle",
  outcome: null,
  error: null,
  collapsed: [],
  source: null,
  visibleFiles: RESULT_PAGE,
  expandedFiles: [],
};

/** What the service needs to open a result. */
export interface SearchResultOpener {
  openPathAt: (
    path: string,
    target: { line: number; column: number; length: number },
  ) => Promise<string | null>;
}

/** Splits "a, b ,c" into patterns; blanks are dropped. */
export function parsePatterns(text: string): string[] {
  return text
    .split(",")
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== "");
}

/**
 * Global (workspace) search. Rust does the walking on a worker thread; this
 * service turns the user's query into a request, keeps only the newest
 * answer (typing again cancels the search in flight, and an older answer that
 * still arrives is ignored), and holds the result state the panel renders.
 * Opening a result goes through `WorkspaceService.openPathAt`, which opens the
 * file and reveals the match.
 */
export class SearchService {
  private state: SearchState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private runCounter = 0;
  private currentId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ipc: IpcClient,
    private readonly events: EventBus<AppEvents>,
    private readonly output: OutputService,
    /** The open workspace folder to search in, or `null` with none open. */
    private readonly getRoot: () => string | null,
    private readonly opener: SearchResultOpener,
    /** The workspace index; without it (or before it is ready) the files are searched directly. */
    private readonly index?: { isReady: () => boolean },
  ) {}

  getState(): SearchState {
    return this.state;
  }

  /** What the fields start with (the search settings); a field the user has changed keeps their value. */
  private defaults = {
    options: { ...INITIAL.options },
    include: INITIAL.include,
    exclude: INITIAL.exclude,
  };

  applyDefaults(next: { options: SearchOptions; include: string; exclude: string }): void {
    const previous = this.defaults;
    const options = { ...this.state.options };
    for (const key of Object.keys(next.options) as (keyof SearchOptions)[]) {
      if (options[key] === previous.options[key]) options[key] = next.options[key];
    }
    this.defaults = { options: { ...next.options }, include: next.include, exclude: next.exclude };
    this.update({
      options,
      include: this.state.include === previous.include ? next.include : this.state.include,
      exclude: this.state.exclude === previous.exclude ? next.exclude : this.state.exclude,
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // --- Query editing (each schedules a debounced search, like search-as-you-type) ---

  setQuery(query: string): void {
    this.update({ query });
    this.schedule();
  }

  setInclude(include: string): void {
    this.update({ include });
    this.schedule();
  }

  setExclude(exclude: string): void {
    this.update({ exclude });
    this.schedule();
  }

  toggleOption(name: keyof SearchOptions): void {
    this.update({ options: { ...this.state.options, [name]: !this.state.options[name] } });
    this.schedule();
  }

  /** Runs the search now (Enter, or the search action). */
  async run(): Promise<void> {
    this.clearTimer();
    const { query, options } = this.state;
    if (query === "") {
      this.cancel();
      this.update({ status: "idle", outcome: null, error: null });
      return;
    }
    const root = this.getRoot();
    if (root === null) {
      this.cancel();
      this.update({ status: "error", outcome: null, error: "Open a folder to search in it." });
      return;
    }

    this.cancelInFlight();
    const runNumber = ++this.runCounter;
    const searchId = `search-${String(runNumber)}`;
    this.currentId = searchId;
    this.update({
      status: "searching",
      error: null,
      collapsed: [],
      visibleFiles: RESULT_PAGE,
      expandedFiles: [],
    });
    const request: SearchQueryRequest = {
      root,
      text: query,
      ...options,
      include: parsePatterns(this.state.include),
      exclude: parsePatterns(this.state.exclude),
      maxResults: MAX_RESULTS,
    };
    try {
      let source: "index" | "disk" = this.index?.isReady() === true ? "index" : "disk";
      let outcome: SearchOutcome;
      if (source === "index") {
        try {
          outcome = await this.ipc.searchTextIndexed(searchId, request);
        } catch (indexError) {
          // A pattern or glob error is the user's to fix; anything else falls back to reading the files.
          const text = String(indexError);
          if (/isn't a valid|nothing to search/.test(text)) throw indexError;
          source = "disk";
          outcome = await this.ipc.searchRun(searchId, request);
        }
      } else {
        outcome = await this.ipc.searchRun(searchId, request);
      }
      if (runNumber !== this.runCounter) return; // a newer search took over
      this.update({ status: "done", outcome, error: null, source });
      this.logOutcome(query, outcome);
    } catch (error) {
      if (runNumber !== this.runCounter) return;
      const message = String(error);
      this.update({ status: "error", outcome: null, error: message });
      this.output.append(SEARCH_CHANNEL, stamped(`Search for "${query}" failed: ${message}`));
    } finally {
      if (this.currentId === searchId) this.currentId = null;
    }
  }

  /** Stops a search that is running; what was found so far is dropped along with it. */
  cancel(): void {
    this.clearTimer();
    this.cancelInFlight();
    this.runCounter += 1; // any answer still on its way is stale
    if (this.state.status === "searching") this.update({ status: "idle" });
  }

  /** Clears the query and results. */
  clear(): void {
    this.cancel();
    this.update({
      query: "",
      status: "idle",
      outcome: null,
      error: null,
      collapsed: [],
      source: null,
      visibleFiles: RESULT_PAGE,
      expandedFiles: [],
    });
  }

  toggleFile(relativePath: string): void {
    const collapsed = this.state.collapsed.includes(relativePath)
      ? this.state.collapsed.filter((path) => path !== relativePath)
      : [...this.state.collapsed, relativePath];
    this.update({ collapsed });
  }

  /** Draws the next page of result files. */
  showMoreFiles(): void {
    this.update({ visibleFiles: this.state.visibleFiles + RESULT_PAGE });
  }

  /** Shows every match of one file (a file's list is cut at `MATCHES_PER_FILE`). */
  expandMatches(relativePath: string): void {
    if (this.state.expandedFiles.includes(relativePath)) return;
    this.update({ expandedFiles: [...this.state.expandedFiles, relativePath] });
  }

  collapseAll(): void {
    this.update({ collapsed: this.state.outcome?.files.map((file) => file.relativePath) ?? [] });
  }

  expandAll(): void {
    this.update({ collapsed: [] });
  }

  /** Opens a result: the file, scrolled to and selecting the match. */
  async openMatch(file: SearchFileMatches, match: SearchLineMatch): Promise<void> {
    await this.opener.openPathAt(file.path, {
      line: match.line,
      column: match.column,
      length: match.length,
    });
  }

  private schedule(): void {
    this.clearTimer();
    if (this.state.query === "") {
      void this.run();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, DEBOUNCE_MS);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private cancelInFlight(): void {
    if (this.currentId !== null) {
      const id = this.currentId;
      this.currentId = null;
      this.ipc.searchCancel(id).catch((error: unknown) => {
        this.events.emit("appError", { message: `Couldn't cancel the search: ${String(error)}` });
      });
    }
  }

  private logOutcome(query: string, outcome: SearchOutcome): void {
    const files = outcome.files.length;
    const parts = [
      `Searched${this.state.source === "index" ? " (index)" : " (files)"} for "${query}": ${String(outcome.totalMatches)} match${outcome.totalMatches === 1 ? "" : "es"} in ${String(files)} file${files === 1 ? "" : "s"}`,
      `(${String(outcome.filesSearched)} searched, ${String(outcome.durationMs)} ms)`,
    ];
    if (outcome.truncated) parts.push("— stopped at the result limit");
    if (outcome.skippedBinary + outcome.skippedLarge > 0) {
      parts.push(
        `— skipped ${String(outcome.skippedBinary)} binary and ${String(outcome.skippedLarge)} large files`,
      );
    }
    this.output.append(SEARCH_CHANNEL, stamped(parts.join(" ")));
  }

  private update(patch: Partial<SearchState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener();
    }
  }
}
