import { type LoadedIconTheme, setExtensionIconTheme } from "../components/iconThemes";
import { parseIconTheme } from "./extensionIconTheme";
import type { InstalledExtension } from "./extensionsIpc";

export const ICON_THEME_SETTING = "workbench.iconTheme";
const DEFAULT = "material";

export interface IconThemeServiceDeps {
  settings: {
    string: (id: string, fallback: string) => string;
    onChange: (ids: string[], handler: () => void) => () => void;
    reset: (scope: "user" | "workspace", id: string) => Promise<{ ok: boolean }>;
  };
  registry: {
    all: () => InstalledExtension[];
    subscribe: (listener: () => void) => () => void;
    loaded: () => boolean;
  };
  readFile: (extension: string, path: string) => Promise<string>;
  readIcon: (extension: string, path: string) => Promise<string>;
  languageOf: (name: string) => string | null;
  notice: (message: string) => void;
}

/** `extension:<extension id>/<icon theme id>` -> its parts (the extension id is everything before the last `/`). */
export function parseIconThemeValue(value: string): { extension: string; theme: string } | null {
  if (!value.startsWith("extension:")) return null;
  const rest = value.slice("extension:".length);
  const slash = rest.lastIndexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { extension: rest.slice(0, slash), theme: rest.slice(slash + 1) };
}

/**
 * Loads the extension icon theme `workbench.iconTheme` names (Milestone 18): its JSON file, then each icon as it is
 * first shown. When the theme can't be used (a font theme, a damaged file) the built-in theme is shown and the user
 * is told once; when its extension is disabled or uninstalled the setting goes back to the built-in default (like a
 * colour theme). UI-free apart from pushing the loaded theme to the icon components.
 */
export class ExtensionIconThemeService {
  private loadingFor: string | null = null;
  /** The extension theme that is shown (`extension:<id>/<theme>`), or null. */
  private applied: string | null = null;
  /** The theme whose setting was already reset (several updates can report the same removal). */
  private forgotten: string | null = null;
  private seq = 0;

  constructor(private readonly deps: IconThemeServiceDeps) {}

  start(): () => void {
    const offSettings = this.deps.settings.onChange([ICON_THEME_SETTING], () => {
      void this.apply();
    });
    const offRegistry = this.deps.registry.subscribe(() => {
      void this.apply();
    });
    void this.apply();
    return () => {
      offSettings();
      offRegistry();
    };
  }

  /** Brings the shown icons in line with the setting and the installed extensions. */
  async apply(): Promise<void> {
    const value = this.deps.settings.string(ICON_THEME_SETTING, DEFAULT);
    const parts = parseIconThemeValue(value);
    if (parts === null) {
      // Once its extension is disabled the saved value is no longer a valid choice, so the setting already reads as
      // the default here; the theme that was applied tells us whether that is why.
      const previousValue = this.applied;
      const previous = previousValue === null ? null : parseIconThemeValue(previousValue);
      this.applied = null;
      this.loadingFor = null;
      setExtensionIconTheme(null);
      if (
        previousValue !== null &&
        previous !== null &&
        this.deps.registry.loaded() &&
        this.contribution(previous) === null
      ) {
        await this.forget(previousValue);
      }
      return;
    }
    if (!this.deps.registry.loaded()) return;
    const found = this.contribution(parts);
    if (found === null) {
      this.applied = null;
      this.loadingFor = null;
      setExtensionIconTheme(null);
      await this.forget(value);
      return;
    }
    this.forgotten = null;
    if (this.loadingFor === value) return;
    const { extension, contribution } = found;
    this.loadingFor = value;
    const seq = ++this.seq;
    try {
      const text = await this.deps.readFile(extension.id, contribution.path);
      const model = parseIconTheme(text, contribution.path);
      if (seq !== this.seq) return;
      const theme: LoadedIconTheme = {
        id: value,
        label: contribution.label || contribution.id,
        model,
        readIcon: (path) => this.deps.readIcon(extension.id, path),
        languageOf: this.deps.languageOf,
      };
      setExtensionIconTheme(theme);
      this.applied = value;
    } catch (error) {
      if (seq !== this.seq) return;
      setExtensionIconTheme(null);
      this.deps.notice(
        `The icon theme "${contribution.label || contribution.id}" can't be used: ${String(error).replace(/^Error: /, "")}`,
      );
    }
  }

  /** The enabled extension and its icon theme contribution for `parts`, or null when it is disabled or gone. */
  private contribution(parts: { extension: string; theme: string }) {
    const extension = this.deps.registry.all().find((e) => e.id === parts.extension && e.enabled);
    const contribution = extension?.manifest.contributes.iconThemes.find(
      (t) => t.id === parts.theme,
    );
    return extension && contribution ? { extension, contribution } : null;
  }

  /** The theme's extension is disabled or gone: the setting goes back to the built-in default (like a colour theme). */
  private async forget(value: string): Promise<void> {
    if (this.forgotten === value) return;
    this.forgotten = value;
    await this.deps.settings.reset("user", ICON_THEME_SETTING);
    this.deps.notice(
      "The file icon theme's extension is disabled or gone; the built-in icons are used again.",
    );
  }
}
