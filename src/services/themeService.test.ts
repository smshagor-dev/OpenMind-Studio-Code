import { describe, expect, it, vi } from "vitest";

import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient } from "./ipc";
import { ThemeService } from "./themeService";

function createFakeIpc(overrides: Partial<IpcClient> = {}): IpcClient {
  return {
    openDocumentDialog: vi.fn().mockResolvedValue(null),
    saveDocumentDialog: vi.fn().mockResolvedValue(null),
    documentOpen: vi.fn(),
    documentSave: vi.fn().mockResolvedValue(undefined),
    recentFilesList: vi.fn().mockResolvedValue([]),
    recentFilesClear: vi.fn().mockResolvedValue(undefined),
    sessionLoad: vi.fn().mockResolvedValue({ openPaths: [], activePath: null }),
    sessionSave: vi.fn().mockResolvedValue(undefined),
    themeGet: vi.fn().mockResolvedValue("dark"),
    themeSet: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("ThemeService", () => {
  it("defaults to dark before initialize() runs", () => {
    const service = new ThemeService(createFakeIpc(), new EventBus<AppEvents>());

    expect(service.getTheme()).toBe("dark");
  });

  it("initialize() loads the persisted theme", async () => {
    const ipc = createFakeIpc({ themeGet: vi.fn().mockResolvedValue("light") });
    const service = new ThemeService(ipc, new EventBus<AppEvents>());

    await service.initialize();

    expect(service.getTheme()).toBe("light");
  });

  it("setTheme persists the choice and notifies subscribers", async () => {
    const ipc = createFakeIpc();
    const events = new EventBus<AppEvents>();
    const service = new ThemeService(ipc, events);
    const listener = vi.fn();
    service.subscribe(listener);

    await service.setTheme("light");

    expect(ipc.themeSet).toHaveBeenCalledWith("light");
    expect(service.getTheme()).toBe("light");
    expect(listener).toHaveBeenCalledWith("light");
  });

  it("setTheme with the current theme is a no-op", async () => {
    const ipc = createFakeIpc();
    const service = new ThemeService(ipc, new EventBus<AppEvents>());

    await service.setTheme("dark");

    expect(ipc.themeSet).not.toHaveBeenCalled();
  });
});
