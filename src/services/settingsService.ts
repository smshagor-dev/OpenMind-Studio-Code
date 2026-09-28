import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type {
  IpcClient,
  PreferencesSnapshot,
  SettingDefinition,
  SettingSource,
  SettingsIssue,
  SettingsScope,
  SettingValue,
} from "./ipc";
import { categoryLabel, settingDescription, settingTitle } from "../i18n/settingsText";

export interface SettingsState {
  snapshot: PreferencesSnapshot | null;
  /** Why the settings couldn't be read (the backend is unreachable); the defaults apply meanwhile. */
  loadError: string | null;
}

export interface CategoryGroup {
  category: string;
  settings: SettingDefinition[];
}

export type SetResult = { ok: true } | { ok: false; error: string };

export interface ScopeAvailability {
  enabled: boolean;
  reason?: string;
}

/**
 * The app's settings: the backend's layered view (default < user file < workspace file) and the
 * changes made to it. Other services never read the files — they ask `bool`/`number`/`string` and
 * subscribe with `onChange`, so a setting takes effect the moment it is saved, whether it was
 * changed in the Settings page, in the JSON file, or by a different window. UI-free.
 */
export class SettingsService {
  private state: SettingsState = { snapshot: null, loadError: null };
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly ipc: IpcClient,
    private readonly events: EventBus<AppEvents>,
  ) {}

  getState(): SettingsState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Runs `handler` when the effective value of any of `ids` changed (not for unrelated settings). */
  onChange(ids: string[], handler: () => void): () => void {
    return this.events.on("settingsChanged", (event) => {
      if (event.ids.some((id) => ids.includes(id))) handler();
    });
  }

  async initialize(): Promise<void> {
    await this.reload();
  }

  /** Loads the settings once; later calls return at once (a second window's startup asks too). */
  async ensureLoaded(): Promise<void> {
    if (this.state.snapshot === null) await this.reload();
  }

  /** Re-reads both files; anything whose effective value changed is announced. */
  async reload(): Promise<void> {
    try {
      this.apply(await this.ipc.preferencesLoad());
    } catch (error) {
      this.state = {
        ...this.state,
        loadError: error instanceof Error ? error.message : String(error),
      };
      this.notify();
    }
  }

  private apply(read: PreferencesSnapshot): void {
    const before = this.state.snapshot;
    // A file with a syntax error (usually half-typed in the JSON editor) keeps the last good values in force,
    // so the theme or the font doesn't flip back to the defaults while it is being edited; the error is shown.
    const broken = read.userError !== null || read.workspaceError !== null;
    const next = broken && before !== null ? { ...read, values: before.values } : read;
    const changed: string[] = [];
    for (const entry of next.values) {
      const previous = before?.values.find((candidate) => candidate.id === entry.id);
      if (previous === undefined ? true : previous.value !== entry.value) changed.push(entry.id);
    }
    this.state = { snapshot: next, loadError: null };
    this.notify();
    if (changed.length > 0) this.events.emit("settingsChanged", { ids: changed });
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  definition(id: string): SettingDefinition | undefined {
    return this.state.snapshot?.definitions.find((def) => def.id === id);
  }

  /** Every setting's effective value by id (what extensions read with `getConfiguration`). */
  values(): Record<string, SettingValue> {
    const all: Record<string, SettingValue> = {};
    for (const entry of this.state.snapshot?.values ?? []) all[entry.id] = entry.value;
    return all;
  }

  /** The effective value, or `fallback` while settings aren't loaded yet. */
  private raw(id: string): SettingValue | undefined {
    return this.state.snapshot?.values.find((entry) => entry.id === id)?.value;
  }

  bool(id: string, fallback: boolean): boolean {
    const value = this.raw(id);
    return typeof value === "boolean" ? value : fallback;
  }

  number(id: string, fallback: number): number {
    const value = this.raw(id);
    return typeof value === "number" ? value : fallback;
  }

  string(id: string, fallback: string): string {
    const value = this.raw(id);
    return typeof value === "string" ? value : fallback;
  }

  sourceOf(id: string): SettingSource {
    return this.state.snapshot?.values.find((entry) => entry.id === id)?.source ?? "default";
  }

  /** Whether the file of `scope` sets `id` (so "Reset" has something to remove). */
  isSetIn(scope: SettingsScope, id: string): boolean {
    const snapshot = this.state.snapshot;
    if (snapshot === null) return false;
    return (scope === "user" ? snapshot.userSet : snapshot.workspaceSet).includes(id);
  }

  workspaceAvailability(): ScopeAvailability {
    if (this.state.snapshot?.workspace == null) {
      return { enabled: false, reason: "Open a folder to use workspace settings." };
    }
    return { enabled: true };
  }

  /** Why `id` can't be set in `scope`, if it can't. */
  scopeAvailability(scope: SettingsScope, id: string): ScopeAvailability {
    if (scope === "workspace") {
      const workspace = this.workspaceAvailability();
      if (!workspace.enabled) return workspace;
      if (this.definition(id)?.scope === "user") {
        return { enabled: false, reason: "This setting only exists for the whole app." };
      }
    }
    return { enabled: true };
  }

  /** Saves a value into the file of `scope`; the backend's validation message is returned as is. */
  async set(scope: SettingsScope, id: string, value: SettingValue): Promise<SetResult> {
    const allowed = this.scopeAvailability(scope, id);
    if (!allowed.enabled) return { ok: false, error: allowed.reason ?? "Not available." };
    try {
      this.apply(await this.ipc.preferencesSet(scope, id, value));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Saves into the file the current value comes from (the workspace's if it overrides), so a toggle always shows. */
  setEffective(id: string, value: SettingValue): Promise<SetResult> {
    return this.set(this.sourceOf(id) === "workspace" ? "workspace" : "user", id, value);
  }

  async reset(scope: SettingsScope, id: string): Promise<SetResult> {
    try {
      this.apply(await this.ipc.preferencesReset(scope, id));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The settings that match `query` (every word must appear in the id, title, description or category), by category. */
  search(query: string): CategoryGroup[] {
    const snapshot = this.state.snapshot;
    if (snapshot === null) return [];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (def: SettingDefinition) => {
      // The English text and the UI language's text both match, so a search works in either.
      const text = [
        def.id,
        def.title,
        def.description,
        def.category,
        settingTitle(def),
        settingDescription(def),
        categoryLabel(def.category),
      ]
        .join(" ")
        .toLowerCase();
      return words.every((word) => text.includes(word));
    };
    return snapshot.categories
      .map((category) => ({
        category,
        settings: snapshot.definitions.filter((def) => def.category === category && matches(def)),
      }))
      .filter((group) => group.settings.length > 0);
  }

  /** The path of the file to open in the JSON editor (created empty if missing). */
  jsonFile(scope: SettingsScope): Promise<string> {
    return this.ipc.preferencesFile(scope);
  }

  /**
   * Called after any document is saved: if it was one of the settings files, reads them again
   * (so the change applies at once) and reports what is wrong with it.
   */
  async handleSaved(path: string, text: string): Promise<SettingsIssue[] | null> {
    const scope = await this.ipc.preferencesScopeOf(path).catch(() => null);
    if (scope !== "user" && scope !== "workspace") return null;
    const issues = await this.ipc.preferencesValidate(scope, text).catch(() => []);
    await this.reload();
    return issues;
  }
}
