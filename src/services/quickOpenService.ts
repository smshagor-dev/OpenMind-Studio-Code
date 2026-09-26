import type { FileSearchService } from "./fileSearchService";
import type { SymbolSearchService } from "./symbolSearchService";

export type QuickOpenMode = "files" | "symbols";

export interface QuickOpenState {
  open: boolean;
  mode: QuickOpenMode;
  selected: number;
}

/** One row of the picker, whatever it lists. */
export interface QuickItem {
  key: string;
  /** The file or symbol name. */
  label: string;
  /** The folder (files) or "kind · path" (symbols). */
  description: string;
  /** File name to draw an icon for. */
  iconName: string;
  /** Character ranges of `label` + `description` that matched (files only). */
  highlights: [number, number][];
  /** For symbols: the kind. */
  kind: string | null;
}

/**
 * The keyboard-driven picker behind Go to File (Ctrl+P) and Go to Symbol in Workspace (Ctrl+T): one query box over
 * the file-name or symbol search, arrow keys to move, Enter to open, Escape to close. All searching stays in the two
 * search services; this only holds what is open, the mode and the highlighted row. UI-free.
 */
export class QuickOpenService {
  private state: QuickOpenState = { open: false, mode: "files", selected: 0 };
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly files: FileSearchService,
    private readonly symbols: SymbolSearchService,
  ) {
    // New results (or a new status) from either search redraw the picker with the first row highlighted.
    const refresh = () => {
      this.update({ selected: 0 });
    };
    files.subscribe(refresh);
    symbols.subscribe(refresh);
  }

  getState(): QuickOpenState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private update(patch: Partial<QuickOpenState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Opens the picker in a mode with an empty query (the first files or symbols are listed at once). */
  show(mode: QuickOpenMode): void {
    this.files.clear();
    this.symbols.clear();
    this.update({ open: true, mode, selected: 0 });
    void (mode === "files" ? this.files.run() : this.symbols.run());
  }

  close(): void {
    if (!this.state.open) return;
    this.update({ open: false, selected: 0 });
  }

  setQuery(query: string): void {
    if (this.state.mode === "files") this.files.setQuery(query);
    else this.symbols.setQuery(query);
  }

  query(): string {
    return this.state.mode === "files"
      ? this.files.getState().query
      : this.symbols.getState().query;
  }

  /** What the picker says when it has no rows, or `null` when it has some. */
  emptyMessage(): string | null {
    const source = this.state.mode === "files" ? this.files.getState() : this.symbols.getState();
    if (source.status === "error") return source.error;
    if (source.status === "searching") return "Searching…";
    if (this.items().length > 0) return null;
    return source.status === "done" ? "No matching results." : "Type to search.";
  }

  items(): QuickItem[] {
    if (this.state.mode === "files") {
      return this.files.getState().results.map((hit) => {
        const dirLength = hit.relativePath.length - hit.name.length;
        return {
          key: hit.path,
          label: hit.name,
          description: hit.relativePath.slice(0, Math.max(0, dirLength - 1)),
          iconName: hit.name,
          highlights: hit.highlights,
          kind: null,
        };
      });
    }
    return this.symbols.getState().results.map((hit) => ({
      key: `${hit.path}:${String(hit.line)}:${String(hit.column)}:${hit.name}`,
      label: hit.name,
      description: `${hit.container === null ? "" : `${hit.container} · `}${hit.relativePath}:${String(hit.line)}`,
      iconName: hit.relativePath,
      highlights: [],
      kind: hit.kind,
    }));
  }

  move(delta: number): void {
    const count = this.items().length;
    if (count === 0) return;
    this.update({ selected: (((this.state.selected + delta) % count) + count) % count });
  }

  select(index: number): void {
    if (index >= 0 && index < this.items().length) this.update({ selected: index });
  }

  /** Opens the highlighted row (Enter) and closes the picker. */
  async accept(index = this.state.selected): Promise<boolean> {
    if (this.state.mode === "files") {
      const hit = this.files.getState().results[index];
      if (!hit) return false;
      this.close();
      await this.files.open(hit);
      return true;
    }
    const hit = this.symbols.getState().results[index];
    if (!hit) return false;
    this.close();
    await this.symbols.open(hit);
    return true;
  }
}
