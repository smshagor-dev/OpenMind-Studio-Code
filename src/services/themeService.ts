import * as monaco from "monaco-editor";

import { defineMonacoThemes, MONACO_THEME_MAP } from "../editor/monacoThemes";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient, ThemeKind } from "./ipc";

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
    defineMonacoThemes();
    monaco.editor.setTheme(MONACO_THEME_MAP[this.current] ?? "openmind-dark");
  }
}
