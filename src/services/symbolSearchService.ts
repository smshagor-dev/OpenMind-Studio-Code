import type { LookupStatus } from "./fileSearchService";
import type { IpcClient } from "./ipc";
import type { SymbolHit } from "./searchIpc";

export interface SymbolSearchState {
  query: string;
  /** Only symbols of this kind (`null` = every kind). */
  kind: string | null;
  results: SymbolHit[];
  status: LookupStatus;
  error: string | null;
}

export const SYMBOL_KINDS = [
  "function",
  "method",
  "class",
  "interface",
  "enum",
  "struct",
  "trait",
  "type",
  "module",
  "constant",
  "variable",
  "heading",
  "key",
] as const;

const DEBOUNCE_MS = 120;
export const SYMBOL_RESULT_LIMIT = 200;

export interface SymbolOpener {
  openPathAt: (
    path: string,
    target: { line: number; column: number; length: number },
  ) => Promise<string | null>;
}

/**
 * Symbol search over the whole workspace, from the index. The symbols are read from source text with line-based
 * patterns (TypeScript/JavaScript, Python, PHP, Rust, Markdown headings, JSON keys) — a heuristic fallback, not a
 * language server: it can miss or misread unusual code. UI-free.
 */
export class SymbolSearchService {
  private state: SymbolSearchState = {
    query: "",
    kind: null,
    results: [],
    status: "idle",
    error: null,
  };
  private readonly listeners = new Set<() => void>();
  private counter = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ipc: IpcClient,
    private readonly opener: SymbolOpener,
    private readonly getRoot: () => string | null,
    private readonly hasFiles: () => boolean,
  ) {}

  getState(): SymbolSearchState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private update(patch: Partial<SymbolSearchState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  setQuery(query: string): void {
    this.update({ query });
    this.schedule();
  }

  setKind(kind: string | null): void {
    this.update({ kind });
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, DEBOUNCE_MS);
  }

  async run(): Promise<void> {
    const run = ++this.counter;
    if (this.getRoot() === null) {
      this.update({ results: [], status: "error", error: "Open a folder to search for symbols." });
      return;
    }
    if (!this.hasFiles()) {
      this.update({
        results: [],
        status: "error",
        error:
          "The workspace index has no symbols yet. It builds in the background; try again in a moment.",
      });
      return;
    }
    this.update({ status: "searching", error: null });
    try {
      const results = await this.ipc.searchSymbolsIndexed(
        this.state.query,
        this.state.kind,
        SYMBOL_RESULT_LIMIT,
      );
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

  /** Opens the file with the symbol's name selected. */
  async open(hit: SymbolHit): Promise<void> {
    await this.opener.openPathAt(hit.path, {
      line: hit.line,
      column: hit.column,
      length: hit.name.length,
    });
  }
}
