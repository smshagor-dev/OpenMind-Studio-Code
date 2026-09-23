import { describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { type WindowApi, WindowService, zoomFactor } from "./windowService";

function createFakeApi(overrides: Partial<WindowApi> = {}): WindowApi {
  return {
    minimize: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    isMaximized: vi.fn().mockResolvedValue(false),
    isFullscreen: vi.fn().mockResolvedValue(false),
    setFullscreen: vi.fn().mockResolvedValue(undefined),
    onResized: vi.fn().mockResolvedValue(() => undefined),
    setZoom: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("WindowService", () => {
  it("initialize applies the saved zoom and reads the maximized state", async () => {
    const api = createFakeApi({ isMaximized: vi.fn().mockResolvedValue(true) });
    const ipc = createFakeIpc({ settingsGet: vi.fn().mockResolvedValue("2") });
    const service = new WindowService(api, ipc);

    await service.initialize();

    expect(api.setZoom).toHaveBeenCalledWith(zoomFactor(2));
    expect(service.getState()).toMatchObject({ maximized: true, zoomLevel: 2 });
  });

  it("zoomIn / zoomOut / zoomReset step the level and persist it", async () => {
    const api = createFakeApi();
    const ipc = createFakeIpc();
    const service = new WindowService(api, ipc);

    await service.zoomIn();
    await service.zoomIn();
    await service.zoomOut();
    expect(service.getState().zoomLevel).toBe(1);
    expect(ipc.settingsSet).toHaveBeenLastCalledWith("window.zoomLevel", "1");

    await service.zoomReset();
    expect(api.setZoom).toHaveBeenLastCalledWith(1);
  });

  it("clamps zoom to the supported range", async () => {
    const service = new WindowService(createFakeApi(), createFakeIpc());

    for (let i = 0; i < 20; i++) await service.zoomOut();

    expect(service.getState().zoomLevel).toBe(-5);
  });

  it("toggleFullscreen requests the opposite state and resyncs", async () => {
    let fullscreen = false;
    const api = createFakeApi({
      isFullscreen: vi.fn(() => Promise.resolve(fullscreen)),
      setFullscreen: vi.fn((value: boolean) => {
        fullscreen = value;
        return Promise.resolve();
      }),
    });
    const service = new WindowService(api, createFakeIpc());

    await service.toggleFullscreen();

    expect(api.setFullscreen).toHaveBeenCalledWith(true);
    expect(service.getState().fullscreen).toBe(true);
  });

  it("delegates minimize, maximize and close to the window API", async () => {
    const api = createFakeApi();
    const service = new WindowService(api, createFakeIpc());

    await service.minimize();
    await service.toggleMaximize();
    await service.close();

    expect(api.minimize).toHaveBeenCalled();
    expect(api.toggleMaximize).toHaveBeenCalled();
    expect(api.close).toHaveBeenCalled();
  });
});
