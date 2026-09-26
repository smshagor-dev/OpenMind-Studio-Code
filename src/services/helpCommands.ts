import type { CommandRegistry } from "./commandRegistry";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { AboutInfo, IpcClient } from "./ipc";

export interface HelpCommandDeps {
  commands: CommandRegistry;
  events: EventBus<AppEvents>;
  ipc: Pick<IpcClient, "aboutInfo" | "panelOpenFolder">;
  /** Opens a file in an editor tab (the log viewer is the editor itself). */
  openFile: (path: string) => Promise<unknown>;
}

/** The app's own log file inside its logs folder. */
export const APP_LOG_FILE = "openmind-studio.log";

export function logFilePath(info: Pick<AboutInfo, "logsDir">): string {
  return `${info.logsDir.replace(/[\\/]+$/, "")}/${APP_LOG_FILE}`;
}

/**
 * Help > Show Logs (the app's log file, opened as a text tab so it can be searched and scrolled) and Open Logs
 * Folder (the folder in the file manager). Both are local and only run on a click.
 */
export function registerHelpCommands({ commands, events, ipc, openFile }: HelpCommandDeps): void {
  const fail = (what: string, error: unknown) => {
    events.emit("appError", { message: `Couldn't ${what}: ${String(error)}` });
  };
  commands.register("help.showLogs", async () => {
    try {
      const info = await ipc.aboutInfo();
      await openFile(logFilePath(info));
    } catch (error) {
      fail("open the log file", error);
    }
  });
  commands.register("help.openLogsFolder", async () => {
    try {
      const info = await ipc.aboutInfo();
      await ipc.panelOpenFolder(info.logsDir);
    } catch (error) {
      fail("open the logs folder", error);
    }
  });
}
