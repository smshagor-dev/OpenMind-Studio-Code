import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient, ListeningPort, PanelModule } from "./ipc";
import type { MariaDbService } from "./mariaDbService";
import type { OutputService } from "./outputService";
import type { PhpMyAdminService } from "./phpMyAdminService";
import type { PhpServerService } from "./phpServerService";
import type { Availability } from "./runtimeService";
import { t } from "../i18n";

export type ModuleId = PanelModule;
export type PanelPage = "main" | "config" | "netstat" | "help";

/** The three modules, in the order the table lists them. */
export const MODULE_IDS: readonly ModuleId[] = ["php", "mariadb", "phpmyadmin"];

export const MODULE_NAMES: Record<ModuleId, string> = {
  php: "PHP Server",
  mariadb: "MariaDB",
  phpmyadmin: "phpMyAdmin",
};

/** Output channel → the tag the log shows (Composer has a channel but no row). */
const CHANNEL_TAGS: Record<string, string> = {
  "PHP Server": "PHP Server",
  MariaDB: "MariaDB",
  phpMyAdmin: "phpMyAdmin",
  Composer: "Composer",
};

/** How many log lines the panel keeps. */
export const MAX_PANEL_LOG_LINES = 500;

export interface PanelLogLine {
  id: number;
  time: string;
  tag: string;
  text: string;
}

export interface ModuleRow {
  id: ModuleId;
  name: string;
  running: boolean;
  /** `null` while stopped. */
  pid: number | null;
  /** e.g. "8000" or "" while stopped. */
  ports: string;
  status: string;
  /** Start when stopped, Stop when running. */
  toggle: { label: "Start" | "Stop"; availability: Availability };
  admin: Availability;
  config: Availability;
}

export interface NetstatState {
  rows: readonly ListeningPort[];
  loading: boolean;
  error: string | null;
  loadedAt: string | null;
}

export interface ControlPanelState {
  page: PanelPage;
  /** Show only this module's lines in the log, or all when `null`. */
  filter: ModuleId | null;
  lines: readonly PanelLogLine[];
  configPaths: Record<ModuleId, string | null>;
  netstat: NetstatState;
}

const INITIAL: ControlPanelState = {
  page: "main",
  filter: null,
  lines: [],
  configPaths: { php: null, mariadb: null, phpmyadmin: null },
  netstat: { rows: [], loading: false, error: null, loadedAt: null },
};

/** `10:58:02 AM` — the time format of XAMPP's control panel log. */
export function clockTime(now: Date): string {
  return now.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

/** Drops the `[HH:MM:SS] ` stamp services put on their lines (the panel shows its own clock). */
export function withoutStamp(line: string): string {
  return line.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, "");
}

/** Drops a leading `[Tag] ` that repeats the tag the panel shows itself. */
export function withoutTag(tag: string, line: string): string {
  const prefix = `[${tag}] `;
  return line.startsWith(prefix) ? line.slice(prefix.length) : line;
}

/**
 * The PHP Server window as a control panel (XAMPP style): one row per server
 * module with its PID, port and Start/Stop, Admin, Config and Logs buttons, a
 * merged log at the bottom, and the side buttons (Config, Netstat, Shell,
 * Explorer, Help, Quit). It owns no server logic: every action and every
 * disabled reason comes from the module's own service, and the numbers shown
 * (PID, port) are the backend's truth read through those services.
 */
export class ControlPanelService {
  private state: ControlPanelState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private nextId = 1;
  private off: (() => void) | null = null;

