import { describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { WELCOME_ON_STARTUP_KEY, WelcomeService } from "./welcomeService";

describe("WelcomeService", () => {
  it("opens on start-up by default", async () => {
    const welcome = new WelcomeService(createFakeIpc());
    await welcome.initialize();
    expect(welcome.getState()).toEqual({ open: true, showOnStartup: true });
  });

  it("stays closed on start-up when the user turned it off", async () => {
    const ipc = createFakeIpc({ settingsGet: vi.fn().mockResolvedValue("false") });
    const welcome = new WelcomeService(ipc);
    await welcome.initialize();
    expect(welcome.getState()).toEqual({ open: false, showOnStartup: false });
  });

  it("closes, reopens and saves the start-up choice", async () => {
    const ipc = createFakeIpc();
    const welcome = new WelcomeService(ipc);
    await welcome.initialize();
    const listener = vi.fn();
    welcome.subscribe(listener);

    welcome.close();
    expect(welcome.getState().open).toBe(false);
    welcome.open();
    expect(welcome.getState().open).toBe(true);
    await welcome.setShowOnStartup(false);

    expect(welcome.getState().showOnStartup).toBe(false);
    expect(ipc.settingsSet).toHaveBeenCalledWith(WELCOME_ON_STARTUP_KEY, "false");
    expect(listener).toHaveBeenCalledTimes(3);
  });
});


it("shows the startup page in front of restored editors in a newly opened window", async () => {
  const welcome = new WelcomeService(createFakeIpc({ settingsGet: vi.fn().mockResolvedValue("false") }));
  await welcome.initialize(true);
  expect(welcome.getState()).toMatchObject({ open: true, foreground: true });
  welcome.close();
  expect(welcome.getState()).toMatchObject({ open: false, foreground: false });
});
