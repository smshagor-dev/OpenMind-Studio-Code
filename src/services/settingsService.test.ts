import { describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { makePreferences } from "../testUtils/preferencesFixture";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient, PreferencesSnapshot } from "./ipc";
import { SettingsService } from "./settingsService";

function rig(initial: PreferencesSnapshot = makePreferences(), overrides: Partial<IpcClient> = {}) {
  const ipc = createFakeIpc({
    preferencesLoad: vi.fn().mockResolvedValue(initial),
    ...overrides,
  });
  const events = new EventBus<AppEvents>();
  return { ipc, events, settings: new SettingsService(ipc, events) };
}

describe("SettingsService values", () => {
  it("answers with the fallback until loaded, then with the effective values", async () => {
    const { settings } = rig(makePreferences({ values: { "editor.fontSize": 18 } }));
    expect(settings.number("editor.fontSize", 14)).toBe(14);

    await settings.initialize();

    expect(settings.number("editor.fontSize", 14)).toBe(18);
    expect(settings.bool("editor.wordWrap", true)).toBe(false); // the default, not the fallback
    expect(settings.string("editor.lineNumbers", "off")).toBe("on");
    expect(settings.sourceOf("editor.fontSize")).toBe("user");
    expect(settings.sourceOf("editor.wordWrap")).toBe("default");
  });

  it("a workspace value is reported as such, and the workspace overrides the user value", async () => {
    const { settings } = rig(
      makePreferences({
        workspace: "C:/My Site",
        values: { "editor.fontSize": 20 },
        sources: { "editor.fontSize": "workspace" },
        userSet: ["editor.fontSize"],
        workspaceSet: ["editor.fontSize"],
      }),
    );
    await settings.initialize();

    expect(settings.sourceOf("editor.fontSize")).toBe("workspace");
    expect(settings.isSetIn("workspace", "editor.fontSize")).toBe(true);
    expect(settings.isSetIn("user", "editor.fontSize")).toBe(true);
    expect(settings.isSetIn("user", "editor.wordWrap")).toBe(false);
  });

  it("a backend that can't be reached leaves the defaults and says why", async () => {
    const { settings } = rig(makePreferences(), {
      preferencesLoad: vi.fn().mockRejectedValue(new Error("no backend")),
    });
    await settings.initialize();

    expect(settings.getState().snapshot).toBeNull();
    expect(settings.getState().loadError).toBe("no backend");
    expect(settings.bool("editor.wordWrap", true)).toBe(true);
  });
});

describe("SettingsService editing", () => {
  it("set saves through the backend, adopts the answer and announces only what changed", async () => {
    const { settings, ipc, events } = rig(makePreferences(), {
      preferencesSet: vi
        .fn()
        .mockResolvedValue(makePreferences({ values: { "editor.fontSize": 22 } })),
    });
    await settings.initialize();
    const announced: string[][] = [];
    events.on("settingsChanged", ({ ids }) => announced.push(ids));

    const result = await settings.set("user", "editor.fontSize", 22);

    expect(result).toEqual({ ok: true });
    expect(ipc.preferencesSet).toHaveBeenCalledWith("user", "editor.fontSize", 22);
    expect(settings.number("editor.fontSize", 14)).toBe(22);
    expect(announced).toEqual([["editor.fontSize"]]);
  });

  it("a value the backend refuses comes back as its message and changes nothing", async () => {
    const { settings } = rig(makePreferences(), {
      preferencesSet: vi.fn().mockRejectedValue(new Error("Font Size must be between 8 and 40.")),
    });
    await settings.initialize();

    const result = await settings.set("user", "editor.fontSize", 3);

    expect(result).toEqual({ ok: false, error: "Font Size must be between 8 and 40." });
    expect(settings.number("editor.fontSize", 14)).toBe(14);
  });

  it("reset removes the setting from the file and the default applies again", async () => {
    const { settings, ipc } = rig(makePreferences({ values: { "editor.fontSize": 22 } }), {
      preferencesReset: vi.fn().mockResolvedValue(makePreferences()),
    });
    await settings.initialize();

    await settings.reset("user", "editor.fontSize");

    expect(ipc.preferencesReset).toHaveBeenCalledWith("user", "editor.fontSize");
    expect(settings.number("editor.fontSize", 0)).toBe(14);
    expect(settings.isSetIn("user", "editor.fontSize")).toBe(false);
  });

  it("workspace settings need an open folder, and a user-only setting can't be set there", async () => {
    const { settings, ipc } = rig();
    await settings.initialize();

    expect(settings.workspaceAvailability()).toEqual({
      enabled: false,
      reason: "Open a folder to use workspace settings.",
    });
    expect(await settings.set("workspace", "editor.fontSize", 20)).toEqual({
      ok: false,
      error: "Open a folder to use workspace settings.",
    });

    const withFolder = rig(makePreferences({ workspace: "C:/My Site" }));
    await withFolder.settings.initialize();
    expect(withFolder.settings.workspaceAvailability().enabled).toBe(true);
    expect(withFolder.settings.scopeAvailability("workspace", "terminal.fontSize")).toEqual({
      enabled: false,
      reason: "This setting only exists for the whole app.",
    });
    expect(withFolder.settings.scopeAvailability("workspace", "editor.fontSize").enabled).toBe(
      true,
    );
    expect(ipc.preferencesSet).not.toHaveBeenCalled();
  });

  it("setEffective writes where the value comes from, so a toggle always shows", async () => {
    const { settings, ipc } = rig(
      makePreferences({
        workspace: "C:/My Site",
        values: { "editor.wordWrap": true },
        sources: { "editor.wordWrap": "workspace" },
      }),
    );
    await settings.initialize();

    await settings.setEffective("editor.wordWrap", false);
    expect(ipc.preferencesSet).toHaveBeenLastCalledWith("workspace", "editor.wordWrap", false);

    await settings.setEffective("editor.fontSize", 16);
    expect(ipc.preferencesSet).toHaveBeenLastCalledWith("user", "editor.fontSize", 16);
  });
});

