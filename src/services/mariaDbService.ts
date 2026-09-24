import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient, RunEvent, ServiceInfo } from "./ipc";
import type { OutputService } from "./outputService";
import { stamped } from "./outputService";
import type { PanelService } from "./panelService";
import { validatePort } from "./phpServerService";
import type { PortsService } from "./portsService";
import type { Availability, RuntimeService } from "./runtimeService";

export const MARIADB_CHANNEL = "MariaDB";
export const MARIADB_PORT_SOURCE = "mariadb";
export const DEFAULT_MARIADB_PORT = 3307;
export const MARIADB_USER = "root";
const SETTINGS_KEY = "mariadb.config";

export type DatabaseStatus =
  "notInstalled" | "needsInit" | "stopped" | "starting" | "running" | "error";

export type DatabaseBusy = "initializing" | "starting" | "stopping";

export interface MariaDbState {
  port: number;
  initialized: boolean;
  hasPassword: boolean;
  dataDir: string;
  logDir: string;
  configFile: string;
  server: ServiceInfo | null;
  busy: DatabaseBusy | null;
  error: string | null;
  /** The password, once the user asked to see or copy it (never fetched before). */
  password: string | null;
  passwordVisible: boolean;
  portFree: boolean | null;
}

const INITIAL: MariaDbState = {
  port: DEFAULT_MARIADB_PORT,
  initialized: false,
  hasPassword: false,
  dataDir: "",
  logDir: "",
  configFile: "",
  server: null,
  busy: null,
  error: null,
  password: null,
  passwordVisible: false,
  portFree: null,
};

export interface DatabaseInput {
  installed: boolean;
  healthy: boolean;
  initialized: boolean;
  running: boolean;
  busy: DatabaseBusy | null;
  portFree: boolean | null;
  port: number;
}

/** Pure: the label the Database section shows. */
export function databaseStatus(input: DatabaseInput & { error: string | null }): DatabaseStatus {
  if (input.error !== null && !input.running) return "error";
  if (!input.installed) return "notInstalled";
  if (input.busy === "starting") return "starting";
  if (input.running) return "running";
  return input.initialized ? "stopped" : "needsInit";
}

export function startDatabaseAvailability(input: DatabaseInput): Availability {
  if (!input.installed) return { enabled: false, reason: "MariaDB runtime is not installed yet." };
  if (!input.healthy) {
    return { enabled: false, reason: "The MariaDB install is damaged — repair it first." };
  }
  if (!input.initialized) return { enabled: false, reason: "Initialize the database first." };
  if (input.running) return { enabled: false, reason: "MariaDB is already running." };
  if (input.busy !== null) return { enabled: false, reason: "Please wait — MariaDB is busy." };
  if (input.portFree === false) {
    return {
      enabled: false,
      reason: `Port ${String(input.port)} is already in use. Choose another port.`,
    };
  }
  return { enabled: true };
}

/**
 * The Database section's brain: portable MariaDB as a normal child process
 * (no Windows service) on 127.0.0.1 — initialize, start, stop, restart, the
 * generated root password (shown or copied only on request) and its log. The
 * backend owns the truth (both windows read it and re-read on `mariadb:changed`),
 * and nothing ever starts on launch.
 */
export class MariaDbService {
  private state: MariaDbState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private offs: (() => void)[] = [];

  constructor(
    private readonly ipc: IpcClient,
    private readonly events: EventBus<AppEvents>,
    private readonly output: OutputService,
    private readonly runtime: RuntimeService,
    private readonly ports: PortsService,
    private readonly panel: PanelService,
  ) {}

  getState(): MariaDbState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async initialize(): Promise<void> {
    const saved = parsePort(await this.ipc.settingsGet(SETTINGS_KEY).catch(() => null));
    if (saved !== null) this.update({ port: saved });
    try {
      this.offs.push(
        await this.ipc.onMariadbEvent((event) => {
          this.handleEvent(event);
        }),
        await this.ipc.onMariadbChanged(() => {
          void this.refresh();
        }),
      );
    } catch (error) {
      this.events.emit("appError", { message: `MariaDB output unavailable: ${String(error)}` });
    }
    await this.refresh();
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
  }

