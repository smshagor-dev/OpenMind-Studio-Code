import { describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { makePreferences } from "../testUtils/preferencesFixture";
import { CommandRegistry } from "./commandRegistry";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient, SettingsIssue } from "./ipc";
import { KeybindingService } from "./keybindings";
import { KeybindingsManager } from "./keybindingsManager";
import { watchPreferenceFiles } from "./preferenceFiles";
import { registerPreferencesCommands, THEME_COMMANDS } from "./preferencesCommands";
import { PreferencesPageService } from "./preferencesPageService";
import { SettingsService } from "./settingsService";
import { ThemeService } from "./themeService";

async function rig(workspace: string | null = null, overrides: Partial<IpcClient> = {}) {
  const ipc = createFakeIpc({
    preferencesLoad: vi.fn().mockResolvedValue(makePreferences({ workspace })),
    preferencesSet: vi
      .fn()
      .mockResolvedValue(
        makePreferences({ workspace, values: { "workbench.colorTheme": "light" } }),
      ),
    preferencesFile: vi
      .fn()
      .mockImplementation((scope: string) =>
        Promise.resolve(
          scope === "user"
            ? "C:/app/settings/settings.json"
            : `${workspace ?? ""}/.openmind/settings.json`,
        ),
      ),
    ...overrides,
  });
  const events = new EventBus<AppEvents>();
  const settings = new SettingsService(ipc, events);
  await settings.initialize();
  const commands = new CommandRegistry();
  const keybindingService = new KeybindingService(commands, []);
  const keybindings = new KeybindingsManager(ipc, keybindingService, {
    defaults: [],
    catalog: () => [],
    remappable: () => false,
    syncEditor: () => undefined,
  });
  const theme = new ThemeService(settings, events, () => null);
  await theme.initialize();
  const page = new PreferencesPageService();
  const opened: string[] = [];
  registerPreferencesCommands({
    commands,
    page,
    settings,
    keybindings,
    theme,
    events,
    openFile: (path) => {
      opened.push(path);
      return Promise.resolve();
    },
  });
  return { ipc, events, settings, commands, page, opened, keybindings, theme };
}

describe("preferences commands", () => {
  it("Settings, Keyboard Shortcuts and Color Theme open the page on the right tab", async () => {
    const r = await rig();

    await r.commands.execute("preferences.openSettings");
    expect(r.page.getState()).toMatchObject({ open: true, tab: "settings", scope: "user" });

    await r.commands.execute("preferences.openKeybindings");
    expect(r.page.getState()).toMatchObject({ open: true, tab: "keybindings" });

    await r.commands.execute("preferences.colorTheme");
    expect(r.page.getState()).toMatchObject({ tab: "settings", query: "color theme" });
  });

  it("workspace settings are disabled without a folder, with the reason, and open the workspace tab with one", async () => {
    const without = await rig();
    expect(without.commands.isEnabled("preferences.openWorkspaceSettings")).toBe(false);
    expect(without.commands.reasonFor("preferences.openWorkspaceSettings")).toBe(
      "Open a folder to use workspace settings.",
    );
    expect(without.commands.isEnabled("preferences.openWorkspaceSettingsJson")).toBe(false);

    const withFolder = await rig("C:/My Site");
    expect(withFolder.commands.isEnabled("preferences.openWorkspaceSettings")).toBe(true);
    await withFolder.commands.execute("preferences.openWorkspaceSettings");
    expect(withFolder.page.getState().scope).toBe("workspace");
  });

  it("the JSON commands open the file (created if missing) as an ordinary tab and close the page", async () => {
    const r = await rig("C:/My Site");
    r.page.open("settings");

    await r.commands.execute("preferences.openSettingsJson");
    await r.commands.execute("preferences.openWorkspaceSettingsJson");
    await r.commands.execute("preferences.openKeybindingsJson");

    expect(r.opened).toEqual([
      "C:/app/settings/settings.json",
      "C:/My Site/.openmind/settings.json",
      "C:/app/settings/keybindings.json",
    ]);
    expect(r.ipc.preferencesFile).toHaveBeenCalledWith("user");
    expect(r.ipc.preferencesFile).toHaveBeenCalledWith("workspace");
    expect(r.page.getState().open).toBe(false);
  });

  it("each theme has a command that saves it and is checked while it is the theme", async () => {
    const r = await rig();
    expect(THEME_COMMANDS.map(([id]) => id)).toEqual([
      "theme.setSystem",
      "theme.setDark",
      "theme.setLight",
      "theme.setHighContrast",
    ]);
    expect(r.commands.isChecked("theme.setDark")).toBe(true);
    expect(r.commands.isChecked("theme.setLight")).toBe(false);

    await r.commands.execute("theme.setLight");

    expect(r.ipc.preferencesSet).toHaveBeenCalledWith("user", "workbench.colorTheme", "light");
    expect(r.commands.isChecked("theme.setLight")).toBe(true);
    expect(r.commands.isChecked("theme.setDark")).toBe(false);
  });
});

