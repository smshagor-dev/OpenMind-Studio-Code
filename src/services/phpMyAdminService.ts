import type { ServersState } from "./state/canonicalIpc";
import type { CanonicalFeed } from "./state/canonicalStateService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient, RunEvent, ServiceInfo } from "./ipc";
import type { MariaDbService } from "./mariaDbService";
import type { OutputService } from "./outputService";
import { stamped } from "./outputService";
import type { PanelService } from "./panelService";
import type { PhpServerService } from "./phpServerService";
import { validatePort } from "./phpServerService";
import type { Availability, RuntimeService } from "./runtimeService";

export const PMA_CHANNEL = "phpMyAdmin";
export const PMA_PORT_SOURCE = "phpmyadmin";
export const DEFAULT_PMA_PORT = 8081;
const SETTINGS_KEY = "phpmyadmin.config";

export interface PhpMyAdminState {
  port: number;
  server: ServiceInfo | null;
  busy: boolean;
  error: string | null;
  portFree: boolean | null;
}

const INITIAL: PhpMyAdminState = {
  port: DEFAULT_PMA_PORT,
  server: null,
  busy: false,
  error: null,
  portFree: null,
};

export interface PmaStartInput {
  phpInstalled: boolean;
  pmaInstalled: boolean;
  pmaHealthy: boolean;
  mariadbInstalled: boolean;
  running: boolean;
  busy: boolean;
  portFree: boolean | null;
  port: number;
}

/** Pure: whether Start phpMyAdmin can work, and if not, why. */
export function pmaStartAvailability(input: PmaStartInput): Availability {
  if (!input.pmaInstalled) return { enabled: false, reason: "phpMyAdmin is not installed yet." };
  if (!input.pmaHealthy) {
    return { enabled: false, reason: "The phpMyAdmin install is damaged — repair it first." };
  }
  if (!input.phpInstalled) return { enabled: false, reason: "PHP runtime is not installed yet." };
  if (!input.mariadbInstalled) {
    return { enabled: false, reason: "MariaDB runtime is not installed yet." };
  }
  if (input.running) return { enabled: false, reason: "phpMyAdmin is already running." };
  if (input.busy) return { enabled: false, reason: "Please wait — phpMyAdmin is busy." };
  if (input.portFree === false) {
    return {
      enabled: false,
      reason: `Port ${String(input.port)} is already in use. Choose another port.`,
    };
  }
  return { enabled: true };
}

/**
 * phpMyAdmin, served by the active portable PHP's built-in server on
 * 127.0.0.1 and pointed at the portable MariaDB (login is by cookie: the root
 * password is typed, never written into a file). Started only on request; it
 * keeps the PHP it started with when the active PHP changes.
 */
export class PhpMyAdminService {
  private state: PhpMyAdminState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private offs: (() => void)[] = [];
  /** The canonical servers state (`src/services/state`). */
  private canonical: CanonicalFeed<ServersState> | null = null;

  constructor(
    private readonly ipc: IpcClient,
    private readonly events: EventBus<AppEvents>,
    private readonly output: OutputService,
    private readonly runtime: RuntimeService,
    private readonly panel: PanelService,
    private readonly php: PhpServerService,
    private readonly database: MariaDbService,
  ) {}

