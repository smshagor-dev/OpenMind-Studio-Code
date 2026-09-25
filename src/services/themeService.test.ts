import { beforeEach, describe, expect, it, vi } from "vitest";

import { makePreferences } from "../testUtils/preferencesFixture";
import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient, SettingValue } from "./ipc";
import { SettingsService } from "./settingsService";
import { type SchemeQuery, ThemeService } from "./themeService";

/** A settings backend that remembers what was saved, like the real files do. */
function rig(saved: SettingValue | null = null, prefersDark = true) {
  let current = saved;
  const ipc: IpcClient = createFakeIpc({
    preferencesLoad: vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          makePreferences(current === null ? {} : { values: { "workbench.colorTheme": current } }),
        ),
      ),
    preferencesSet: vi
      .fn()
      .mockImplementation((_scope: string, _id: string, value: SettingValue) => {
        current = value;
        return Promise.resolve(makePreferences({ values: { "workbench.colorTheme": value } }));
      }),
  });
  const events = new EventBus<AppEvents>();
  const settings = new SettingsService(ipc, events);
  const listeners = new Set<() => void>();
  const scheme: SchemeQuery & { matches: boolean } = {
    matches: prefersDark,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const theme = new ThemeService(settings, events, () => scheme);
  return {
    ipc,
    events,
    settings,
    theme,
    windowsChangesTo: (dark: boolean) => {
      scheme.matches = dark;
      for (const listener of listeners) listener();
    },
  };
}

describe("ThemeService", () => {
  beforeEach(() => {
    delete document.documentElement.dataset.theme;
  });

  it("is dark before it has been initialized", () => {
    expect(rig().theme.getTheme()).toBe("dark");
  });

  it("initialize() applies the saved theme to the workbench", async () => {
    const { theme } = rig("light");
    await theme.initialize();

    expect(theme.getMode()).toBe("light");
    expect(theme.getTheme()).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("setMode saves the choice in the user settings, applies it and tells subscribers", async () => {
    const { theme, ipc } = rig();
    await theme.initialize();
    const listener = vi.fn();
    theme.subscribe(listener);

    expect(await theme.setMode("high-contrast")).toBe(true);

    expect(ipc.preferencesSet).toHaveBeenCalledWith(
      "user",
      "workbench.colorTheme",
      "high-contrast",
    );
    expect(theme.getTheme()).toBe("high-contrast");
    expect(document.documentElement.dataset.theme).toBe("high-contrast");
    expect(listener).toHaveBeenCalledWith("high-contrast");
  });

  it("the choice survives a restart: a new service reads it back", async () => {
    const first = rig();
    await first.theme.initialize();
    await first.theme.setMode("light");

    const saved = (first.ipc.preferencesSet as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[2] as SettingValue;
    const second = rig(saved);
    await second.theme.initialize();

    expect(second.theme.getMode()).toBe("light");
  });

  it("system follows Windows, now and when Windows changes", async () => {
    const { theme, windowsChangesTo } = rig("system", false);
    await theme.initialize();
    expect(theme.getMode()).toBe("system");
    expect(theme.getTheme()).toBe("light");

    const listener = vi.fn();
    theme.subscribe(listener);
    windowsChangesTo(true);

    expect(theme.getTheme()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(listener).toHaveBeenCalledWith("dark");
  });

  it("a fixed theme ignores Windows changes", async () => {
    const { theme, windowsChangesTo } = rig("light", true);
    await theme.initialize();
    windowsChangesTo(false);
    windowsChangesTo(true);

    expect(theme.getTheme()).toBe("light");
  });

  it("changing the setting in the JSON file (a reload) switches the theme", async () => {
    const r = rig("dark");
    await r.theme.initialize();
    (r.ipc.preferencesLoad as ReturnType<typeof vi.fn>).mockResolvedValue(
      makePreferences({ values: { "workbench.colorTheme": "high-contrast" } }),
    );

    await r.settings.reload();

    expect(r.theme.getTheme()).toBe("high-contrast");
  });

  it("an unknown value in the file falls back to dark", async () => {
    const { theme } = rig("neon");
    await theme.initialize();

    expect(theme.getMode()).toBe("dark");
  });

  it("does not announce a theme change when the colors stay the same", async () => {
    const { theme } = rig("dark");
    await theme.initialize();
    const listener = vi.fn();
    theme.subscribe(listener);

    await theme.setMode("system"); // Windows is dark in this rig

    expect(theme.getTheme()).toBe("dark");
    expect(listener).not.toHaveBeenCalled();
  });
});
