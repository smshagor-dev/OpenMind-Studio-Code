import type { ServersState } from "./state/canonicalIpc";
import type { CanonicalFeed } from "./state/canonicalStateService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { InstallProgress, IpcClient, PhpServerInfo, RunEvent, RuntimeStatus } from "./ipc";
import type { OutputService } from "./outputService";
import { stamped } from "./outputService";
import type { PanelService } from "./panelService";
import type { Availability, RuntimeService } from "./runtimeService";
import { describeProgress } from "./runtimeService";

export const PHP_CHANNEL = "PHP Server";
export const PHP_PORT_SOURCE = "php-server";
export const DEFAULT_PHP_PORT = 8000;
export const MIN_PHP_PORT = 1024;
const SETTINGS_KEY = "php.server";
export const NO_WEB_ROOT = "Choose a web root folder first.";

/** A server that is up: what the panel shows and what "Open Browser" opens. */
export interface RunningServer {
  runId: string;
  pid: number;
  /** The PHP version the process was started with (it keeps using it after a switch). */
  phpVersion: string | null;
  url: string;
  port: number;
  root: string;
}

export interface PhpServerState {
  /**
   * The folder served as the web root: every folder inside it is a site at
   * `/<folder>/`. The app's own `htdocs` unless another folder was chosen;
   * `null` only while that isn't known yet or couldn't be created.
   */
  root: string | null;
  /** Whether `root` is the app's default `htdocs` (not saved: it follows the app folder). */
  defaultRoot: boolean;
  port: number;
  /** Whether nothing else is listening on `port` right now (`null` = not checked). */
  portFree: boolean | null;
  server: RunningServer | null;
  /** A start/stop is in flight. */
  busy: boolean;
  error: string | null;
}

const INITIAL: PhpServerState = {
  root: null,
  defaultRoot: true,
  port: DEFAULT_PHP_PORT,
  portFree: null,
  server: null,
  busy: false,
  error: null,
};

export type StackComponent = "php" | "composer";

/** One row of "Runtime Status". Apache, MariaDB and phpMyAdmin are listed as planned by the view itself. */
export interface ComponentView {
  id: StackComponent;
  label: string;
  state: "notInstalled" | "installed" | "needsRepair";
  /** The active (else first installed) version, or `null`. */
  version: string | null;
  working: boolean;
  progressLabel: string | null;
  error: string | null;
}

/** `null` when the text is a usable port, else why not. */
export function validatePort(text: string): { port: number } | { error: string } {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return { error: "Enter a port number, for example 8000." };
  const port = Number(trimmed);
  if (port < MIN_PHP_PORT || port > 65535) {
    return { error: `Choose a port from ${String(MIN_PHP_PORT)} to 65535.` };
  }
  return { port };
}

export interface StartInput {
  phpInstalled: boolean;
  phpHealthy: boolean;
  root: string | null;
  running: boolean;
  busy: boolean;
  portFree: boolean | null;
  port: number;
}

/** Whether Start Server can work, and if not, the reason — pure, so it is tested without React. */
export function startAvailability(input: StartInput): Availability {
  if (!input.phpInstalled) return { enabled: false, reason: "PHP runtime is not installed yet." };
  if (!input.phpHealthy) {
    return {
      enabled: false,
      reason: "The PHP install is damaged — repair it in Runtime Extensions first.",
    };
  }
  if (input.root === null) return { enabled: false, reason: NO_WEB_ROOT };
  if (input.running) return { enabled: false, reason: "The server is already running." };
  if (input.busy) return { enabled: false, reason: "Please wait — the server is changing state." };
  if (input.portFree === false) {
    return {
      enabled: false,
      reason: `Port ${String(input.port)} is already in use. Choose another port.`,
    };
  }
  return { enabled: true };
}