describe("SettingsService search and change events", () => {
  it("search matches every word against id, title, description and category, grouped by category", async () => {
    const { settings } = rig();
    await settings.initialize();

    expect(settings.search("").map((group) => group.category)).toEqual([
      "Editor",
      "Terminal",
      "Workbench",
    ]);
    const size = settings.search("font size");
    expect(size.map((group) => [group.category, group.settings.map((def) => def.id)])).toEqual([
      ["Editor", ["editor.fontSize"]],
      ["Terminal", ["terminal.fontSize"]],
    ]);
    expect(settings.search("wrap").flatMap((group) => group.settings.map((def) => def.id))).toEqual(
      ["editor.wordWrap"],
    );
    expect(settings.search("TERMINAL font").flatMap((g) => g.settings.map((d) => d.id))).toEqual([
      "terminal.fontSize",
    ]);
    expect(settings.search("zzzz")).toEqual([]);
  });

  it("onChange fires for the ids it was given, not for unrelated settings", async () => {
    const { settings } = rig(makePreferences(), {
      preferencesSet: vi
        .fn()
        .mockResolvedValue(makePreferences({ values: { "editor.wordWrap": true } })),
    });
    await settings.initialize();
    const editorChanged = vi.fn();
    const terminalChanged = vi.fn();
    settings.onChange(["editor.wordWrap"], editorChanged);
    settings.onChange(["terminal.fontSize"], terminalChanged);

    await settings.set("user", "editor.wordWrap", true);

    expect(editorChanged).toHaveBeenCalledTimes(1);
    expect(terminalChanged).not.toHaveBeenCalled();
  });

  it("reload announces a change made to the file by hand", async () => {
    const { settings, ipc } = rig();
    await settings.initialize();
    const changed = vi.fn();
    settings.onChange(["editor.fontSize"], changed);
    (ipc.preferencesLoad as ReturnType<typeof vi.fn>).mockResolvedValue(
      makePreferences({ values: { "editor.fontSize": 30 } }),
    );

    await settings.reload();
    await settings.reload(); // unchanged the second time

    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("a settings file with a syntax error keeps the last good values in force and shows the error", async () => {
    const { settings, ipc } = rig(makePreferences({ values: { "workbench.colorTheme": "light" } }));
    await settings.initialize();
    const changed = vi.fn();
    settings.onChange(["workbench.colorTheme"], changed);
    const broken = makePreferences();
    broken.userError = "Not valid JSON (line 2, column 3): expected value";
    (ipc.preferencesLoad as ReturnType<typeof vi.fn>).mockResolvedValue(broken);

    await settings.reload();

    expect(settings.string("workbench.colorTheme", "dark")).toBe("light"); // not back to the default
    expect(settings.getState().snapshot?.userError).toContain("line 2");
    expect(changed).not.toHaveBeenCalled();

    (ipc.preferencesLoad as ReturnType<typeof vi.fn>).mockResolvedValue(
      makePreferences({ values: { "workbench.colorTheme": "high-contrast" } }),
    );
    await settings.reload();
    expect(settings.string("workbench.colorTheme", "dark")).toBe("high-contrast");
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("ensureLoaded loads once", async () => {
    const { settings, ipc } = rig();
    await settings.ensureLoaded();
    await settings.ensureLoaded();

    expect(ipc.preferencesLoad).toHaveBeenCalledTimes(1);
  });
});

describe("SettingsService saved JSON files", () => {
  it("saving a settings file re-reads it and returns what is wrong with it", async () => {
    const issues = [
      {
        key: "editor.fontSize",
        message: "Font Size must be between 8 and 40.",
        severity: "error",
        line: 2,
      },
    ];
    const { settings, ipc } = rig(makePreferences(), {
      preferencesScopeOf: vi.fn().mockResolvedValue("user"),
      preferencesValidate: vi.fn().mockResolvedValue(issues),
    });
    await settings.initialize();

    const result = await settings.handleSaved(
      "C:/app/settings/settings.json",
      '{"editor.fontSize": 99}',
    );

    expect(result).toEqual(issues);
    expect(ipc.preferencesValidate).toHaveBeenCalledWith("user", '{"editor.fontSize": 99}');
    expect(ipc.preferencesLoad).toHaveBeenCalledTimes(2);
  });

  it("any other file, and the keybindings file, are not settings files", async () => {
    const { settings, ipc } = rig(makePreferences(), {
      preferencesScopeOf: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("keybindings"),
    });
    await settings.initialize();

    expect(await settings.handleSaved("C:/x/readme.md", "")).toBeNull();
    expect(await settings.handleSaved("C:/app/settings/keybindings.json", "[]")).toBeNull();
    expect(ipc.preferencesValidate).not.toHaveBeenCalled();
  });
});
