import type { HistorySummary } from "./agentHistory";

/** The settings key holding the starred conversation ids (one list for the app, like the history itself). */
export const STARRED_KEY = "agent.starred";
const MAX_STARRED = 500;

/** The starred ids stored in `raw` (invalid entries and duplicates dropped). */
export function parseStarred(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const ids = value.filter(
      (id): id is string => typeof id === "string" && id.length > 0 && id.length <= 100,
    );
    return [...new Set(ids)].slice(0, MAX_STARRED);
  } catch {
    return [];
  }
}

/** The history split like claude.ai's: starred conversations first, the rest below, each newest first. */
export function splitHistory(
  items: readonly HistorySummary[],
  starred: readonly string[],
): { starred: HistorySummary[]; recent: HistorySummary[] } {
  const marked = new Set(starred);
  const newest = [...items].sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    starred: newest.filter((item) => marked.has(item.id)),
    recent: newest.filter((item) => !marked.has(item.id)),
  };
}

/** Starred agent conversations, kept in the app's settings store. */
export class StarredChats {
  private ids: string[] = [];
  private version = 0;
  private loading: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly read: (key: string) => Promise<string | null>,
    private readonly write: (key: string, value: string) => Promise<void>,
  ) {}

  /** Reads the saved list once; later calls share the first read. */
  load(): Promise<void> {
    this.loading ??= this.read(STARRED_KEY)
      .then((raw) => {
        // A star given before the read finished is kept.
        this.ids = [...new Set([...parseStarred(raw), ...this.ids])];
        this.changed(false);
      })
      .catch(() => undefined);
    return this.loading;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    void this.load();
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Changes whenever the list does (for `useSyncExternalStore`). */
  getVersion(): number {
    return this.version;
  }

  list(): readonly string[] {
    return this.ids;
  }

  has(id: string): boolean {
    return this.ids.includes(id);
  }

  /** Stars or unstars a conversation. Returns whether it is starred now. */
  toggle(id: string): boolean {
    if (this.has(id)) {
      this.ids = this.ids.filter((item) => item !== id);
      this.changed(true);
      return false;
    }
    if (this.ids.length >= MAX_STARRED) return false;
    this.ids = [...this.ids, id];
    this.changed(true);
    return true;
  }

  /** A deleted conversation loses its star. */
  remove(id: string): void {
    if (!this.has(id)) return;
    this.ids = this.ids.filter((item) => item !== id);
    this.changed(true);
  }

  private changed(save: boolean): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
    // A save waits for the first read, so a star given before it can't overwrite the stars saved earlier.
    if (save)
      void this.load()
        .then(() => this.write(STARRED_KEY, JSON.stringify(this.ids)))
        .catch(() => undefined);
  }
}
