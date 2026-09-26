import { describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "./commandRegistry";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { logFilePath, registerHelpCommands } from "./helpCommands";
import { createFakeIpc } from "../testUtils/fakeIpcClient";

function setup(overrides: Parameters<typeof createFakeIpc>[0] = {}) {
  const ipc = createFakeIpc(overrides);
  const events = new EventBus<AppEvents>();
  const errors: string[] = [];
  events.on("appError", ({ message }) => {
    errors.push(message);
  });
  const commands = new CommandRegistry();
  const openFile = vi.fn().mockResolvedValue("d1");
  registerHelpCommands({ commands, events, ipc, openFile });
  return { ipc, commands, openFile, errors };
}

describe("Help commands", () => {
  it("Show Logs opens the app's own log file as an editor tab", async () => {
    const { commands, openFile } = setup();
    await commands.execute("help.showLogs");
    expect(openFile).toHaveBeenCalledWith("C:/My Apps/OpenMind Studio/logs/openmind-studio.log");
  });

  it("Open Logs Folder opens the logs folder in the file manager", async () => {
    const { commands, ipc } = setup();
    await commands.execute("help.openLogsFolder");
    expect(ipc.panelOpenFolder).toHaveBeenCalledWith("C:/My Apps/OpenMind Studio/logs");
  });

  it("says why when it could not do it, instead of failing silently", async () => {
    const { commands, errors } = setup({
      aboutInfo: vi.fn().mockRejectedValue("backend gone"),
    });
    await commands.execute("help.showLogs");
    await commands.execute("help.openLogsFolder");
    expect(errors).toEqual([
      "Couldn't open the log file: backend gone",
      "Couldn't open the logs folder: backend gone",
    ]);
  });

  it("builds the log path with forward slashes and no doubled separator", () => {
    expect(logFilePath({ logsDir: "C:/a/logs/" })).toBe("C:/a/logs/openmind-studio.log");
  });
});
