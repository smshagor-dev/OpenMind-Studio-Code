import type { BreakpointRow, IpcClient } from "./ipc";
import { pathKey } from "./textSync";

export interface Breakpoint {
  id: string;
  path: string;
  /** 1-based. */
  line: number;
  enabled: boolean;
  /** The file no longer exists: the breakpoint is kept (greyed) but never sent to a debugger. */
  stale: boolean;
}

export interface BreakpointState {
  breakpoints: readonly Breakpoint[];
}

/** How long after the last change the breakpoints are written to the database. */
export const SAVE_DELAY_MS = 300;

/**
 * The breakpoints of every file: toggled from the editor gutter or a command, kept in SQLite (so
 * they survive a relaunch), pushed to the debug adapter while a session runs, and marked stale
 * when their file is gone. File-specific by absolute path.
 */
export class BreakpointService {
  private state: BreakpointState = { breakpoints: [] };
  private readonly listeners = new Set<() => void>();
  private nextId = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ipc: IpcClient,
    /** Whether a debug session is running (so changes reach the adapter at once). */
    private readonly isDebugging: () => boolean = () => false,
  ) {}

  getState(): BreakpointState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Loads the saved breakpoints and marks the ones whose file is gone. */
  async initialize(): Promise<void> {
    let rows: BreakpointRow[];
    try {
      rows = await this.ipc.breakpointsLoad();
    } catch {
      return;
    }
    const missing = new Set<string>();
    for (const path of new Set(rows.map((row) => pathKey(row.filePath)))) {
      const original = rows.find((row) => pathKey(row.filePath) === path)?.filePath;
      if (original === undefined) continue;
      try {
        await this.ipc.fsMetadata(original);
      } catch {
        missing.add(path);
      }
    }
    this.state = {
      breakpoints: rows.map((row) => ({
        id: this.newId(),
        path: row.filePath,
        line: row.line,
        enabled: row.enabled,
        stale: missing.has(pathKey(row.filePath)),
      })),
    };
    this.notify();
  }

  private newId(): string {
    this.nextId += 1;
    return `bp-${String(this.nextId)}`;
  }

  forFile(path: string): Breakpoint[] {
    const key = pathKey(path);
    return this.state.breakpoints
      .filter((bp) => pathKey(bp.path) === key)
      .sort((a, b) => a.line - b.line);
  }

  at(path: string, line: number): Breakpoint | undefined {
    return this.forFile(path).find((bp) => bp.line === line);
  }

  /** The lines the adapter should stop at for a file: enabled ones of a file that exists. */
  activeLines(path: string): number[] {
    return this.forFile(path)
      .filter((bp) => bp.enabled && !bp.stale)
      .map((bp) => bp.line);
  }

  /** Every breakpoint an adapter may get, as rows. */
  activeRows(): BreakpointRow[] {
    return this.state.breakpoints
      .filter((bp) => bp.enabled && !bp.stale)
      .map((bp) => ({ filePath: bp.path, line: bp.line, enabled: true }));
  }

  /** Adds a breakpoint at `path:line`, or removes it when there already is one. Returns whether one exists now. */
  toggle(path: string, line: number): boolean {
    const existing = this.at(path, line);
    if (existing) {
      this.commit(
        this.state.breakpoints.filter((bp) => bp.id !== existing.id),
        [path],
      );
      return false;
    }
    this.commit(
      [...this.state.breakpoints, { id: this.newId(), path, line, enabled: true, stale: false }],
      [path],
    );
    return true;
  }

  remove(id: string): void {
    const found = this.state.breakpoints.find((bp) => bp.id === id);
    if (!found) return;
    this.commit(
      this.state.breakpoints.filter((bp) => bp.id !== id),
      [found.path],
    );
  }

  setEnabled(id: string, enabled: boolean): void {
    const found = this.state.breakpoints.find((bp) => bp.id === id);
    if (!found || found.enabled === enabled) return;
    this.commit(
      this.state.breakpoints.map((bp) => (bp.id === id ? { ...bp, enabled } : bp)),
      [found.path],
    );
  }

  setAllEnabled(enabled: boolean): void {
    this.commit(
      this.state.breakpoints.map((bp) => ({ ...bp, enabled })),
      this.paths(),
    );
  }

  removeAll(): void {
    const paths = this.paths();
    this.commit([], paths);
  }

  /** Breakpoints followed an edit: their lines moved (from the editor's tracked decorations). */
  moveLines(moves: { id: string; line: number }[]): void {
    const byId = new Map(moves.map((move) => [move.id, move.line]));
    const changed = this.state.breakpoints.filter(
      (bp) => byId.has(bp.id) && byId.get(bp.id) !== bp.line,
    );
    if (changed.length === 0) return;
    this.commit(
      this.state.breakpoints.map((bp) => ({ ...bp, line: byId.get(bp.id) ?? bp.line })),
      [...new Set(changed.map((bp) => bp.path))],
    );
  }

  private paths(): string[] {
    return [...new Set(this.state.breakpoints.map((bp) => bp.path))];
  }

  private commit(next: Breakpoint[], changedPaths: string[]): void {
    this.state = { breakpoints: next };
    this.notify();
    this.scheduleSave();
    if (this.isDebugging()) {
      for (const path of changedPaths) {
        void this.ipc.debugSetBreakpoints(path, this.activeLines(path)).catch(() => undefined);
      }
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, SAVE_DELAY_MS);
  }

  /** Writes every breakpoint (stale ones too — the file may come back) to the database. */
  async saveNow(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const rows: BreakpointRow[] = this.state.breakpoints.map((bp) => ({
      filePath: bp.path,
      line: bp.line,
      enabled: bp.enabled,
    }));
    await this.ipc.breakpointsSave(rows).catch(() => undefined);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
