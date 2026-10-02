import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient, MySqlState, MySqlStatus } from "./ipc";
import type { OutputService } from "./outputService";
import { stamped } from "./outputService";
import type { Availability, RuntimeService } from "./runtimeService";

export const MYSQL_CHANNEL = "MySQL";

/** The words the control panel shows (English; translated where they are drawn). */
export const MYSQL_LABELS: Record<MySqlState, string> = {
  notInstalled: "Not installed",
  initializing: "Initializing…",
  starting: "Starting…",
  running: "Running",
  stopping: "Stopping…",
  stopped: "Stopped",
  error: "Error",
};

export type MySqlAction = "start" | "stop" | "restart";

export interface MySqlServiceState {
  status: MySqlStatus | null;
  /** An action this window started and is waiting for. */
  busy: MySqlAction | null;
}

/** Pure: whether Start can run, and why not. */
export function mySqlStartAvailability(status: MySqlStatus | null, busy: MySqlAction | null): Availability {
  if (status === null) return { enabled: false, reason: "Reading the MySQL status…" };
  if (busy !== null || ["initializing", "starting", "stopping"].includes(status.state)) {
    return { enabled: false, reason: "Please wait — MySQL is busy." };
  }
  if (status.missing.length > 0) {
    return {
      enabled: false,
      reason: `Not installed yet: ${status.missing.join(", ")}. Install it with Config > Install.`,
    };
  }
  if (status.state === "running") return { enabled: false, reason: "MySQL is already running." };
  return { enabled: true };
}

/** Something of the stack is up (all of it, or half after a failure), so Stop has work to do. */
export function mySqlHasProcesses(status: MySqlStatus | null): boolean {
  return status !== null && (status.mariadb !== null || status.phpmyadmin !== null);
}

/**
 * MySQL in the PHP Server window: MariaDB (the MySQL-compatible server) and phpMyAdmin as one service. Start, Stop and
 * Restart are single backend commands that run the whole sequence (create the database when there is none, start
 * MariaDB, wait until it accepts connections, start phpMyAdmin, check it reaches the database); this service shows the
 * backend's status, re-reading it on every change, and gives each button its reason. Nothing starts on launch.
 */
export class MySqlService {
  private state: MySqlServiceState = { status: null, busy: null };
  private readonly listeners = new Set<() => void>();
  private offs: (() => void)[] = [];

  constructor(
    private readonly ipc: IpcClient,
    private readonly events: EventBus<AppEvents>,
    private readonly output: OutputService,
    private readonly runtime: RuntimeService,
  ) {}

  getState = (): MySqlServiceState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async initialize(): Promise<void> {
    const refresh = () => {
      void this.refresh();
    };
    try {
      this.offs.push(
        await this.ipc.onMysqlChanged(refresh),
        await this.ipc.onMariadbChanged(refresh),
        await this.ipc.onPmaChanged(refresh),
      );
    } catch (error) {
      this.events.emit("appError", { message: `MySQL status unavailable: ${String(error)}` });
    }
    // Installing or removing MariaDB, phpMyAdmin or PHP changes what is missing.
    this.offs.push(this.runtime.subscribe(refresh));
    await this.refresh();
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
  }

  async refresh(): Promise<void> {
    const status = await this.ipc.mysqlStatus().catch(() => null);
    if (status !== null) this.update({ status });
  }

  // --- What the row shows ---

  label(): string {
    const status = this.state.status;
    if (this.state.busy === "stop") return MYSQL_LABELS.stopping;
    if (this.state.busy !== null && status?.state !== "initializing") return MYSQL_LABELS.starting;
    return status === null ? MYSQL_LABELS.stopped : MYSQL_LABELS[status.state];
  }

  isRunning(): boolean {
    return this.state.status?.state === "running";
  }

