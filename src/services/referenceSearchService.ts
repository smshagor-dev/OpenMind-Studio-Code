import type { IpcClient, SearchFileMatches, SearchLineMatch, SearchOutcome } from "./ipc";
import type { SearchResultOpener } from "./searchService";

export type ReferenceStatus = "idle" | "searching" | "done" | "error";

export interface ReferenceState {
  /** The word references were looked up for. */
  word: string;
  status: ReferenceStatus;
  outcome: SearchOutcome | null;
  error: string | null;
  /** Always `text`: matches of the word, not semantic references. */
  kind: "text";
  source: "index" | "disk" | null;
}

const MAX_RESULTS = 5_000;

/**
 * "Find References" when no language server answers it: every whole-word, case-sensitive occurrence of the word in the
 * workspace, from the index (or a plain read of the files while it is not ready). These are **text-based** matches —
 * comments, strings and other symbols with the same name are included, and nothing is resolved semantically — and the
 * results are labelled that way. A running language server's own references are shown by the editor itself. UI-free.
 */
export class ReferenceSearchService {
  private state: ReferenceState = {
    word: "",
    status: "idle",
    outcome: null,
    error: null,
    kind: "text",
    source: null,
  };
  private readonly listeners = new Set<() => void>();
  private counter = 0;

  constructor(
    private readonly ipc: IpcClient,
    private readonly opener: SearchResultOpener,
    private readonly getRoot: () => string | null,
    private readonly indexReady: () => boolean,
  ) {}

  getState(): ReferenceState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private update(patch: Partial<ReferenceState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Whether `word` can be looked up: an identifier-like word (letters, digits, `_`, `$`). */
  static isLookupWord(word: string): boolean {
    return /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(word);
  }

  async find(word: string): Promise<void> {
    const run = ++this.counter;
    const root = this.getRoot();
    if (root === null) {
      this.update({
        word,
        status: "error",
        outcome: null,
        error: "Open a folder first.",
        source: null,
      });
      return;
    }
    if (!ReferenceSearchService.isLookupWord(word)) {
      this.update({
        word,
        status: "error",
        outcome: null,
        error: "Put the cursor on a name (or select one) to find its references.",
        source: null,
      });
      return;
    }
    this.update({ word, status: "searching", outcome: null, error: null });
    const id = `refs-${String(run)}`;
    const request = {
      root,
      text: word,
      caseSensitive: true,
      wholeWord: true,
      useRegex: false,
      include: [],
      exclude: [],
      maxResults: MAX_RESULTS,
    };
    try {
      const useIndex = this.indexReady();
      const outcome = useIndex
        ? await this.ipc.searchTextIndexed(id, request)
        : await this.ipc.searchRun(id, request);
      if (run !== this.counter) return;
      this.update({ status: "done", outcome, source: useIndex ? "index" : "disk" });
    } catch (error) {
      if (run !== this.counter) return;
      this.update({ status: "error", outcome: null, error: String(error), source: null });
    }
  }

  clear(): void {
    this.counter += 1;
    this.update({ word: "", status: "idle", outcome: null, error: null, source: null });
  }

  async open(file: SearchFileMatches, match: SearchLineMatch): Promise<void> {
    await this.opener.openPathAt(file.path, {
      line: match.line,
      column: match.column,
      length: match.length,
    });
  }
}
