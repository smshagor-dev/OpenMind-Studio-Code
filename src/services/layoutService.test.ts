import { describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import {
  DEFAULT_LAYOUT,
  LayoutService,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "./layoutService";

describe("LayoutService", () => {
  it("starts with defaults when nothing is stored", async () => {
    const service = new LayoutService(createFakeIpc());

    await service.initialize();

    expect(service.getState()).toEqual(DEFAULT_LAYOUT);
  });

  it("restores a stored layout, ignoring invalid fields", async () => {
    const ipc = createFakeIpc({
      settingsGet: vi.fn((key: string) =>
        Promise.resolve(
          key === "workbench.layout"
            ? '{"sidebarVisible":false,"sidebarWidth":5000,"sidebarPosition":"top","statusBarVisible":"no"}'
            : null,
        ),
      ),
    });
    const service = new LayoutService(ipc);

    await service.initialize();

    expect(service.getState()).toMatchObject({
      sidebarVisible: false,
      sidebarWidth: SIDEBAR_MAX_WIDTH,
      sidebarPosition: "left",
      statusBarVisible: true,
    });
  });

  it("honors the legacy sidebar.visible key when no layout is stored yet", async () => {
    const ipc = createFakeIpc({
      settingsGet: vi.fn((key: string) =>
        Promise.resolve(key === "sidebar.visible" ? "false" : null),
      ),
    });
    const service = new LayoutService(ipc);

    await service.initialize();

    expect(service.getState().sidebarVisible).toBe(false);
  });

  it("toggle flips a flag, notifies, and persists", async () => {
    const ipc = createFakeIpc();
    const service = new LayoutService(ipc);
    const listener = vi.fn();
    service.subscribe(listener);

    await service.toggle("statusBarVisible");

    expect(service.getState().statusBarVisible).toBe(false);
    expect(listener).toHaveBeenCalled();
    expect(ipc.settingsSet).toHaveBeenCalledWith(
      "workbench.layout",
      expect.stringContaining('"statusBarVisible":false'),
    );
  });

  it("previewSidebarWidth clamps without persisting; commit persists", async () => {
    const ipc = createFakeIpc();
    const service = new LayoutService(ipc);

    service.previewSidebarWidth(10);
    expect(service.getState().sidebarWidth).toBe(SIDEBAR_MIN_WIDTH);
    expect(ipc.settingsSet).not.toHaveBeenCalled();

    await service.commitSidebarWidth();
    expect(ipc.settingsSet).toHaveBeenCalledTimes(1);
  });

  it("toggleSidebarPosition swaps sides", async () => {
    const service = new LayoutService(createFakeIpc());

    await service.toggleSidebarPosition();

    expect(service.getState().sidebarPosition).toBe("right");
  });
});