function componentView(
  id: StackComponent,
  label: string,
  status: RuntimeStatus | undefined,
  progress: InstallProgress | undefined,
  working: boolean,
  error: string | null,
): ComponentView {
  const installed = status?.installed ?? [];
  const pick = installed.find((entry) => entry.active) ?? installed[0];
  const state: ComponentView["state"] =
    pick === undefined ? "notInstalled" : pick.healthy ? "installed" : "needsRepair";
  return {
    id,
    label,
    state,
    version: pick?.version ?? null,
    working,
    progressLabel: working && progress ? describeProgress(progress).label : null,
    error,
  };
}

/**
 * The PHP Server panel's brain: the document root and port, the built-in
 * server's lifecycle, and the PHP/Composer rows (installed through the
 * Runtime Manager — this service only reads that state and asks it to
 * install/repair/delete). Nothing starts on launch or on opening a project:
 * only an explicit Start does. The server is `php -S 127.0.0.1:<port>` run by
 * the portable PHP; Rust plans and supervises the process.
 */
export class PhpServerService {
  private state: PhpServerState = INITIAL;
  /** The canonical servers state (`src/services/state`), once the backend has it. */
  private canonical: CanonicalFeed<ServersState> | null = null;
  private readonly listeners = new Set<() => void>();
  private off: (() => void) | null = null;
  /** Runs that already exited, so a late `start` result can't resurrect them. */
  private readonly exited = new Set<string>();

  constructor(
    private readonly ipc: IpcClient,
    private readonly events: EventBus<AppEvents>,
    private readonly output: OutputService,
    private readonly runtime: RuntimeService,
    private readonly panel: PanelService,
    /** The port used until the user picks one in the control panel (the `php.server.defaultPort` setting). */
    private readonly defaultPort: () => number = () => DEFAULT_PHP_PORT,
  ) {}

  /** A port the user chose (saved) beats the setting; only an unchosen port follows the setting. */
  private portChosen = false;

  getState(): PhpServerState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async initialize(): Promise<void> {
    const saved = await this.ipc.settingsGet(SETTINGS_KEY).catch(() => null);
    const parsed = parseSaved(saved);
    if (parsed !== null) this.update(parsed);
    this.portChosen = parsed?.port !== undefined;
    if (!this.portChosen) this.update({ port: this.defaultPort() });
    if (this.state.root === null) await this.useDefaultRoot();
    try {
      this.off = await this.ipc.onPhpEvent((event) => {
        this.handleEvent(event);
      });
    } catch (error) {
      this.events.emit("appError", { message: `PHP server output unavailable: ${String(error)}` });
    }
    await this.syncServer();
    await this.refreshPort();
  }

  /**
   * The backend is the one truth about the server (the PHP Server window and
   * the main window each have their own frontend state): adopt what it reports.
   */
  async syncServer(): Promise<void> {
    await this.canonical?.catchUp(); // the canonical servers state arrives through `useCanonical`
  }

  /**
   * Follows the backend's canonical servers state: the PHP server started or stopped in any window (or the PHP control
   * panel) shows up here at once, in every window, without asking the backend again.
   */
  useCanonical(feed: CanonicalFeed<ServersState>): () => void {
    this.canonical = feed;
    const off = feed.subscribe((servers) => {
      this.adoptServer(servers.php);
    });
    const current = feed.current();
    if (current !== undefined) this.adoptServer(current.php);
    return () => {
      off();
      this.canonical = null;
    };
  }

  private adoptServer(info: PhpServerInfo | null): void {
    const current = this.state.server;
    if (info === null) {
      if (current !== null) this.serverGone();
      return;
    }
    if (current?.runId === info.run.runId) return;
    this.update({
      portFree: null,
      server: {
        runId: info.run.runId,
        pid: info.run.pid,
        phpVersion: info.phpVersion,
        url: info.url,
        port: info.port,
        root: this.state.root ?? "",
      },
    });
  }

  private serverGone(): void {
    this.update({ server: null });
    void this.refreshPort();
  }

  dispose(): void {
    this.off?.();
    this.off = null;
  }

  // --- What the panel shows ---

