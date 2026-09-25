import { describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import {
  SECONDARY_MIN_WIDTH,
  SECONDARY_SIDEBAR_KEY,
  SecondarySideBarService,
} from "./secondarySideBarService";

describe("SecondarySideBarService", () => {
  it("starts hidden, at half width, on the Run Code channel", async () => {
    const service = new SecondarySideBarService(createFakeIpc());
    await service.initialize();
    expect(service.getState()).toEqual({
      visible: false,
      half: true,
      width: 420,
      channel: "Run Code",
    });
  });

  it("showOutput opens it at half width on that channel and saves it", async () => {
    const ipc = createFakeIpc();
    const service = new SecondarySideBarService(ipc);
    service.previewWidth(300);

    await service.showOutput("Python");

    expect(service.getState()).toMatchObject({ visible: true, half: true, channel: "Python" });
    expect(ipc.settingsSet).toHaveBeenLastCalledWith(
      SECONDARY_SIDEBAR_KEY,
      expect.stringContaining('"channel":"Python"'),
    );
  });

  it("dragging the sash gives it a fixed, clamped width, saved on release", async () => {
    const ipc = createFakeIpc();
    const service = new SecondarySideBarService(ipc);

    service.previewWidth(10);
    expect(service.getState()).toMatchObject({ half: false, width: SECONDARY_MIN_WIDTH });
    expect(ipc.settingsSet).not.toHaveBeenCalled();
    await service.commitWidth();
    expect(ipc.settingsSet).toHaveBeenCalledTimes(1);
  });

  it("toggles, hides and restores what was saved (ignoring bad values)", async () => {
    const ipc = createFakeIpc({
      settingsGet: vi
        .fn()
        .mockResolvedValue(
          JSON.stringify({ visible: true, half: false, width: 99999, channel: "", extra: 1 }),
        ),
    });
    const service = new SecondarySideBarService(ipc);
    await service.initialize();
    expect(service.getState()).toEqual({
      visible: true,
      half: false,
      width: 1600,
      channel: "Run Code",
    });

    await service.toggle();
    expect(service.getState().visible).toBe(false);
    await service.toggle();
    await service.hide();
    expect(service.getState().visible).toBe(false);
  });
});
