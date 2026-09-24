import type { CommandRegistry } from "./commandRegistry";
import type { PhpServerService } from "./phpServerService";
import type { IpcClient } from "./ipc";

/**
 * The PHP Server's commands. Each is enabled only when it can work (the same
 * predicates give the panel's buttons their disabled reasons), so a command
 * palette or shortcut can never do something the panel would refuse.
 */
export function registerPhpCommands(
  commands: CommandRegistry,
  php: PhpServerService,
  ipc: Pick<IpcClient, "phpWindowOpen">,
): void {
  // The PHP Server lives in its own window (not the side bar); both entries open it.
  for (const id of ["php.openWindow", "view.showPhpServer"]) {
    commands.register(id, async () => {
      await ipc.phpWindowOpen();
    });
  }
  commands.register(
    "php.startServer",
    async () => {
      await php.start();
    },
    { enabled: () => php.startState().enabled },
  );
  commands.register(
    "php.stopServer",
    async () => {
      await php.stop();
    },
    { enabled: () => php.stopState().enabled },
  );
  commands.register(
    "php.restartServer",
    async () => {
      await php.restart();
    },
    { enabled: () => php.restartState().enabled },
  );
  commands.register(
    "php.openBrowser",
    async () => {
      await php.openBrowser();
    },
    { enabled: () => php.browserState().enabled },
  );
  commands.register("php.openLogs", async () => {
    await php.openLogs();
  });
}