  component(id: StackComponent): ComponentView {
    const runtime = this.runtime.getState();
    const status = runtime.runtimes.find((entry) => entry.id === id);
    return componentView(
      id,
      id === "php" ? "PHP" : "Composer",
      status,
      runtime.progress[id],
      id in runtime.working,
      runtime.errors[id] ?? null,
    );
  }

  isRunning(): boolean {
    return this.state.server !== null;
  }

  url(): string | null {
    return this.state.server?.url ?? null;
  }

  startState(): Availability {
    const php = this.component("php");
    return startAvailability({
      phpInstalled: php.state !== "notInstalled",
      phpHealthy: php.state === "installed",
      root: this.state.root,
      running: this.state.server !== null,
      busy: this.state.busy,
      portFree: this.state.portFree,
      port: this.state.port,
    });
  }

  stopState(): Availability {
    return this.state.server === null
      ? { enabled: false, reason: "The server isn't running." }
      : this.state.busy
        ? { enabled: false, reason: "Please wait — the server is changing state." }
        : { enabled: true };
  }

  restartState(): Availability {
    if (this.state.server === null) return { enabled: false, reason: "The server isn't running." };
    return this.stopState();
  }

  browserState(): Availability {
    return this.state.server === null
      ? { enabled: false, reason: "Start the server first — there is no URL yet." }
      : { enabled: true };
  }

  /**
   * Whether the running server is using this PHP version (its php.exe can't be
   * deleted or repaired while it runs). `null` when it isn't.
   */
  versionInUse(id: StackComponent, version: string): Availability | null {
    if (id !== "php" || this.state.server?.phpVersion !== version) return null;
    return {
      enabled: false,
      reason: `The PHP server is running on PHP ${version}. Stop the server first.`,
    };
  }

  /** Set while the running server still uses a PHP that is no longer the active one. */
  restartNotice(): string | null {
    const server = this.state.server;
    if (server === null || server.phpVersion === null) return null;
    const active = this.component("php").version;
    if (active === null || active === server.phpVersion) return null;
    return `Restart the PHP server to use the new PHP version. It is still running on PHP ${server.phpVersion}; PHP ${active} is now active.`;
  }

  // --- Actions ---

  /** Serves another folder as the web root (saved, unlike the default). */
  async setRoot(root: string | null): Promise<void> {
    this.update({ root, defaultRoot: false, error: null });
    await this.persist();
  }

  /** Serves the app's own `htdocs` (created by the backend if needed). */
  async useDefaultRoot(): Promise<boolean> {
    try {
      const root = await this.ipc.phpWebRoot();
      this.update({ root, defaultRoot: true, error: null });
      await this.persist();
      return true;
    } catch (error) {
      this.update({ root: null, defaultRoot: true, error: String(error) });
      return false;
    }
  }

  async selectFolder(): Promise<boolean> {
    const picked = await this.ipc.openFolderDialog();
    if (picked === null) return false;
    await this.setRoot(picked);
    return true;
  }

  /** Applies typed port text; returns the problem, or `null` when it was accepted. */
  async setPort(text: string): Promise<string | null> {
    const result = validatePort(text);
    if ("error" in result) return result.error;
    this.portChosen = true;
    this.update({ port: result.port, error: null });
    await this.persist();
    await this.refreshPort();
    return null;
  }

