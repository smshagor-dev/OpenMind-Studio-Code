import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { filterExtensions } from "./extensionModel";
import type {
  ExtensionActivity,
  ExtensionsSnapshot,
  InstalledExtension,
} from "./extensionsIpc";
import type { CanonicalFeed } from "./state/canonicalStateService";

export interface ExtensionRegistryState {
  /** `null` until the first answer from the backend. */
  snapshot: ExtensionsSnapshot | null;
  /** The search-installed text. */
  query: string;
  error: string | null;
}

const NO_ACTIVITY: ExtensionActivity = {
  active: false,
  lastError: null,
  activationCount: 0,
  lastActivation: null,
};

/**
 * What is installed: the backend's list of extensions (the folders under `extensions/`), with what each
 * has done in the host, and the search box over it. UI-free; `ExtensionService` changes things, this only
 * follows the canonical `extensions` state.
 */
export class ExtensionRegistryService {
  private state: ExtensionRegistryState = { snapshot: null, query: "", error: null };
  private readonly listeners = new Set<() => void>();
  private offs: (() => void)[] = [];
  /** The canonical extension list (`src/services/state`), once the backend has it. */
  private canonical: CanonicalFeed<ExtensionsSnapshot> | null = null;

  constructor(private readonly events: EventBus<AppEvents>) {}

  getState(): ExtensionRegistryState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The list arrives from the canonical state (`useCanonical`); this waits until the backend has read it once. */
  async initialize(): Promise<void> {
    await this.ensureLoaded();
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
  }

  /**
   * Follows the backend's canonical extension list (installs, enable/disable, removal — also folders copied in or
   * deleted by hand — and host activity): every window gets the same list once per change. Returns the way to stop.
   */
  useCanonical(feed: CanonicalFeed<ExtensionsSnapshot>): () => void {
    this.canonical = feed;
    const off = feed.subscribe((snapshot) => {
      this.applySnapshot(snapshot);
    });
    const current = feed.current();
    if (current !== undefined) this.applySnapshot(current);
    return () => {
      off();
      this.canonical = null;
    };
  }

  /** Waits until this window has every extension change the backend made so far. */
  async refresh(): Promise<void> {
    await this.canonical?.catchUp();
  }

  private applySnapshot(snapshot: ExtensionsSnapshot): void {
    this.state = { ...this.state, snapshot, error: null };
    this.notify();
    this.events.emit("extensionsChanged", undefined);
  }

  /** Waits for the first list (start-up: the backend reads it in the background); returns at once afterwards. */
  async ensureLoaded(): Promise<void> {
    if (this.state.snapshot === null) await this.canonical?.ready();
  }

  setQuery(query: string): void {
    this.state = { ...this.state, query };
    this.notify();
  }

  all(): InstalledExtension[] {
    return this.state.snapshot?.extensions ?? [];
  }

  enabled(): InstalledExtension[] {
    return this.all().filter((extension) => extension.enabled);
  }

  /** The installed extensions matching the search text. */
  visible(): InstalledExtension[] {
    return filterExtensions(this.all(), this.state.query);
  }

  find(id: string): InstalledExtension | undefined {
    return this.all().find((extension) => extension.id === id);
  }

  activityOf(id: string): ExtensionActivity {
    return this.state.snapshot?.activity[id] ?? NO_ACTIVITY;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
