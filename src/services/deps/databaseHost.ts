import type { IpcClient } from "../ipc";
import type { MySqlService } from "../mySqlService";
import { connectionSettings } from "../phpConfigModel";
import type { DatabaseHost } from "./dependencyService";

/** The database card's view of OpenMind's MySQL: state and port from `MySqlService`, actions through it. */
export function databaseHost(
  mySql: Pick<MySqlService, "getState" | "subscribe" | "start" | "openAdmin">,
  ipc: Pick<IpcClient, "mariadbCredentials" | "clipboardWriteText">,
  /** Runs a command (`php.openWindow` opens the PHP Server window). */
  run: (command: string) => void,
): DatabaseHost {
  const port = (): number | null => mySql.getState().status?.mariadb?.port ?? null;
  return {
    status: () => {
      const status = mySql.getState().status;
      if (status === null) return { state: "busy", port: null };
      if (status.missing.includes("MariaDB")) return { state: "notInstalled", port: null };
      if (status.state === "running" || status.mariadb?.ready === true) return { state: "running", port: port() };
      if (["initializing", "starting", "stopping"].includes(status.state)) return { state: "busy", port: port() };
      return { state: "stopped", port: null };
    },
    subscribe: (listener) => mySql.subscribe(listener),
    start: () => mySql.start(),
    openAdmin: () => mySql.openAdmin(),
    openPanel: () => {
      run("php.openWindow");
    },
    copySettings: async (database) => {
      const current = port();
      if (current === null) throw new Error("MySQL isn't running.");
      const credentials = await ipc.mariadbCredentials();
      await ipc.clipboardWriteText(connectionSettings(current, credentials.password, database));
    },
  };
}