  /** The default-port setting changed: an unchosen port follows it (never while a server runs). */
  applyDefaultPort(): void {
    if (this.portChosen || this.state.server !== null) return;
    this.update({ port: this.defaultPort() });
    void this.refreshPort();
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

  async start(): Promise<boolean> {
    const availability = this.startState();
    if (!availability.enabled || this.state.root === null) {
      return this.fail(availability.reason ?? "The server can't start.");
    }
    const { root, port } = this.state;
    this.update({ busy: true, error: null });
    try {
      const info = await this.ipc.phpServerStart({ root, port });
      if (!this.exited.delete(info.run.runId)) {
        this.update({
          portFree: null,
          server: {
            runId: info.run.runId,
            pid: info.run.pid,
            phpVersion: info.phpVersion ?? this.component("php").version,
            url: info.url,
            port: info.port,
            root,
          },
        });
      }
      return true;
    } catch (error) {
      const message = String(error);
      this.output.append(PHP_CHANNEL, stamped(`[PHP Server] ${message}`));
      await this.refreshPort();
      return this.fail(message);
    } finally {
      this.update({ busy: false });
    }
  }

  async stop(): Promise<boolean> {
    const server = this.state.server;
    if (server === null) return false;
    this.update({ busy: true });
    try {
      await this.ipc.phpServerStop(server.runId);
      return true;
    } catch (error) {
      return this.fail(`Couldn't stop the server: ${String(error)}`);
    } finally {
      this.update({ busy: false });
    }
  }

  async restart(): Promise<boolean> {
    if (this.state.server === null) return false;
    if (!(await this.stop())) return false;
    // The exit event arrives asynchronously; wait until the server is really gone.
    for (let attempt = 0; attempt < 50 && this.isRunning(); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await this.refreshPort();
    return this.start();
  }

  async openBrowser(): Promise<boolean> {
    const url = this.url();
    if (url === null) return false;
    try {
      await this.ipc.openExternalUrl(url);
      return true;
    } catch (error) {
      return this.fail(`Couldn't open the browser: ${String(error)}`);
    }
  }

  /** Brings the PHP Server log up in the Output panel. */
  async openLogs(): Promise<void> {
    this.output.ensureChannel(PHP_CHANNEL);
    this.output.select(PHP_CHANNEL);
    await this.panel.show("output");
  }

  /** Kills the server without waiting (the app is closing, or PHP is going away). */
  async stopIfRunning(): Promise<void> {
    if (this.state.server !== null) await this.stop();
  }

  // --- Internals ---

  private handleEvent(event: RunEvent): void {
    if (event.type === "started") {
      this.output.append(PHP_CHANNEL, stamped(`[PHP Server] ${event.commandLine}`));
      this.output.append(PHP_CHANNEL, `cwd: ${event.cwd}`);
      this.output.append(PHP_CHANNEL, `runtime: ${event.runtime}`);
      this.output.append(PHP_CHANNEL, `resolved: ${event.resolved}`);
      this.output.append(PHP_CHANNEL, `port: ${String(this.state.port)} (127.0.0.1 only)`);
      this.output.append(PHP_CHANNEL, "");
      return;
    }
    if (event.type === "output") {
      this.output.append(PHP_CHANNEL, event.line);
      return;
    }
    const summary = event.stopped
      ? "Server stopped."
      : `Server exited with code ${event.code === null ? "unknown" : String(event.code)}.`;
    this.output.append(PHP_CHANNEL, stamped(`[PHP Server] ${summary}`));
    if (this.state.server?.runId === event.runId) {
      this.update({ server: null });
      void this.refreshPort();
    } else {
      this.exited.add(event.runId);
    }
  }

  private fail(message: string): false {
    this.update({ error: message });
    this.events.emit("appError", { message });
    return false;
  }

  private async persist(): Promise<void> {
    // The default web root is not saved: it is recomputed from the app folder, so it moves with it.
    const webRoot = this.state.defaultRoot ? null : this.state.root;
    const value = JSON.stringify({ webRoot, port: this.state.port });
    await this.ipc.settingsSet(SETTINGS_KEY, value).catch(() => undefined);
  }

  private update(patch: Partial<PhpServerState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

function parseSaved(saved: string | null): Partial<PhpServerState> | null {
  if (saved === null) return null;
  try {
    const value: unknown = JSON.parse(saved);
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    const patch: Partial<PhpServerState> = {};
    // `root` (a project folder, before the web root existed) is deliberately not read.
    if (typeof record.webRoot === "string" && record.webRoot !== "") {
      patch.root = record.webRoot;
      patch.defaultRoot = false;
    }
    if (
      typeof record.port === "number" &&
      Number.isInteger(record.port) &&
      record.port >= MIN_PHP_PORT &&
      record.port <= 65535
    ) {
      patch.port = record.port;
    }
    return patch;
  } catch {
    return null;
  }
}
