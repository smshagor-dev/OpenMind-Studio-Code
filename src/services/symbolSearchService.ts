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

/** Workspace symbols from the running language servers that offer them (fortls for Fortran). */
export type ServerSymbolSource = (query: string, limit: number) => Promise<SymbolHit[]>;

/**
 * The language servers' symbols first (they parse the code), then the index's symbols that aren't the same symbol
 * again (same file, line and name); `kind` filters both; at most `limit`.
 */
export function mergeSymbolHits(
  fromServers: readonly SymbolHit[],
  fromIndex: readonly SymbolHit[],
  kind: string | null,
  limit: number,
): SymbolHit[] {
  const key = (hit: SymbolHit) => `${hit.path.replaceAll("\\", "/").toLowerCase()}|${String(hit.line)}|${hit.name}`;
  const servers = fromServers.filter((hit) => kind === null || hit.kind === kind);
  const seen = new Set(servers.map(key));
  return [...servers, ...fromIndex.filter((hit) => !seen.has(key(hit)))].slice(0, limit);
}

/**
 * Symbol search over the whole workspace: the symbols of running language servers that offer workspace symbols (fortls
 * for Fortran), then the index's symbols, which are read from source text with line-based patterns (TypeScript/JavaScript,
 * Python, PHP, Rust, Markdown headings, JSON keys) — a heuristic fallback that can miss or misread unusual code. UI-free.
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
    private readonly fromServers: ServerSymbolSource | null = null,
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
    this.update({ status: "searching", error: null });
    // A server that fails or isn't running adds nothing; the index answers as before.
    const query = this.state.query;
    const servers =
      this.fromServers !== null && query.trim() !== ""
        ? this.fromServers(query, SYMBOL_RESULT_LIMIT).catch((): SymbolHit[] => [])
        : Promise.resolve<SymbolHit[]>([]);
    if (!this.hasFiles()) {
      const found = await servers;
      if (run !== this.counter) return;
      if (found.length > 0) {
        this.update({ results: mergeSymbolHits(found, [], this.state.kind, SYMBOL_RESULT_LIMIT), status: "done" });
        return;
      }
      this.update({
        results: [],
        status: "error",
        error:
          "The workspace index has no symbols yet. It builds in the background; try again in a moment.",
      });
      return;
    }
    try {
      const [fromServers, fromIndex] = await Promise.all([
        servers,
        this.ipc.searchSymbolsIndexed(query, this.state.kind, SYMBOL_RESULT_LIMIT),
      ]);
      if (run !== this.counter) return;
      const results = mergeSymbolHits(fromServers, fromIndex, this.state.kind, SYMBOL_RESULT_LIMIT);
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
