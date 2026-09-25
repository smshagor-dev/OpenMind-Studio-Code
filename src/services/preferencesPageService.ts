import type { SettingsScope } from "./ipc";

export type PreferencesTab = "settings" | "keybindings";

export interface PreferencesPageState {
  open: boolean;
  tab: PreferencesTab;
  /** The search box (settings or shortcuts, per tab). */
  query: string;
  scope: SettingsScope;
  /** The category picked in the settings list (`null`: all of them). */
  category: string | null;
}

const CLOSED: PreferencesPageState = {
  open: false,
  tab: "settings",
  query: "",
  scope: "user",
  category: null,
};

/**
 * Whether the Settings / Keyboard Shortcuts page is showing over the editor area, and what it
 * shows. Pure UI state: the settings and shortcuts themselves belong to `SettingsService` and
 * `KeybindingsManager`.
 */
export class PreferencesPageService {
  private state: PreferencesPageState = CLOSED;
  private readonly listeners = new Set<() => void>();

  getState(): PreferencesPageState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  open(tab: PreferencesTab, options: { scope?: SettingsScope; query?: string } = {}): void {
    this.update({
      open: true,
      tab,
      scope: options.scope ?? (tab === "settings" ? this.state.scope : "user"),
      query: options.query ?? "",
      category: null,
    });
  }

  close(): void {
    this.update({ open: false });
  }

  setTab(tab: PreferencesTab): void {
    this.update({ tab, query: "", category: null });
  }

  setQuery(query: string): void {
    this.update({ query });
  }

  setScope(scope: SettingsScope): void {
    this.update({ scope });
  }

  setCategory(category: string | null): void {
    this.update({ category });
  }

  private update(patch: Partial<PreferencesPageState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
