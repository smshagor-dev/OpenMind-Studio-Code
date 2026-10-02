/** Where the arguments are kept (`editor_settings`, one JSON object: file path -> argument text). */
export const RUN_ARGUMENTS_KEY = "run.arguments";

/** Arguments are remembered for this many files at most (the oldest are dropped). */
const MAX_FILES = 200;

export interface RunArgumentsStore {
  settingsGet: (key: string) => Promise<string | null>;
  settingsSet: (key: string, value: string) => Promise<void>;
}

/**
 * Command-line arguments Run Code passes to a program, remembered per file across restarts. The text is kept as
 * typed (`7 "two words"`); the backend splits it like a shell would, without ever running a shell. UI-free.
 */
export class RunArgumentsService {
  private byFile = new Map<string, string>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly store: RunArgumentsStore) {}

  async load(): Promise<void> {
    try {
      const raw = await this.store.settingsGet(RUN_ARGUMENTS_KEY);
      const parsed: unknown = raw === null ? {} : JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.byFile = new Map(
          Object.entries(parsed as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "",
          ),
        );
      }
    } catch {
      // A damaged value means no remembered arguments; it is replaced on the next change.
      this.byFile = new Map();
    }
    this.notify();
  }

  /** The arguments for `path` (`""` when none). */
  get(path: string): string {
    return this.byFile.get(path) ?? "";
  }

  /** Remembers `text` for `path`; blank text forgets it. */
  async set(path: string, text: string): Promise<void> {
    const value = text.trim();
    this.byFile.delete(path);
    if (value !== "") this.byFile.set(path, value);
    while (this.byFile.size > MAX_FILES) {
      const oldest = this.byFile.keys().next().value;
      if (oldest === undefined) break;
      this.byFile.delete(oldest);
    }
    this.notify();
    await this.store.settingsSet(RUN_ARGUMENTS_KEY, JSON.stringify(Object.fromEntries(this.byFile)));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