describe("saving a settings file", () => {
  async function watchRig(
    scope: "user" | "workspace" | "keybindings" | null,
    issues: SettingsIssue[] = [],
  ) {
    const r = await rig(null, {
      preferencesScopeOf: vi.fn().mockResolvedValue(scope),
      preferencesValidate: vi.fn().mockResolvedValue(issues),
    });
    const notices: string[] = [];
    const errors: string[] = [];
    r.events.on("appNotice", ({ message }) => notices.push(message));
    r.events.on("appError", ({ message }) => errors.push(message));
    watchPreferenceFiles({
      events: r.events,
      settings: r.settings,
      keybindings: r.keybindings,
      contentOf: () => '{ "editor.fontSize": 99 }',
    });
    return { ...r, notices, errors };
  }

  it("a clean settings file is applied and the user is told", async () => {
    const r = await watchRig("user");
    r.events.emit("documentSaved", { id: "d1", path: "C:/app/settings/settings.json" });

    await vi.waitFor(() => {
      expect(r.notices).toEqual(["Settings applied."]);
    });
    expect(r.ipc.preferencesValidate).toHaveBeenCalledWith("user", '{ "editor.fontSize": 99 }');
  });

  it("a file with a wrong value says which one and where", async () => {
    const r = await watchRig("user", [
      {
        key: "editor.fontSize",
        message: "Font Size must be between 8 and 40.",
        severity: "error",
        line: 1,
      },
    ]);
    r.events.emit("documentSaved", { id: "d1", path: "C:/app/settings/settings.json" });

    await vi.waitFor(() => {
      expect(r.errors).toEqual([
        "Settings saved with 1 problem: Font Size must be between 8 and 40. (line 1)",
      ]);
    });
    expect(r.notices).toEqual([]);
  });

  it("a syntax error says where it is once, not twice", async () => {
    const r = await watchRig("user", [
      {
        key: null,
        message: "Not valid JSON (line 2, column 26): key must be a string",
        severity: "error",
        line: 2,
      },
    ]);
    r.events.emit("documentSaved", { id: "d1", path: "C:/app/settings/settings.json" });

    await vi.waitFor(() => {
      expect(r.errors).toEqual([
        "Settings saved with 1 problem: Not valid JSON (line 2, column 26): key must be a string",
      ]);
    });
  });

  it("warnings (an unknown setting) still apply the file", async () => {
    const r = await watchRig("workspace", [
      { key: "nonsense", message: 'Unknown setting "nonsense".', severity: "warning", line: 2 },
    ]);
    r.events.emit("documentSaved", { id: "d1", path: "C:/My Site/.openmind/settings.json" });

    await vi.waitFor(() => {
      expect(r.notices).toEqual(['Settings applied. Unknown setting "nonsense".']);
    });
  });

  it("saving keybindings.json applies the shortcuts", async () => {
    const r = await watchRig("keybindings");
    r.events.emit("documentSaved", { id: "d1", path: "C:/app/settings/keybindings.json" });

    await vi.waitFor(() => {
      expect(r.notices).toEqual(["Keyboard shortcuts applied."]);
    });
    expect(r.ipc.keybindingsLoad).toHaveBeenCalledTimes(1); // the rig never loaded it before
  });

  it("saving any other file does nothing", async () => {
    const r = await watchRig(null);
    r.events.emit("documentSaved", { id: "d1", path: "C:/My Site/readme.md" });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.notices).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.ipc.preferencesValidate).not.toHaveBeenCalled();
  });
});
