import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { filterExtensions } from "./extensionModel";
import type {
  ExtensionActivity,
  ExtensionsSnapshot,
  InstalledExtension,
} from "./extensionsIpc";
import type { IpcClient } from "./ipc";

export interface ExtensionRegistryState {
  /** `null` until the first answer from the backend. */
  snapshot: ExtensionsSnapshot | null;
  /** The search-installed text. */
  query: string;
  error: string | null;
}

const NO_ACTIVITY: ExtensionActivity = { active: false, lastError: null };

/**
 * What is installed: the backend's list of extensions (the folders under `extensions/`), with what each
 * has done in the host, and the search box over it. UI-free; `ExtensionService` changes things, this only
 * reads and follows `ext:changed`.
 */
export class ExtensionRegistryService {
  private state: ExtensionRegistryState = { snapshot: null, query: "", error: null };
  private readonly listeners = new Set<() => void>();
  private offs: (() => void)[] = [];

  constructor(
    private readonly ipc: IpcClient,
    private readonly events: EventBus<AppEvents>,
  ) {}

  getState(): ExtensionRegistryState {
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
      this.offs.push(
        await this.ipc.onExtChanged(() => {
          void this.refresh();
        }),
      );
    } catch (error) {
      this.events.emit("appError", { message: `Extensions unavailable: ${String(error)}` });
    }
    await this.refresh();
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
  }

  async refresh(): Promise<void> {
    try {
      this.state = { ...this.state, snapshot: await this.ipc.extList(), error: null };
    } catch (error) {
      this.state = { ...this.state, error: `Couldn't read the extensions: ${String(error)}` };
    }
    this.notify();
    this.events.emit("extensionsChanged", undefined);
  }

  /** Reads the list once (a second call returns at once). */
  async ensureLoaded(): Promise<void> {
    if (this.state.snapshot === null) await this.refresh();
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