  /** "MariaDB 11.8.9 · phpMyAdmin 5.2.3 · 127.0.0.1:3306" — the engine is named for what it is. */
  details(): string {
    const status = this.state.status;
    if (status === null) return "";
    const parts = [
      status.mariadbVersion === null ? "MariaDB not installed" : `MariaDB ${status.mariadbVersion}`,
      status.phpmyadminVersion === null ? "phpMyAdmin not installed" : `phpMyAdmin ${status.phpmyadminVersion}`,
    ];
    if (status.mariadb !== null) parts.push(`127.0.0.1:${String(status.mariadb.port)}`);
    return parts.join(" · ");
  }

  /** The ports in use: "3306, 8081". */
  ports(): string {
    const status = this.state.status;
    return [status?.mariadb?.port, status?.phpmyadmin?.port]
      .filter((port): port is number => port !== undefined)
      .join(", ");
  }

  pid(): number | null {
    return this.state.status?.mariadb?.run.pid ?? this.state.status?.phpmyadmin?.run.pid ?? null;
  }

  error(): string | null {
    return this.state.status?.error ?? null;
  }

  startState(): Availability {
    return mySqlStartAvailability(this.state.status, this.state.busy);
  }

  stopState(): Availability {
    if (this.state.busy !== null) return { enabled: false, reason: "Please wait — MySQL is busy." };
    return mySqlHasProcesses(this.state.status)
      ? { enabled: true }
      : { enabled: false, reason: "MySQL isn't running." };
  }

  restartState(): Availability {
    const stop = this.stopState();
    return stop.enabled ? this.startStateIgnoringRunning() : stop;
  }

  /** Open phpMyAdmin starts MySQL first when it is stopped, so it needs what Start needs. */
  adminState(): Availability {
    if (this.isRunning()) return { enabled: true };
    return this.startState();
  }

  // --- Actions ---

  start(): Promise<boolean> {
    return this.act("start", () => this.ipc.mysqlStart());
  }

  stop(): Promise<boolean> {
    return this.act("stop", () => this.ipc.mysqlStop());
  }

  restart(): Promise<boolean> {
    return this.act("restart", () => this.ipc.mysqlRestart());
  }

  /** Opens phpMyAdmin in the browser, starting MySQL first when it isn't running. */
  async openAdmin(): Promise<boolean> {
    if (!this.isRunning()) {
      if (!this.adminState().enabled) return false;
      if (!(await this.start())) return false;
    }
    const url = this.state.status?.phpmyadmin?.url ?? null;
    if (url === null) return false;
    try {
      await this.ipc.openExternalUrl(url);
      return true;
    } catch (error) {
      this.fail(`Couldn't open the browser: ${String(error)}`);
      return false;
    }
  }

  // --- Internals ---

  private startStateIgnoringRunning(): Availability {
    const status = this.state.status;
    if (status !== null && status.missing.length > 0) return mySqlStartAvailability(status, null);
    return { enabled: true };
  }

  private async act(action: MySqlAction, call: () => Promise<MySqlStatus>): Promise<boolean> {
    if (this.state.busy !== null) return false;
    const available = action === "start" ? this.startState() : action === "stop" ? this.stopState() : this.restartState();
    if (!available.enabled) return false;
    this.update({ busy: action });
    this.log(action === "stop" ? "Stopping MySQL (phpMyAdmin, then MariaDB)…" : "Starting MySQL…");
    try {
      const status = await call();
      this.update({ status });
      this.log(action === "stop" ? "MySQL stopped." : `MySQL is running: ${this.details()}.`);
      return true;
    } catch (error) {
      this.fail(String(error).replace(/^Error: /, ""));
      await this.refresh();
      return false;
    } finally {
      this.update({ busy: null });
    }
  }

  private log(message: string): void {
    this.output.append(MYSQL_CHANNEL, stamped(message));
  }

  private fail(message: string): void {
    this.log(message);
    this.events.emit("appError", { message });
  }

  private update(patch: Partial<MySqlServiceState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