  // --- What the section shows ---

  installed(): { version: string; healthy: boolean } | null {
    const status = this.runtime.getState().runtimes.find((entry) => entry.id === "mariadb");
    const pick = status?.installed.find((entry) => entry.active) ?? status?.installed[0];
    return pick ? { version: pick.version, healthy: pick.healthy } : null;
  }

  private input(): DatabaseInput {
    const installed = this.installed();
    return {
      installed: installed !== null,
      healthy: installed?.healthy ?? false,
      initialized: this.state.initialized,
      running: this.state.server !== null,
      busy: this.state.busy,
      portFree: this.state.portFree,
      port: this.state.port,
    };
  }

  status(): DatabaseStatus {
    return databaseStatus({ ...this.input(), error: this.state.error });
  }

  isRunning(): boolean {
    return this.state.server !== null;
  }

  startState(): Availability {
    return startDatabaseAvailability(this.input());
  }

  initializeState(): Availability {
    const input = this.input();
    if (!input.installed)
      return { enabled: false, reason: "MariaDB runtime is not installed yet." };
    if (!input.healthy) {
      return { enabled: false, reason: "The MariaDB install is damaged — repair it first." };
    }
    if (input.running) return { enabled: false, reason: "Stop MariaDB before initializing it." };
    if (input.initialized) {
      return { enabled: false, reason: "The database is already initialized." };
    }
    if (input.busy !== null) return { enabled: false, reason: "Please wait — MariaDB is busy." };
    return { enabled: true };
  }

  stopState(): Availability {
    if (this.state.server === null) return { enabled: false, reason: "MariaDB isn't running." };
    return this.state.busy === "stopping"
      ? { enabled: false, reason: "MariaDB is already stopping." }
      : { enabled: true };
  }

  restartState(): Availability {
    return this.state.server === null
      ? { enabled: false, reason: "MariaDB isn't running." }
      : this.stopState();
  }

  passwordState(): Availability {
    return this.state.hasPassword
      ? { enabled: true }
      : { enabled: false, reason: "No password yet — initialize the database first." };
  }

  passwordStatusLabel(): string {
    return this.state.hasPassword
      ? "Generated when the database was initialized (stored encrypted for your Windows account)"
      : "Not set — initialize the database first";
  }

  // --- Actions ---

  async setPort(text: string): Promise<string | null> {
    const result = validatePort(text);
    if ("error" in result) return result.error;
    this.update({ port: result.port, error: null });
    await this.ipc
      .settingsSet(SETTINGS_KEY, JSON.stringify({ port: result.port }))
      .catch(() => undefined);
    await this.refreshPort();
    return null;
  }

  async refreshPort(): Promise<void> {
    if (this.state.server !== null) {
      this.update({ portFree: null });
      return;
    }
    const port = this.state.port;
    const free: boolean | null = (await this.ipc.phpPortFree(port).catch(() => null)) ?? null;
    if (port === this.state.port) this.update({ portFree: free });
  }

  /** Adopts the backend's view: initialized?, running?, paths. */
  async refresh(): Promise<void> {
    const status = await this.ipc.mariadbStatus().catch(() => null);
    if (!status) return;
    const previous = this.state.server;
    this.update({
      initialized: status.initialized,
      hasPassword: status.hasPassword,
      dataDir: status.dataDir,
      logDir: status.logDir,
      configFile: status.configFile,
      server: status.running,
    });
    if (status.running !== null) {
      this.ports.register({
        port: status.running.port,
        label: status.running.ready ? "MariaDB" : "MariaDB (starting)",
        url: null,
        source: MARIADB_PORT_SOURCE,
      });
    } else if (previous !== null) {
      this.ports.unregisterSource(MARIADB_PORT_SOURCE);
    }
    if (status.running === null) await this.refreshPort();
  }

  async initializeDatabase(): Promise<boolean> {
    const availability = this.initializeState();
    if (!availability.enabled) return this.fail(availability.reason ?? "Can't initialize.");
    this.update({ busy: "initializing", error: null });
    this.log("[MariaDB] Initializing the database…");
    try {
      await this.ipc.mariadbInitialize();
      this.log("[MariaDB] Database initialized.");
      await this.refresh();
      return true;
    } catch (error) {
      this.log(`[MariaDB] ${String(error)}`);
      return this.fail(String(error));
    } finally {
      this.update({ busy: null });
    }
  }

