import type { IpcClient } from "./ipc";
import type { FileHit } from "./searchIpc";

export type LookupStatus = "idle" | "searching" | "done" | "error";

export interface FileSearchState {
  query: string;
  results: FileHit[];
  status: LookupStatus;
  error: string | null;
}

const DEBOUNCE_MS = 90;
export const FILE_RESULT_LIMIT = 100;

/** Where a file result opens. */
export interface FileOpener {
  openPath: (path: string) => Promise<string | null>;
}

/**
 * File-name / path search over the workspace index: exact name, prefix, substring, then letters in order; `*.php`
 * style patterns are globs. Typing again supersedes the search in flight (an older answer is dropped). UI-free.
 */
export class FileSearchService {
  private state: FileSearchState = { query: "", results: [], status: "idle", error: null };
  private readonly listeners = new Set<() => void>();
  private counter = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ipc: IpcClient,
    private readonly opener: FileOpener,
    /** The open folder, or `null` with none open. */
    private readonly getRoot: () => string | null,
    /** Whether the index holds any files (it may still be building). */
    private readonly hasFiles: () => boolean,
  ) {}

  getState(): FileSearchState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private update(patch: Partial<FileSearchState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  setQuery(query: string): void {
    this.update({ query });
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, DEBOUNCE_MS);
  }

  /** Runs the current query now (an empty query lists the first files). */
  async run(): Promise<void> {
    const run = ++this.counter;
    if (this.getRoot() === null) {
      this.update({ results: [], status: "error", error: "Open a folder to search for files." });
      return;
    }
    if (!this.hasFiles()) {
      this.update({
        results: [],
        status: "error",
        error:
          "The workspace index has no files yet. It builds in the background; try again in a moment.",
      });
      return;
    }
    this.update({ status: "searching", error: null });
    try {
      const results = await this.ipc.searchFilesIndexed(this.state.query, null, FILE_RESULT_LIMIT);
      if (run !== this.counter) return;
      this.update({ results, status: "done", error: null });
    } catch (error) {
      if (run !== this.counter) return;
      this.update({ results: [], status: "error", error: String(error) });
    }
  }

  clear(): void {
    this.counter += 1;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.update({ query: "", results: [], status: "idle", error: null });
  }

  async open(hit: FileHit): Promise<void> {
    await this.opener.openPath(hit.path);
  }
}
