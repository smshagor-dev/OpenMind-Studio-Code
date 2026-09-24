import type { ConsoleKind, Evaluated } from "./debugModel";

export interface ConsoleLine {
  id: number;
  kind: ConsoleKind;
  text: string;
}

export interface ConsoleState {
  lines: readonly ConsoleLine[];
}

/** A console keeps this many lines; older ones fall off so a chatty program can't grow memory without bound. */
export const MAX_CONSOLE_LINES = 5000;

export const NOT_PAUSED_MESSAGE =
  "Expressions can only be evaluated while the program is paused at a breakpoint.";

/**
 * The Debug Console: the program's output (stdout/stderr), the adapter's messages, and an
 * evaluate prompt. Evaluating goes to the paused program through the debug adapter; when the
 * program isn't paused, or the adapter refuses, the console says so instead of pretending.
 */
export class DebugConsoleService {
  private state: ConsoleState = { lines: [] };
  private readonly listeners = new Set<() => void>();
  private nextId = 0;

  constructor(
    private readonly evaluator: (expression: string) => Promise<Evaluated>,
    /** Why an expression can't be evaluated right now, or `null` when it can. */
    private readonly unavailableReason: () => string | null,
  ) {}

  getState(): ConsoleState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  append(kind: ConsoleKind, text: string): void {
    const added = text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line): ConsoleLine => ({ id: (this.nextId += 1), kind, text: line }));
    const lines = [...this.state.lines, ...added];
    this.state = {
      lines: lines.length > MAX_CONSOLE_LINES ? lines.slice(-MAX_CONSOLE_LINES) : lines,
    };
    this.notify();
  }

  clear(): void {
    if (this.state.lines.length === 0) return;
    this.state = { lines: [] };
    this.notify();
  }

  /** Evaluates `expression` in the paused program and prints the answer (or why there is none). */
  async evaluate(expression: string): Promise<boolean> {
    const text = expression.trim();
    if (text === "") return false;
    this.append("input", `> ${text}`);
    const reason = this.unavailableReason();
    if (reason !== null) {
      this.append("error", reason);
      return false;
    }
    try {
      const result = await this.evaluator(text);
      this.append("result", result.result);
      return true;
    } catch (error) {
      this.append("error", error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
