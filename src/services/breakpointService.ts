import type { BreakpointRow, IpcClient } from "./ipc";
import { pathKey } from "./textSync";
import type { SourceBreakpoint } from "./workflowIpc";

/** A breakpoint's extras: stop only when a condition holds or on a hit count, or log instead of stopping. */
export interface BreakpointOptions {
  condition: string | null;
  hitCondition: string | null;
  logMessage: string | null;
}

export interface Breakpoint {
  id: string;
  path: string;
  /** 1-based. */
  line: number;
  enabled: boolean;
  /** The file no longer exists: the breakpoint is kept (greyed) but never sent to a debugger. */
  stale: boolean;
  condition: string | null;
  hitCondition: string | null;
  /** A logpoint: the message is printed instead of stopping. */
  logMessage: string | null;
}

const NO_OPTIONS: BreakpointOptions = { condition: null, hitCondition: null, logMessage: null };

function clean(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text === "" ? null : text;
}

/** A breakpoint as stored / sent: the extras only when they are set. */
function rowOf(bp: Breakpoint, enabled: boolean): BreakpointRow {
  return {
    filePath: bp.path,
    line: bp.line,
    enabled,
    ...(bp.condition !== null ? { condition: bp.condition } : {}),
    ...(bp.hitCondition !== null ? { hitCondition: bp.hitCondition } : {}),
    ...(bp.logMessage !== null ? { logMessage: bp.logMessage } : {}),
  };
}

export interface BreakpointState {
  breakpoints: readonly Breakpoint[];
  /** The breakpoint whose condition / log message form is open in the Breakpoints pane. */
  editing?: string | null;
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
        condition: clean(row.condition),
        hitCondition: clean(row.hitCondition),
        logMessage: clean(row.logMessage),
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

  /** What the adapter gets for a file: its enabled breakpoints with their conditions and log messages. */
  activeSource(path: string): SourceBreakpoint[] {
    return this.forFile(path)
      .filter((bp) => bp.enabled && !bp.stale)
      .map((bp) => ({
        line: bp.line,
        ...(bp.condition !== null ? { condition: bp.condition } : {}),
        ...(bp.hitCondition !== null ? { hitCondition: bp.hitCondition } : {}),
        ...(bp.logMessage !== null ? { logMessage: bp.logMessage } : {}),
      }));
  }

  /** Every breakpoint an adapter may get, as rows. */
  activeRows(): BreakpointRow[] {
    return this.state.breakpoints
      .filter((bp) => bp.enabled && !bp.stale)
      .map((bp) => rowOf(bp, true));
  }

  /** Sets (or clears, with empty text) a breakpoint's condition, hit count and log message. */
  setOptions(id: string, options: Partial<BreakpointOptions>): void {
    const found = this.state.breakpoints.find((bp) => bp.id === id);
    if (!found) return;
    const next = {
      condition: "condition" in options ? clean(options.condition) : found.condition,
      hitCondition: "hitCondition" in options ? clean(options.hitCondition) : found.hitCondition,
      logMessage: "logMessage" in options ? clean(options.logMessage) : found.logMessage,
    };
    this.commit(
      this.state.breakpoints.map((bp) => (bp.id === id ? { ...bp, ...next } : bp)),
      [found.path],
    );
  }

  /** Opens the edit form of a breakpoint (the Breakpoints pane shows it). */
  startEditing(id: string): void {
    if (!this.state.breakpoints.some((bp) => bp.id === id)) return;
    this.state = { ...this.state, editing: id };
    this.notify();
  }

  stopEditing(): void {
    if (!this.state.editing) return;
    this.state = { ...this.state, editing: null };
    this.notify();
  }

  /** A breakpoint at `path:line` with its edit form open (made when there is none): "Add Conditional Breakpoint". */
  editAt(path: string, line: number): void {
    if (!this.at(path, line)) this.toggle(path, line);
    const found = this.at(path, line);
    if (found) this.startEditing(found.id);
  }

  /** Whether any enabled breakpoint uses a condition, hit count or log message (the adapter must support them). */
  usesOptions(): { condition: boolean; hitCondition: boolean; logMessage: boolean } {
    const active = this.state.breakpoints.filter((bp) => bp.enabled && !bp.stale);
    return {
      condition: active.some((bp) => bp.condition !== null),
      hitCondition: active.some((bp) => bp.hitCondition !== null),
      logMessage: active.some((bp) => bp.logMessage !== null),
    };
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
      [
        ...this.state.breakpoints,
        { id: this.newId(), path, line, enabled: true, stale: false, ...NO_OPTIONS },
      ],
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
    const editing = next.some((bp) => bp.id === this.state.editing) ? this.state.editing : null;
    this.state = { breakpoints: next, editing };
    this.notify();
    this.scheduleSave();
    if (this.isDebugging()) {
      for (const path of changedPaths) {
        void this.ipc.debugSetBreakpoints(path, this.activeSource(path)).catch(() => undefined);
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
    const rows: BreakpointRow[] = this.state.breakpoints.map((bp) => rowOf(bp, bp.enabled));
    await this.ipc.breakpointsSave(rows).catch(() => undefined);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** What a breakpoint does besides stopping, in a few words ("if x > 1 · hit 3 · logs "x={x}""). */
export function breakpointSummary(bp: Breakpoint): string {
  return [
    bp.condition !== null ? `if ${bp.condition}` : null,
    bp.hitCondition !== null ? `hit ${bp.hitCondition}` : null,
    bp.logMessage !== null ? `logs "${bp.logMessage}"` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}