  constructor(
    private readonly ipc: IpcClient,
    private readonly events: EventBus<AppEvents>,
    private readonly output: OutputService,
    private readonly php: PhpServerService,
    private readonly mariaDb: MariaDbService,
    private readonly pma: PhpMyAdminService,
    private readonly closeWindow: () => Promise<void>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  getState(): ControlPanelState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Starts collecting log lines and reads the config file locations. Starts nothing else. */
  async initialize(): Promise<void> {
    this.off?.();
    this.off = this.output.onAppend((channel, line) => {
      const tag = CHANNEL_TAGS[channel];
      if (tag !== undefined) this.addLine(tag, withoutTag(tag, withoutStamp(line)));
    });
    this.addLine("main", "Control Panel Ready");
    await this.refreshConfigPaths();
  }

  dispose(): void {
    this.off?.();
    this.off = null;
  }

  // --- What the table shows ---

  rows(): ModuleRow[] {
    return MODULE_IDS.map((id) => this.row(id));
  }

  row(id: ModuleId): ModuleRow {
    const server = this.info(id);
    const running = server !== null;
    return {
      id,
      name: MODULE_NAMES[id],
      running,
      pid: server?.pid ?? null,
      ports: server === null ? "" : String(server.port),
      status: this.statusOf(id),
      toggle: {
        label: running ? "Stop" : "Start",
        availability: running ? this.stopState(id) : this.startState(id),
      },
      admin: this.adminState(id),
      config: this.configState(id),
    };
  }

  private info(id: ModuleId): { pid: number; port: number } | null {
    if (id === "php") {
      const server = this.php.getState().server;
      return server === null ? null : { pid: server.pid, port: server.port };
    }
    const info = id === "mariadb" ? this.mariaDb.getState().server : this.pma.getState().server;
    return info === null ? null : { pid: info.run.pid, port: info.port };
  }

  private statusOf(id: ModuleId): string {
    if (id === "mariadb") {
      const status = this.mariaDb.status();
      if (status === "running") return "Running";
      if (status === "starting") return "Starting…";
      if (status === "error") return "Error";
    }
    return this.info(id) === null ? "Stopped" : "Running";
  }

  private startState(id: ModuleId): Availability {
    if (id === "php") return this.php.startState();
    return id === "mariadb" ? this.mariaDb.startState() : this.pma.startState();
  }

  private stopState(id: ModuleId): Availability {
    if (id === "php") return this.php.stopState();
    return id === "mariadb" ? this.mariaDb.stopState() : this.pma.stopState();
  }

  private adminState(id: ModuleId): Availability {
    if (id === "php") return this.php.browserState();
    const state = this.pma.openState();
    return id === "mariadb" && !state.enabled
      ? {
          enabled: false,
          reason: t("php.reason.mariadbAdmin"),
        }
      : state;
  }

  private configState(id: ModuleId): Availability {
    if (this.state.configPaths[id] !== null) return { enabled: true };
    const reasons: Record<ModuleId, string> = {
      php: t("php.reason.noPhpIni"),
      mariadb: t("php.reason.mariadbConfig"),
      phpmyadmin: t("php.reason.pmaConfig"),
    };
    return { enabled: false, reason: reasons[id] };
  }

  /** Whether the Explorer button can open the web root, and why not. */
  explorerState(): Availability {
    return this.php.getState().root === null
      ? { enabled: false, reason: t("php.reason.chooseWebRoot") }
      : { enabled: true };
  }

  // --- Actions ---

  async toggle(id: ModuleId): Promise<boolean> {
    const row = this.row(id);
    if (!row.toggle.availability.enabled) return false;
    this.addLine(row.name, row.running ? "Stopping…" : "Starting…");
    const ok = await this.runToggle(id, row.running);
    await this.refreshConfigPaths();
    return ok;
  }

  private runToggle(id: ModuleId, running: boolean): Promise<boolean> {
    if (id === "php") return running ? this.php.stop() : this.php.start();
    if (id === "mariadb") return running ? this.mariaDb.stop() : this.mariaDb.start();
    return running ? this.pma.stop() : this.pma.start();
  }

  async admin(id: ModuleId): Promise<boolean> {
    if (!this.adminState(id).enabled) return false;
    return id === "php" ? this.php.openBrowser() : this.pma.open();
  }

  async config(id: ModuleId): Promise<boolean> {
    const path = this.state.configPaths[id];
    if (path === null) return false;
    return this.run(`Couldn't open the ${MODULE_NAMES[id]} config`, () =>
      this.ipc.panelOpenFile(path),
    );
  }

  /** Logs button: show only this module's lines, or all again when it is already the filter. */
  toggleFilter(id: ModuleId): void {
    this.update({ filter: this.state.filter === id ? null : id });
  }

  setPage(page: PanelPage): void {
    this.update({ page });
    if (page === "netstat") void this.refreshNetstat();
    if (page === "main") void this.refreshConfigPaths();
  }

  async openExplorer(): Promise<boolean> {
    const root = this.php.getState().root;
    if (root === null) return false;
    return this.run("Couldn't open the folder", () => this.ipc.panelOpenFolder(root));
  }

  async openShell(): Promise<boolean> {
    const root = this.php.getState().root;
    const ok = await this.run("Couldn't open a shell", () => this.ipc.panelOpenShell(root));
    if (ok) this.addLine("main", "Opened a shell with the portable runtimes first on PATH");
    return ok;
  }

  async quit(): Promise<void> {
    await this.closeWindow();
  }

  clearLog(): void {
    this.update({ lines: [] });
  }

  async refreshConfigPaths(): Promise<void> {
    const entries = await Promise.all(
      MODULE_IDS.map(
        async (id) => [id, await this.ipc.panelConfigPath(id).catch(() => null)] as const,
      ),
    );
    this.update({
      configPaths: Object.fromEntries(entries) as Record<ModuleId, string | null>,
    });
  }

  async refreshNetstat(): Promise<void> {
    this.update({ netstat: { ...this.state.netstat, loading: true, error: null } });
    try {
      const rows = await this.ipc.panelNetstat();
      this.update({
        netstat: { rows, loading: false, error: null, loadedAt: clockTime(this.now()) },
      });
    } catch (error) {
      this.update({
        netstat: { ...this.state.netstat, loading: false, error: String(error) },
      });
    }
  }

  /** Which of our modules owns this PID, for highlighting it in Netstat. */
  ownerOf(pid: number): string | null {
    const row = this.rows().find((entry) => entry.pid === pid);
    return row?.name ?? null;
  }

  /** The lines the log shows: all, or one module's (plus the panel's own notes never hide). */
  visibleLines(): readonly PanelLogLine[] {
    const filter = this.state.filter;
    if (filter === null) return this.state.lines;
    return this.state.lines.filter(
      (line) => line.tag === MODULE_NAMES[filter] || line.tag === "main",
    );
  }

  // --- Internals ---

  private async run(message: string, action: () => Promise<void>): Promise<boolean> {
    try {
      await action();
      return true;
    } catch (error) {
      const text = `${message}: ${String(error)}`;
      this.addLine("main", text);
      this.events.emit("appError", { message: text });
      return false;
    }
  }

  private addLine(tag: string, text: string): void {
    const line: PanelLogLine = { id: this.nextId++, time: clockTime(this.now()), tag, text };
    const lines = [...this.state.lines, line];
    this.update({
      lines: lines.length > MAX_PANEL_LOG_LINES ? lines.slice(-MAX_PANEL_LOG_LINES) : lines,
    });
  }

  private update(patch: Partial<ControlPanelState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
