import { parseEvaluate, type DebugFrame } from "./debugModel";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient } from "./ipc";

export interface WatchEntry {
  id: number;
  expression: string;
  /** The value read while paused; `null` when the program isn't paused. */
  value: string | null;
  /** The adapter's complaint about the expression (an undefined name, ...). */
  error: string | null;
}

export interface WatchState {
  entries: readonly WatchEntry[];
}

const SETTINGS_KEY = "debug.watch";

/**
 * Watch expressions: kept across launches, and evaluated in the selected stack frame every time
 * the program pauses or another frame is chosen. While the program runs they show no value —
 * the last one would be a lie.
 */
export class WatchService {
  private state: WatchState = { entries: [] };
  private readonly listeners = new Set<() => void>();
  private offs: (() => void)[] = [];
  private nextId = 0;
  private frame: DebugFrame | null = null;
  private generation = 0;

  constructor(
    private readonly ipc: IpcClient,
    private readonly events: EventBus<AppEvents>,
  ) {}

  getState(): WatchState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async initialize(): Promise<void> {
    this.dispose();
    try {
      const saved = await this.ipc.settingsGet(SETTINGS_KEY);
      const list: unknown = saved === null ? [] : JSON.parse(saved);
      if (Array.isArray(list)) {
        this.state = {
          entries: (list as unknown[])
            .filter((item): item is string => typeof item === "string" && item.trim() !== "")
            .map((expression) => this.entry(expression)),
        };
        this.notify();
      }
    } catch {
      // A missing or corrupt saved list just means no watches.
    }
    this.offs.push(
      this.events.on("debugFrameSelected", (frame) => {
        this.frame = frame;
        void this.refresh();
      }),
    );
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
  }

  private entry(expression: string): WatchEntry {
    this.nextId += 1;
    return { id: this.nextId, expression, value: null, error: null };
  }

  add(expression: string): void {
    const text = expression.trim();
    if (text === "" || this.state.entries.some((entry) => entry.expression === text)) return;
    this.state = { entries: [...this.state.entries, this.entry(text)] };
    this.persist();
    this.notify();
    void this.refresh();
  }

  remove(id: number): void {
    this.state = { entries: this.state.entries.filter((entry) => entry.id !== id) };
    this.persist();
    this.notify();
  }

  /** Evaluates every watch in the selected frame (or clears the values when there is none). */
  async refresh(): Promise<void> {
    const generation = (this.generation += 1);
    const frame = this.frame;
    if (frame === null) {
      this.state = {
        entries: this.state.entries.map((entry) => ({ ...entry, value: null, error: null })),
      };
      this.notify();
      return;
    }
    const results = await Promise.all(
      this.state.entries.map(async (entry): Promise<WatchEntry> => {
        try {
          const body = await this.ipc.debugRequest("evaluate", {
            expression: entry.expression,
            frameId: frame.id,
            context: "watch",
          });
          return { ...entry, value: parseEvaluate(body).result, error: null };
        } catch (error) {
          return {
            ...entry,
            value: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    if (generation !== this.generation) return;
    // Keep entries added or removed while the answers were on their way.
    this.state = {
      entries: this.state.entries.flatMap((entry) => {
        const answer = results.find((result) => result.id === entry.id);
        return answer ? [answer] : [entry];
      }),
    };
    this.notify();
  }

  private persist(): void {
    const list = this.state.entries.map((entry) => entry.expression);
    void this.ipc.settingsSet(SETTINGS_KEY, JSON.stringify(list)).catch(() => undefined);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
