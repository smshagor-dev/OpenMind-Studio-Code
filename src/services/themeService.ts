import * as monaco from "monaco-editor";

import { defineMonacoThemes, MONACO_THEME_MAP } from "../editor/monacoThemes";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { ThemeKind, ThemeMode } from "./ipc";
import type { LoadedExtensionTheme } from "./extensionTheme";
import type { SettingsService } from "./settingsService";

export const THEME_SETTING = "workbench.colorTheme";

/** The values of `workbench.colorTheme` that name a theme contributed by an extension. */
export const EXTENSION_THEME_PREFIX = "extension:";

/** Where extension themes come from (the contribution service), so this service knows nothing of extensions. */
export interface ExtensionThemeSource {
  load: (value: string) => Promise<LoadedExtensionTheme | null>;
}

/** What `matchMedia("(prefers-color-scheme: dark)")` answers with, injectable for tests. */
export interface SchemeQuery {
  matches: boolean;
  addEventListener: (type: "change", listener: () => void) => void;
  removeEventListener: (type: "change", listener: () => void) => void;
}

export type SchemeQueryFactory = () => SchemeQuery | null;

const THEME_MODES: ThemeMode[] = ["system", "dark", "light", "high-contrast"];

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && THEME_MODES.includes(value as ThemeMode);
}

function browserScheme(): SchemeQuery | null {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
}

/**
 * The color theme: the `workbench.colorTheme` setting (system / dark / light / high contrast)
 * resolved to the colors actually drawn. `system` follows Windows live. Applying a theme sets
 * `data-theme` on <html> (every color in the app is a CSS token under that attribute) and the
 * matching Monaco theme; terminals read the same tokens (see `themeColors`). Every window builds its
 * own ThemeService, so the PHP window follows the same setting.
 */
export class ThemeService {
  private mode: ThemeMode = "dark";
  private resolved: ThemeKind = "dark";
  private scheme: SchemeQuery | null = null;
  private extensionSource: ExtensionThemeSource | null = null;
  private extensionValue: string | null = null;
  private appliedTokens: string[] = [];
  private loadCounter = 0;
  private readonly onSchemeChange = () => {
    if (this.mode === "system") this.apply();
  };

  constructor(
    private readonly settings: SettingsService,
    private readonly events: EventBus<AppEvents>,
    private readonly schemeFactory: SchemeQueryFactory = browserScheme,
  ) {}

  /** The colors in use (never `system`). */
  getTheme(): ThemeKind {
    return this.resolved;
  }

  /** The extension theme in use (its `workbench.colorTheme` value), if the setting names one. */
  getExtensionTheme(): string | null {
    return this.extensionValue;
  }

  /** Lets the setting name themes from extensions; the current setting is read again. */
  setExtensionThemeSource(source: ExtensionThemeSource): void {
    this.extensionSource = source;
    if (this.scheme !== null || this.extensionValue !== null) this.readSetting();
  }

  /** What the user chose (possibly `system`). */
  getMode(): ThemeMode {
    return this.mode;
  }

  /** Loads the saved theme, applies it and keeps following the setting and Windows. */
  async initialize(): Promise<void> {
    await this.settings.ensureLoaded();
    this.scheme = this.schemeFactory();
    this.scheme?.addEventListener("change", this.onSchemeChange);
    this.readSetting();
    this.settings.onChange([THEME_SETTING], () => {
      this.readSetting();
    });
  }

  dispose(): void {
    this.scheme?.removeEventListener("change", this.onSchemeChange);
  }

  /** Saves the theme in the user's settings; the change then applies through the setting. */
  async setMode(mode: ThemeMode): Promise<boolean> {
    const result = await this.settings.set("user", THEME_SETTING, mode);
    return result.ok;
  }

  subscribe(listener: (theme: ThemeKind) => void): () => void {
    return this.events.on("themeChanged", ({ theme }) => {
      listener(theme);
    });
  }

  /** Re-reads the setting (also after the extensions changed: a theme may have come or gone). */
  readSetting(): void {
    const value = this.settings.string(THEME_SETTING, "dark");
    if (value.startsWith(EXTENSION_THEME_PREFIX) && this.extensionSource !== null) {
      this.extensionValue = value;
      void this.applyExtension(value);
      return;
    }
    this.extensionValue = null;
    this.mode = isThemeMode(value) ? value : "dark";
    this.apply();
  }

  private clearTokens(): void {
    for (const token of this.appliedTokens.splice(0)) {
      document.documentElement.style.removeProperty(token);
    }
  }

  private async applyExtension(value: string): Promise<void> {
    const ticket = ++this.loadCounter;
    let loaded: LoadedExtensionTheme | null = null;
    try {
      loaded = (await this.extensionSource?.load(value)) ?? null;
    } catch (error) {
      this.events.emit("appError", { message: `Couldn't load the colour theme: ${String(error)}` });
    }
    if (ticket !== this.loadCounter || this.extensionValue !== value) return;
    if (loaded === null) {
      this.events.emit("appNotice", {
        message: "That colour theme isn't available (its extension is disabled or removed): using Dark.",
      });
      this.extensionValue = null;
      this.mode = "dark";
      this.apply();
      return;
    }
    this.clearTokens();
    this.resolved = loaded.kind;
    document.documentElement.dataset.theme = loaded.kind;
    for (const [token, color] of Object.entries(loaded.tokens)) {
      document.documentElement.style.setProperty(token, color);
      this.appliedTokens.push(token);
    }
    defineMonacoThemes();
    const name = `openmind-ext-${String(ticket)}`;
    monaco.editor.defineTheme(name, loaded.monaco);
    monaco.editor.setTheme(name);
    this.events.emit("themeChanged", { theme: loaded.kind });
  }

  private apply(): void {
    const next: ThemeKind =
      this.mode === "system" ? (this.scheme?.matches === false ? "light" : "dark") : this.mode;
    const changed = next !== this.resolved;
    this.loadCounter += 1;
    this.clearTokens();
    this.resolved = next;
    document.documentElement.dataset.theme = next;
    defineMonacoThemes();
    monaco.editor.setTheme(MONACO_THEME_MAP[next] ?? "openmind-dark");
    if (changed) this.events.emit("themeChanged", { theme: next });
  }
}
