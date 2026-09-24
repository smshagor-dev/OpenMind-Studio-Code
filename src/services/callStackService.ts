import { parseFrames, type DebugFrame } from "./debugModel";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient } from "./ipc";

export interface CallStackState {
  frames: readonly DebugFrame[];
  selectedId: number | null;
}

/** Where the program is paused, for the editor's current-line marker. */
export interface DebugLocation {
  path: string;
  line: number;
  column: number;
}

/**
 * The call stack of the paused program. Pausing reads the stack of the paused thread and selects
 * the first frame that is a file the editor can open; selecting a frame (click) opens that file
 * at the frame's line and tells the variables and watches to show that frame. Resuming clears it.
 */
export class CallStackService {
  private state: CallStackState = { frames: [], selectedId: null };
  private readonly listeners = new Set<() => void>();
  private offs: (() => void)[] = [];

  constructor(
    private readonly ipc: IpcClient,
    private readonly events: EventBus<AppEvents>,
    /** Opens `path` in the editor at a position (1-based). */
    private readonly reveal: (path: string, line: number, column: number) => void,
  ) {}

  getState(): CallStackState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  initialize(): void {
    this.dispose();
    this.offs.push(
      this.events.on("debugPaused", ({ threadId }) => {
        void this.load(threadId);
      }),
      this.events.on("debugResumed", () => {
        this.clear();
      }),
    );
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
  }

  selected(): DebugFrame | null {
    return this.state.frames.find((frame) => frame.id === this.state.selectedId) ?? null;
  }

  /** The selected frame's place in a file, if it has one. */
  location(): DebugLocation | null {
    const frame = this.selected();
    return frame?.path ? { path: frame.path, line: frame.line, column: frame.column } : null;
  }

  async load(threadId: number): Promise<void> {
    let frames: DebugFrame[];
    try {
      frames = parseFrames(
        await this.ipc.debugRequest("stackTrace", { threadId, startFrame: 0, levels: 50 }),
      );
    } catch (error) {
      this.events.emit("appError", { message: `Couldn't read the call stack: ${String(error)}` });
      return;
    }
    const first = frames.find((frame) => frame.path !== null) ?? frames[0] ?? null;
    this.state = { frames, selectedId: first?.id ?? null };
    this.notify();
    if (first) this.pick(first, true);
  }

  /** A click on a frame. */
  select(frame: DebugFrame): void {
    this.state = { ...this.state, selectedId: frame.id };
    this.notify();
    this.pick(frame, true);
  }

  private pick(frame: DebugFrame, reveal: boolean): void {
    this.events.emit("debugFrameSelected", frame);
    if (reveal && frame.path !== null) this.reveal(frame.path, frame.line, frame.column);
  }

  private clear(): void {
    if (this.state.frames.length === 0 && this.state.selectedId === null) return;
    this.state = { frames: [], selectedId: null };
    this.notify();
    this.events.emit("debugFrameSelected", null);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