  getState(): PhpMyAdminState {
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
        await this.ipc.onPmaEvent((event) => {
          this.handleEvent(event);
        }),
      );
    } catch (error) {
      this.events.emit("appError", { message: `phpMyAdmin output unavailable: ${String(error)}` });
    }
    await this.refresh();
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
  }

  // --- What the section shows ---

  private install(id: string): { version: string; healthy: boolean } | null {
    const status = this.runtime.getState().runtimes.find((entry) => entry.id === id);
    const pick = status?.installed.find((entry) => entry.active) ?? status?.installed[0];
    return pick ? { version: pick.version, healthy: pick.healthy } : null;
  }

  installedVersion(): string | null {
    return this.install("phpmyadmin")?.version ?? null;
  }

  isRunning(): boolean {
    return this.state.server !== null;
  }

  url(): string | null {
    return this.state.server?.url ?? null;
  }

  startState(): Availability {
    const pma = this.install("phpmyadmin");
    const php = this.install("php");
    return pmaStartAvailability({
      phpInstalled: php !== null,
      pmaInstalled: pma !== null,
      pmaHealthy: pma?.healthy ?? false,
      mariadbInstalled: this.install("mariadb") !== null,
      running: this.state.server !== null,
      busy: this.state.busy,
      portFree: this.state.portFree,
      port: this.state.port,
    });
  }

  stopState(): Availability {
    return this.state.server === null
      ? { enabled: false, reason: "phpMyAdmin isn't running." }
      : { enabled: true };
  }

  openState(): Availability {
    return this.state.server === null
      ? { enabled: false, reason: "Start phpMyAdmin first — there is no URL yet." }
      : { enabled: true };
  }

  /** MariaDB isn't running: phpMyAdmin starts, but logging in will fail. */
  databaseNote(): string | null {
    return this.state.server !== null && !this.database.isRunning()
      ? "MariaDB isn't running — phpMyAdmin can't log in until you start it."
      : null;
  }

  /** The PHP it started with is no longer the active one. */
  restartNotice(): string | null {
    const running = this.state.server?.phpVersion ?? null;
    const active = this.install("php");
    const activeVersion = this.runtime
      .getState()
      .runtimes.find((entry) => entry.id === "php")
      ?.installed.find((entry) => entry.active)?.version;
    if (running === null || active === null || activeVersion === undefined) return null;
    if (running === activeVersion) return null;
    return `Restart phpMyAdmin to use the new PHP version. It is still running on PHP ${running}; PHP ${activeVersion} is now active.`;
  }

  // --- Actions ---

  async setPort(text: string): Promise<string | null> {
    const result = validatePort(text);
    if ("error" in result) return result.error;
    if (result.port === this.database.getState().port) {
      return "That port is used by MariaDB — choose another one.";
    }
    if (result.port === this.php.getState().port) {
      return "That port is used by the PHP server — choose another one.";
    }
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

  /** Follows the canonical servers state: whether phpMyAdmin runs (PID, port, address), the same in every window. */
  useCanonical(feed: CanonicalFeed<ServersState>): () => void {
    this.canonical = feed;
    const apply = (servers: ServersState | undefined) => {
      if (servers === undefined) return;
      const running = servers.mysql.phpmyadmin;
      const stopped = this.state.server !== null && running === null;
      this.update({ server: running });
      if (stopped) void this.refreshPort();
    };
    const off = feed.subscribe(apply);
    apply(feed.current());
    return () => {
      off();
      this.canonical = null;
    };
  }

  /** Waits until this window has every server change the backend made so far. */
  async refresh(): Promise<void> {
    await this.canonical?.catchUp();
    if (this.state.server === null) await this.refreshPort();
  }

  async start(): Promise<boolean> {
    const availability = this.startState();
    if (!availability.enabled) return this.fail(availability.reason ?? "Can't start.");
    this.update({ busy: true, error: null });
    try {
      const info = await this.ipc.pmaStart(this.state.port, this.database.getState().port);
      this.update({ server: info, portFree: null });
      return true;
    } catch (error) {
      this.output.append(PMA_CHANNEL, stamped(`[phpMyAdmin] ${String(error)}`));
      await this.refreshPort();
      return this.fail(String(error));
    } finally {
      this.update({ busy: false });
    }
  }

  async stop(): Promise<boolean> {
    if (!this.stopState().enabled) return false;
    try {
      await this.ipc.pmaStop();
      await this.refresh();
      return true;
    } catch (error) {
      return this.fail(`Couldn't stop phpMyAdmin: ${String(error)}`);
    }
  }

  async open(): Promise<boolean> {
    const url = this.url();
    if (url === null) return false;
    try {
      await this.ipc.openExternalUrl(url);
      return true;
    } catch (error) {
      return this.fail(`Couldn't open the browser: ${String(error)}`);
    }
  }

  async openLogs(): Promise<void> {
    this.output.ensureChannel(PMA_CHANNEL);
    this.output.select(PMA_CHANNEL);
    await this.panel.show("output");
  }

  // --- Internals ---

  private handleEvent(event: RunEvent): void {
    if (event.type === "started") {
      this.output.append(PMA_CHANNEL, stamped(`[phpMyAdmin] ${event.commandLine}`));
      this.output.append(PMA_CHANNEL, `runtime: ${event.runtime}`);
      this.output.append(PMA_CHANNEL, "");
      return;
    }
    if (event.type === "output") {
      this.output.append(PMA_CHANNEL, event.line);
      return;
    }
    this.output.append(
      PMA_CHANNEL,
      stamped(event.stopped ? "[phpMyAdmin] Stopped." : "[phpMyAdmin] Exited."),
    );
  }

  private fail(message: string): false {
    this.update({ error: message });
    this.events.emit("appError", { message });
    return false;
  }

  private update(patch: Partial<PhpMyAdminState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

function parsePort(saved: string | null): number | null {
  if (saved === null) return null;
  try {
    const port = (JSON.parse(saved) as { port?: unknown } | null)?.port;
    return typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535
      ? port
      : null;
  } catch {
    return null;
  }
}
