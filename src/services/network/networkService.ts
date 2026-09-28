import { t } from "../../i18n";
import type { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { CacheEntry, Inspection, NetProblem, NetworkIpc, NetworkStatus, TestOutcome } from "./networkIpc";
import { diagnoseNetwork, problemText, STRONG_PROBLEMS, validateProxyAddress } from "./networkModel";

export type NetworkTab = "proxy" | "offline";

/** A network failure a tool reported, with what the user can do about it. */
export interface NetworkFailure {
  problem: NetProblem;
  /** Where it was seen: "Git", "Runtime Manager", "Terminal" ... */
  source: string;
  /** Runs the failed action again (only when the reporter can). */
  retry: (() => void) | null;
}

export interface NetworkState {
  status: NetworkStatus | null;
  open: boolean;
  tab: NetworkTab;
  busy: boolean;
  testing: boolean;
  test: TestOutcome | null;
  /** The proxy variables of a new terminal, passwords as `****` (shown on request). */
  env: [string, string][] | null;
  offline: CacheEntry[];
  /** The last file inspected for import, waiting for the user to confirm. */
  inspection: Inspection | null;
  failure: NetworkFailure | null;
  error: string | null;
  notice: string | null;
}

/** What the service needs from the rest of the app. */
export interface NetworkHost {
  ipc: NetworkIpc;
  events: EventBus<AppEvents>;
  settingValue: (id: string) => string;
  setSetting: (id: string, value: string | boolean) => Promise<string | null>;
  pickFile: () => Promise<string | null>;
  pickFolder: () => Promise<string | null>;
  openFolder: (path: string) => Promise<void>;
  /** Hands a .vsix to the extension installer (which shows its trust dialog). */
  installVsix: (path: string) => Promise<void>;
  openRuntimeManager: () => void;
  now?: () => number;
}

const FIELDS = ["network.proxy.http", "network.proxy.https", "network.proxy.socks"] as const;
/** A dismissed problem stays quiet this long. */
const QUIET_MS = 2 * 60 * 1000;

/**
 * Network: the proxy the processes OpenMind starts use, the saved proxy credentials, the connection test, the
 * offline package cache and the card that turns a network failure into something to do. Nothing here makes a
 * request by itself: the backend is asked only when the window opens (local reads) or the user presses a button.
 */
export class NetworkService {
  private state: NetworkState = {
    status: null,
    open: false,
    tab: "proxy",
    busy: false,
    testing: false,
    test: null,
    env: null,
    offline: [],
    inspection: null,
    failure: null,
    error: null,
    notice: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly quietUntil = new Map<NetProblem, number>();
  private terminalNoticeShown = false;

  constructor(private readonly host: NetworkHost) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): NetworkState => this.state;

  private set(patch: Partial<NetworkState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  private now(): number {
    return (this.host.now ?? Date.now)();
  }

  /** Reads the status and the offline cache (local reads only; no network request). */
  async load(): Promise<void> {
    try {
      const [status, offline] = await Promise.all([
        this.host.ipc.networkStatus(),
        this.host.ipc.offlineList(),
      ]);
      this.set({ status, offline });
    } catch (error) {
      this.set({ error: String(error) });
    }
  }

  async openWindow(tab: NetworkTab = "proxy"): Promise<void> {
    this.set({ open: true, tab, error: null, notice: null });
    await this.load();
  }

  closeWindow(): void {
    this.set({ open: false, inspection: null, env: null });
  }

  setTab(tab: NetworkTab): void {
    this.set({ tab });
  }

  /** A proxy address field's problem, for the form (`null` = fine). Other fields (lists, GOPROXY) aren't addresses. */
  fieldProblem(id: string, value: string): string | null {
    if (!(FIELDS as readonly string[]).includes(id)) return null;
    return validateProxyAddress(value, id === "network.proxy.socks");
  }

  /** Saves one Network setting and re-reads the status. A bad address is refused before it is saved. */
  async saveSetting(id: string, value: string | boolean): Promise<boolean> {
    if (typeof value === "string" && (FIELDS as readonly string[]).includes(id)) {
      const problem = this.fieldProblem(id, value);
      if (problem !== null) {
        this.set({ error: problem });
        return false;
      }
    }
    const error = await this.host.setSetting(id, typeof value === "string" ? value.trim() : value);
    if (error !== null) {
      this.set({ error });
      return false;
    }
    this.set({ error: null, test: null, env: null });
    await this.load();
    return true;
  }

  private async run(action: () => Promise<NetworkStatus>, notice: string): Promise<boolean> {
    this.set({ busy: true, error: null, notice: null });
    try {
      this.set({ status: await action(), notice });
      return true;
    } catch (error) {
      this.set({ error: String(error) });
      return false;
    } finally {
      this.set({ busy: false });
    }
  }

  /** Saves the proxy user name and password (encrypted by Windows for this user; never shown again). */
  saveCredentials(username: string, password: string): Promise<boolean> {
    if (username.trim() === "") {
      this.set({ error: t("network.credentials.userRequired") });
      return Promise.resolve(false);
    }
    return this.run(
      () => this.host.ipc.networkSetCredentials(username, password),
      t("network.credentials.saved"),
    );
  }

  clearCredentials(): Promise<boolean> {
    return this.run(() => this.host.ipc.networkClearCredentials(), t("network.credentials.cleared"));
  }

  /** Test Connection: one request, now, through the proxy in force. */
  async test(url?: string): Promise<TestOutcome | null> {
    this.set({ testing: true, test: null, error: null });
    try {
      const outcome = await this.host.ipc.networkTest(url?.trim() ? url.trim() : null);
      this.set({ test: outcome });
      return outcome;
    } catch (error) {
      this.set({ error: String(error) });
      return null;
    } finally {
      this.set({ testing: false });
    }
  }

  /** Show Current Terminal Proxy Environment (passwords replaced by ****). */
  async showTerminalEnv(): Promise<void> {
    if (!this.state.open) await this.openWindow("proxy");
    try {
      this.set({ env: await this.host.ipc.networkTerminalEnv() });
    } catch (error) {
      this.set({ error: String(error) });
    }
  }

  /** The once-per-session notice when a terminal starts with the proxy variables. */
  terminalStarted(): void {
    if (this.terminalNoticeShown || this.state.status?.active !== true) return;
    this.terminalNoticeShown = true;
    this.host.events.emit("appNotice", { message: t("network.terminal.applied") });
  }

  // --- failures ---------------------------------------------------------------------------------------------

  /**
   * Looks at what a tool printed. A network problem shows the card (Configure Proxy / Retry / Import Package / Use
   * Offline Cache). `strongOnly`: only unmistakable problems (terminal output, where "timed out" can mean anything).
   */
  report(text: string, source: string, retry: (() => void) | null = null, strongOnly = false): boolean {
    const problem = diagnoseNetwork(text);
    if (problem === null || (strongOnly && !STRONG_PROBLEMS.has(problem))) return false;
    const current = this.state.failure;
    if (current?.problem === problem && (retry === null || current.retry !== null)) return true;
    if (current === null && (this.quietUntil.get(problem) ?? 0) > this.now()) return false;
    this.set({ failure: { problem, source, retry: retry ?? current?.retry ?? null } });
    return true;
  }

  dismissFailure(): void {
    const failure = this.state.failure;
    if (failure !== null) this.quietUntil.set(failure.problem, this.now() + QUIET_MS);
    this.set({ failure: null });
  }

  failureText(failure: NetworkFailure): string {
    return t("network.failure.title", { source: failure.source, problem: problemText(failure.problem) });
  }

  retryFailure(): void {
    const retry = this.state.failure?.retry;
    this.set({ failure: null });
    retry?.();
  }

  /** Use Offline Cache: pip in new processes also looks in the imported wheels; the offline tab opens. */
  async useOfflineCache(): Promise<void> {
    this.set({ failure: null });
    await this.host.setSetting("network.offline.useWheelhouse", true);
    await this.openWindow("offline");
  }

  // --- offline cache ----------------------------------------------------------------------------------------

  /** Import Offline Package: choose a file, see what it is, then confirm. */
  async chooseImport(): Promise<void> {
    if (!this.state.open || this.state.tab !== "offline") await this.openWindow("offline");
    const path = await this.host.pickFile();
    if (path === null) return;
    this.set({ busy: true, error: null, notice: null, inspection: null });
    try {
      this.set({ inspection: await this.host.ipc.offlineInspect(path) });
    } catch (error) {
      this.set({ error: String(error) });
    } finally {
      this.set({ busy: false });
    }
  }

  cancelImport(): void {
    this.set({ inspection: null });
  }

  /** Copies the inspected file into the cache (verified by its SHA-256), then offers the next step. */
  async confirmImport(): Promise<CacheEntry | null> {
    const inspection = this.state.inspection;
    if (inspection === null || inspection.kind === null || !inspection.compatible) return null;
    this.set({ busy: true, error: null });
    try {
      const entry = await this.host.ipc.offlineImport(inspection.path);
      this.set({ inspection: null, notice: this.importedNotice(entry) });
      this.set({ offline: await this.host.ipc.offlineList() });
      if (entry.kind === "vsix") await this.installExtension(entry.id);
      return entry;
    } catch (error) {
      this.set({ error: String(error) });
      return null;
    } finally {
      this.set({ busy: false });
    }
  }

  private importedNotice(entry: CacheEntry): string {
    switch (entry.kind) {
      case "runtime":
        return t("network.offline.importedRuntime", { name: entry.name, version: entry.version ?? "" });
      case "wheel":
        return t("network.offline.importedWheel", { name: entry.name });
      case "vsix":
        return t("network.offline.importedVsix", { name: entry.name });
      case "sourceArchive":
        return t("network.offline.importedSource", { name: entry.name });
      default:
        return t("network.offline.imported", { name: entry.name });
    }
  }

  async installExtension(id: string): Promise<void> {
    try {
      await this.host.installVsix(await this.host.ipc.offlinePath(id));
    } catch (error) {
      this.set({ error: String(error) });
    }
  }

  openRuntimeManager(): void {
    this.host.openRuntimeManager();
  }

  /** Extracts a source archive into a folder the user picks (it must be empty). */
  async extract(id: string): Promise<boolean> {
    const folder = await this.host.pickFolder();
    if (folder === null) return false;
    this.set({ busy: true, error: null });
    try {
      const count = await this.host.ipc.offlineExtract(id, folder);
      this.set({ notice: t("network.offline.extracted", { count, folder }) });
      return true;
    } catch (error) {
      this.set({ error: String(error) });
      return false;
    } finally {
      this.set({ busy: false });
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.host.ipc.offlineRemove(id);
      this.set({ offline: await this.host.ipc.offlineList() });
    } catch (error) {
      this.set({ error: String(error) });
    }
  }

  async clearCache(): Promise<void> {
    try {
      await this.host.ipc.offlineClear();
      this.set({ offline: [], notice: t("network.offline.cleared") });
    } catch (error) {
      this.set({ error: String(error) });
    }
  }

  async openCacheFolder(): Promise<void> {
    try {
      await this.host.openFolder(await this.host.ipc.offlineFolder());
    } catch (error) {
      this.host.events.emit("appError", { message: String(error) });
    }
  }
}