  async start(): Promise<boolean> {
    const availability = this.startState();
    if (!availability.enabled) return this.fail(availability.reason ?? "MariaDB can't start.");
    this.update({ busy: "starting", error: null });
    try {
      const info = await this.ipc.mariadbStart(this.state.port);
      this.update({ server: info, portFree: null });
      this.ports.register({
        port: info.port,
        label: "MariaDB (starting)",
        url: null,
        source: MARIADB_PORT_SOURCE,
      });
      return true;
    } catch (error) {
      this.log(`[MariaDB] ${String(error)}`);
      await this.refreshPort();
      return this.fail(String(error));
    } finally {
      this.update({ busy: null });
    }
  }

  async stop(): Promise<boolean> {
    if (!this.stopState().enabled) return false;
    this.update({ busy: "stopping", error: null });
    try {
      await this.ipc.mariadbStop();
      await this.refresh();
      return true;
    } catch (error) {
      return this.fail(`Couldn't stop MariaDB: ${String(error)}`);
    } finally {
      this.update({ busy: null });
    }
  }

  async restart(): Promise<boolean> {
    if (!this.restartState().enabled) return false;
    if (!(await this.stop())) return false;
    return this.start();
  }

  async openLogs(): Promise<void> {
    this.output.ensureChannel(MARIADB_CHANNEL);
    this.output.select(MARIADB_CHANNEL);
    await this.panel.show("output");
  }

  /** Shows or hides the password (fetching it the first time it is asked for). */
  async togglePassword(): Promise<void> {
    if (this.state.passwordVisible) {
      this.update({ passwordVisible: false });
      return;
    }
    const { password } = await this.loadPassword();
    if (password !== null) this.update({ passwordVisible: true });
  }

  async copyPassword(): Promise<boolean> {
    const { password, failed } = await this.loadPassword();
    if (password === null) {
      return failed ? false : this.fail("There is no password to copy yet.");
    }
    await this.ipc.clipboardWriteText(password);
    return true;
  }

  private async loadPassword(): Promise<{ password: string | null; failed: boolean }> {
    if (this.state.password !== null) return { password: this.state.password, failed: false };
    try {
      const credentials = await this.ipc.mariadbCredentials();
      const password = credentials.password;
      if (password !== null) this.update({ password });
      return { password, failed: false };
    } catch (error) {
      // e.g. the stored password was encrypted by another Windows user: say so instead of "no password".
      this.fail(String(error));
      return { password: null, failed: true };
    }
  }

  // --- Internals ---

  private handleEvent(event: RunEvent): void {
    if (event.type === "started") {
      this.log(`[MariaDB] ${event.commandLine}`);
      this.output.append(MARIADB_CHANNEL, `runtime: ${event.runtime}`);
      this.output.append(MARIADB_CHANNEL, `resolved: ${event.resolved}`);
      this.output.append(MARIADB_CHANNEL, `port: ${String(this.state.port)} (127.0.0.1 only)`);
      this.output.append(MARIADB_CHANNEL, "");
      return;
    }
    if (event.type === "output") {
      this.output.append(MARIADB_CHANNEL, event.line);
      return;
    }
    const summary = event.stopped
      ? "MariaDB stopped."
      : `MariaDB exited with code ${event.code === null ? "unknown" : String(event.code)}.`;
    this.log(`[MariaDB] ${summary}`);
    if (!event.stopped && event.code !== 0) {
      this.update({ error: `${summary} See the MariaDB log.` });
    }
  }

  private log(message: string): void {
    this.output.append(MARIADB_CHANNEL, stamped(message));
  }

  private fail(message: string): false {
    this.update({ error: message });
    this.events.emit("appError", { message });
    return false;
  }

  private update(patch: Partial<MariaDbState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

function parsePort(saved: string | null): number | null {
  if (saved === null) return null;
  try {
    const value: unknown = JSON.parse(saved);
    const port = (value as { port?: unknown } | null)?.port;
    return typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535
      ? port
      : null;
  } catch {
    return null;
  }
}
