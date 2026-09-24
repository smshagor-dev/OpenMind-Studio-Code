/** The channels that always exist, in the order the Output panel lists them. */
export const INITIAL_OUTPUT_CHANNELS = [
  "OpenMind Studio",
  "Runtime Manager",
  "Terminal",
  "Search",
  "Run Code",
  "Git",
  "LSP",
] as const;

/** A channel keeps this many lines; older ones fall off so a chatty service can't grow memory without bound. */
export const MAX_OUTPUT_LINES = 5000;

export interface OutputState {
  /** Every channel name, in creation order. */
  channels: readonly string[];
  selected: string;
}

/**
 * Named output channels — the app's own log/output surface (VS Code's Output
 * panel). Services append lines to a channel by name; the panel shows the
 * selected one. Channels are in-memory only: this is a live log, not a store.
 * Any service can create a channel on first use (`append` to a new name).
 */
export class OutputService {
  private readonly lines = new Map<string, readonly string[]>();
  private state: OutputState;
  private readonly listeners = new Set<() => void>();
  private readonly appendListeners = new Set<(channel: string, line: string) => void>();

  constructor(channels: readonly string[] = INITIAL_OUTPUT_CHANNELS) {
    for (const name of channels) {
      this.lines.set(name, []);
    }
    this.state = { channels: [...this.lines.keys()], selected: channels[0] ?? "" };
  }

  getState(): OutputState {
    return this.state;
  }

  /** The lines of `channel` — a new array whenever it changes, so it works with `useSyncExternalStore`. */
  getLines(channel: string): readonly string[] {
    return this.lines.get(channel) ?? [];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Hears every appended line as it arrives (channel, line) — for views that merge channels. */
  onAppend(listener: (channel: string, line: string) => void): () => void {
    this.appendListeners.add(listener);
    return () => {
      this.appendListeners.delete(listener);
    };
  }

  /** Creates `channel` if it doesn't exist yet. Returns whether it was created. */
  ensureChannel(channel: string): boolean {
    if (this.lines.has(channel)) {
      return false;
    }
    this.lines.set(channel, []);
    this.state = {
      ...this.state,
      channels: [...this.state.channels, channel],
      selected: this.state.selected === "" ? channel : this.state.selected,
    };
    return true;
  }

  /** Appends one line (or several, if `text` contains newlines) to `channel`. */
  append(channel: string, text: string): void {
    this.ensureChannel(channel);
    const added = text.replace(/\r\n?/g, "\n").split("\n");
    if (added.length > 1 && added[added.length - 1] === "") {
      added.pop();
    }
    const merged = [...(this.lines.get(channel) ?? []), ...added];
    this.lines.set(
      channel,
      merged.length > MAX_OUTPUT_LINES ? merged.slice(-MAX_OUTPUT_LINES) : merged,
    );
    for (const line of added) {
      for (const listener of this.appendListeners) listener(channel, line);
    }
    this.notify();
  }

  clear(channel: string): void {
    if ((this.lines.get(channel)?.length ?? 0) === 0) {
      return;
    }
    this.lines.set(channel, []);
    this.notify();
  }

  select(channel: string): void {
    if (this.lines.has(channel) && this.state.selected !== channel) {
      this.state = { ...this.state, selected: channel };
      this.notify();
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/** `[HH:MM:SS] message` — the timestamped line format services use for their log lines. */
export function stamped(message: string, now: Date = new Date()): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return `[${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}] ${message}`;
}
