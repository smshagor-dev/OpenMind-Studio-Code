import * as monaco from "monaco-editor";

import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient, ThemeKind } from "./ipc";

/** Foundation-level theme selection: the two Monaco ships built in. */
const MONACO_THEME_MAP: Record<ThemeKind, string> = {
  dark: "vs-dark",
  light: "vs",
};

export class ThemeService {
  private current: ThemeKind = "dark";

  constructor(
    private readonly ipc: IpcClient,
    private readonly events: EventBus<AppEvents>,
  ) {}

  getTheme(): ThemeKind {
    return this.current;
  }

  /** Loads the persisted theme (if any) and applies it to Monaco. */
  async initialize(): Promise<void> {
    this.current = await this.ipc.themeGet();
    this.apply();
  }

  async setTheme(theme: ThemeKind): Promise<void> {
    if (theme === this.current) {
      return;
    }
    this.current = theme;
    this.apply();
    await this.ipc.themeSet(theme);
    this.events.emit("themeChanged", { theme });
  }

  subscribe(listener: (theme: ThemeKind) => void): () => void {
    return this.events.on("themeChanged", ({ theme }) => {
      listener(theme);
    });
  }

  private apply(): void {
    monaco.editor.setTheme(MONACO_THEME_MAP[this.current]);
  }
}
