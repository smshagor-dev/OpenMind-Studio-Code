import type { CommandRegistry } from "./commandRegistry";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { KeybindingsManager } from "./keybindingsManager";
import type { PreferencesPageService } from "./preferencesPageService";
import type { SettingsService } from "./settingsService";
import type { ThemeService } from "./themeService";
import type { ThemeMode } from "./ipc";

export interface PreferencesCommandDeps {
  commands: CommandRegistry;
  page: PreferencesPageService;
  settings: SettingsService;
  keybindings: KeybindingsManager;
  theme: ThemeService;
  /** Opens a file as an editor tab (`WorkspaceService.openPath`). */
  openFile: (path: string) => Promise<unknown>;
  events: EventBus<AppEvents>;
}

const NO_FOLDER = "Open a folder to use workspace settings.";

/** The theme modes, in the order the menus list them. */
export const THEME_COMMANDS: [string, ThemeMode][] = [
  ["theme.setSystem", "system"],
  ["theme.setDark", "dark"],
  ["theme.setLight", "light"],
  ["theme.setHighContrast", "high-contrast"],
];

/**
 * Settings, Keyboard Shortcuts and Color Theme as commands (menus, the gear, shortcuts). Opening a
 * JSON file is an ordinary editor tab: saving it applies the change (see \`watchPreferenceFiles\`).
 */
export function registerPreferencesCommands(deps: PreferencesCommandDeps): void {
  const { commands, page, settings, keybindings, theme, openFile } = deps;
  const hasFolder = () => settings.workspaceAvailability().enabled;
  const folderReason = () => (hasFolder() ? undefined : NO_FOLDER);

  commands.register("preferences.openSettings", () => {
    page.open("settings", { scope: "user" });
  });
  commands.register(
    "preferences.openWorkspaceSettings",
    () => {
      page.open("settings", { scope: "workspace" });
    },
    { enabled: hasFolder, disabledReason: folderReason },
  );
  commands.register("preferences.openSettingsJson", async () => {
    await openFile(await settings.jsonFile("user"));
    page.close();
  });
  commands.register(
    "preferences.openWorkspaceSettingsJson",
    async () => {
      await openFile(await settings.jsonFile("workspace"));
      page.close();
    },
    { enabled: hasFolder, disabledReason: folderReason },
  );
  commands.register("preferences.openKeybindings", () => {
    page.open("keybindings");
  });
  commands.register("preferences.openKeybindingsJson", async () => {
    await openFile(await keybindings.jsonFile());
    page.close();
  });
  // Settings > Language: every bundled language, picked from a list (the choice applies at once).
  commands.register("preferences.displayLanguage", () => {
    page.open("settings", { scope: "user", category: "Language" });
  });
  commands.register("preferences.colorTheme", () => {
    page.open("settings", { scope: "user", query: "color theme" });
  });
  for (const [id, mode] of THEME_COMMANDS) {
    commands.register(
      id,
      async () => {
        await theme.setMode(mode);
      },
      { checked: () => theme.getMode() === mode },
    );
  }
}
