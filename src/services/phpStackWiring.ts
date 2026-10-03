import { ComposerService } from "./composerService";
import { ControlPanelService } from "./controlPanelService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient } from "./ipc";
import { MariaDbService } from "./mariaDbService";
import { MySqlService } from "./mySqlService";
import type { OutputService } from "./outputService";
import type { PanelService } from "./panelService";
import { PhpMyAdminService } from "./phpMyAdminService";
import { PhpRuntimeService } from "./phpRuntimeService";
import { PhpServerService } from "./phpServerService";
import type { RuntimeService } from "./runtimeService";

export interface PhpStackDeps {
  ipc: IpcClient;
  events: EventBus<AppEvents>;
  output: OutputService;
  runtime: RuntimeService;
  panel: PanelService;
  /** The port a new PHP server starts on (the `php.server.defaultPort` setting). */
  defaultPort: () => number;
  /** Closes this window (the control panel's Quit). */
  closeWindow: () => Promise<void>;
}

/** The PHP Server window's services: PHP's built-in server, MySQL (MariaDB + phpMyAdmin), Composer and the panel. */
export function wirePhpStack(deps: PhpStackDeps) {
  const { ipc, events, output, runtime, panel } = deps;
  const php = new PhpServerService(ipc, events, output, runtime, panel, deps.defaultPort);
  const mariaDb = new MariaDbService(ipc, events, output, runtime, panel);
  const phpMyAdmin = new PhpMyAdminService(ipc, events, output, runtime, panel, php, mariaDb);
  const composer = new ComposerService(ipc, events, output, runtime, panel);
  const phpRuntime = new PhpRuntimeService(runtime, php, { mariadb: mariaDb, pma: phpMyAdmin });
  /** MySQL: MariaDB + phpMyAdmin as one service in the PHP Server window. */
  const mySql = new MySqlService(ipc, events, output);
  const controlPanel = new ControlPanelService(ipc, events, output, php, mySql, deps.closeWindow);
  return { php, mariaDb, phpMyAdmin, composer, phpRuntime, mySql, controlPanel };
}
