import type { IpcClient, SettingValue } from "./ipc";

/** The setting (and, before settings existed, the `editor_settings` key): whether the Welcome page opens at start-up. */
export const WELCOME_ON_STARTUP_KEY = "workbench.welcomeOnStartup";

/** The slice of `SettingsService` the Welcome page needs. */
export interface WelcomeSettings {
  bool: (id: string, fallback: boolean) => boolean;
  isSetIn: (scope: "user", id: string) => boolean;
  set: (scope: "user", id: string, value: SettingValue) => Promise<unknown>;
}

export interface WelcomeState {
  /** The Welcome tab is shown (in the first group, while no file is open). */
  open: boolean;
  showOnStartup: boolean;
}

/**
 * VS Code's Welcome page as a closable tab: open on start-up unless the user
 * unticked "Show welcome page on startup", closed with its tab's ×, and opened
 * again from Help > Welcome. While it is closed an empty editor shows the
 * watermark instead.
 */
export class WelcomeService {
  private state: WelcomeState = { open: true, showOnStartup: true };
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly ipc: IpcClient,
    private readonly settings: WelcomeSettings | null = null,
  ) {}

  getState(): WelcomeState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async initialize(): Promise<void> {
    const legacy = await this.ipc.settingsGet(WELCOME_ON_STARTUP_KEY).catch(() => null);
    let showOnStartup = legacy !== "false";
    if (this.settings !== null) {
      // A choice made before settings existed moves into the settings file once.
      if (legacy === "false" && !this.settings.isSetIn("user", WELCOME_ON_STARTUP_KEY)) {
        await this.settings.set("user", WELCOME_ON_STARTUP_KEY, false);
      }
      showOnStartup = this.settings.bool(WELCOME_ON_STARTUP_KEY, true);
    }
    this.update({ showOnStartup, open: showOnStartup });
  }

  open(): void {
    this.update({ open: true });
  }

  close(): void {
    this.update({ open: false });
  }

  async setShowOnStartup(showOnStartup: boolean): Promise<void> {
    this.update({ showOnStartup });
    if (this.settings !== null) {
      await this.settings.set("user", WELCOME_ON_STARTUP_KEY, showOnStartup);
      return;
    }
    await this.ipc
      .settingsSet(WELCOME_ON_STARTUP_KEY, showOnStartup ? "true" : "false")
      .catch(() => undefined);
  }

  private update(patch: Partial<WelcomeState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
