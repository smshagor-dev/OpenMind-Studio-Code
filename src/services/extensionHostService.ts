import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { HostBridge } from "./extensionHostBridge";
import type { HostDocumentSync } from "./extensionHostSync";
import type { ExtensionRegistryService } from "./extensionRegistryService";
import type {
  ActivationResult,
  ActivationTrigger,
  ExtensionHostStatus,
} from "./extensionsIpc";
import type { IpcClient } from "./ipc";

const STOPPED: ExtensionHostStatus = { state: "stopped", pid: null, node: null, error: null };

/** After a crash the host is started again this many times in a row, then the user has to do it. */
export const MAX_AUTO_RESTARTS = 2;
/** A host that ran this long before crashing counts as a fresh start (the attempts begin again). */
export const STABLE_MS = 5 * 60 * 1000;

export interface HostServiceDeps {
  ipc: IpcClient;
  events: EventBus<AppEvents>;
  registry: ExtensionRegistryService;
  bridge: HostBridge;
  sync: HostDocumentSync;
  settingsValues: () => Record<string, unknown>;
  workspaceFolders: () => { path: string; name: string }[];
  /** The "Extensions" Output channel. */
  log?: (line: string) => void;
  /** Wait before an automatic restart (tests make it short). */
  restartDelayMs?: number;
  /**
   * A host that was stopped or died is running again (Restart Extension Host, an automatic restart): the app's
   * start-up wake-up (`*`, `onStartupFinished`) is repeated, as VS Code does when it restarts its host.
   */
  onRestarted?: () => void;
}

/**
 * The extension host from the window's side: starts it when an extension with code has to run (never at
 * launch), wakes extensions on their activation events, runs their commands, answers what the host asks
 * (through the bridge) and keeps it informed (settings, folders, open files). If the host is gone —
 * stopped, crashed, no Node.js — every answer says so. UI-free.
 */
export class ExtensionHostService {
  private offs: (() => void)[] = [];
  private starting: Promise<boolean> | null = null;
  private localStatus: ExtensionHostStatus | null = null;
  private startedAt = 0;
  private autoRestarts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: HostServiceDeps) {}

  /** What the backend says the host is doing (the registry's snapshot, or the latest event). */
  status(): ExtensionHostStatus {
    return this.localStatus ?? this.deps.registry.getState().snapshot?.host ?? STOPPED;
  }

  isRunning(): boolean {
    return this.status().state === "running";
  }

  /** Whether some enabled extension has code, i.e. whether there is a reason to have a host. */
  needsHost(): boolean {
    return this.deps.registry.enabled().some((extension) => extension.runtimeRequirement !== null);
  }

  async initialize(): Promise<void> {
    this.dispose();
    const { ipc, events } = this.deps;
    try {
      this.offs.push(
        await ipc.onExtHostRequest((request) => {
          void this.answer(request.id, request.method, request.params);
        }),
        await ipc.onExtHostNotification((notification) => {
          this.deps.bridge.handleNotification(notification.method, notification.params);
        }),
        await ipc.onExtHostState((status) => {
          this.setStatus(status);
        }),
      );
    } catch (error) {
      events.emit("appError", { message: `The extension host is unavailable: ${String(error)}` });
    }
    this.offs.push(
      events.on("settingsChanged", ({ ids }) => {
        this.tell("host/configurationChanged", {
          values: this.deps.settingsValues(),
          changed: ids,
        });
      }),
      events.on("workspaceFolderChanged", () => {
        this.tell("host/workspaceFoldersChanged", { folders: this.deps.workspaceFolders() });
      }),
    );
  }

  dispose(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    for (const off of this.offs.splice(0)) off();
  }

  private tell(method: string, params: unknown): void {
    if (!this.isRunning()) return;
    void this.deps.ipc.extHostNotify(method, params).catch(() => undefined);
  }

  private log(line: string): void {
    this.deps.log?.(line);
  }

  private setStatus(status: ExtensionHostStatus): void {
    this.localStatus = status;
    if (status.state !== "running") {
      this.deps.sync.stop();
      this.deps.bridge.reset();
      this.starting = null;
    }
    this.deps.events.emit("extensionsChanged", undefined);
    // Startup failures can arrive before the host has reached "running".
    // They also need recovery; otherwise startup crashes leave extensions inert.
    if (status.state === "crashed" && !this.restartTimer && !this.starting) this.crashed(status);
  }

  /** The host died by itself: say so, and start it again a limited number of times. */
  private crashed(status: ExtensionHostStatus): void {
    const reason = status.error ?? "The extension host stopped unexpectedly.";
    this.log(`Extension host crashed: ${reason}`);
    this.deps.events.emit("appError", { message: `Extension host: ${reason}` });
    if (Date.now() - this.startedAt > STABLE_MS) this.autoRestarts = 0;
    if (!this.needsHost()) return;
    if (this.autoRestarts >= MAX_AUTO_RESTARTS) {
      this.log(
        `Not restarting the extension host again automatically (${String(MAX_AUTO_RESTARTS)} attempts). Use Restart Extension Host.`,
      );
      return;
    }
    this.autoRestarts += 1;
    this.log(`Restarting the extension host (attempt ${String(this.autoRestarts)} of ${String(MAX_AUTO_RESTARTS)})…`);
    this.localStatus = { ...status, state: "restarting" };
    this.deps.events.emit("extensionsChanged", undefined);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start().then((started) => {
        if (started) this.deps.onRestarted?.();
        else this.scheduleRecovery("Extension host restart failed.");
      });
    }, this.deps.restartDelayMs ?? 1000);
  }

  private scheduleRecovery(reason: string): void {
    if (this.restartTimer !== null || !this.needsHost() || this.autoRestarts >= MAX_AUTO_RESTARTS) return;
    this.crashed({ state: "crashed", pid: null, node: null, error: reason });
  }

  /** Starts the host if it isn't running. Resolves `false` (after telling the user why) when it can't. */
  start(): Promise<boolean> {
    if (this.isRunning()) return Promise.resolve(true);
    this.starting ??= this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<boolean> {
    const { ipc, sync, events } = this.deps;
    try {
      const initial = sync.initial();
      const status = await ipc.extHostStart({
        configuration: this.deps.settingsValues(),
        workspaceFolders: this.deps.workspaceFolders(),
        documents: initial.documents,
        activeEditor: initial.activeEditor,
      });
      this.startedAt = Date.now();
      this.setStatus(status);
      this.log(`Extension host started: ${status.node ?? "Node.js"} (pid ${String(status.pid ?? 0)}).`);
      sync.start();
      return true;
    } catch (error) {
      events.emit("appError", { message: String(error).replace(/^Error: /, "") });
      await this.deps.registry.refresh();
      this.localStatus = null;
      return false;
    }
  }

  async stop(): Promise<void> {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.deps.sync.stop();
    await this.deps.ipc.extHostStop().catch(() => undefined);
    this.setStatus(STOPPED);
    await this.deps.registry.refresh();
  }

  /** Restarts the host: extensions deactivate, and activate again the next time something wakes them. */
  async reload(): Promise<void> {
    this.autoRestarts = 0;
    this.log("Reloading the extension host…");
    await this.stop();
    this.localStatus = null;
    if (this.needsHost() && (await this.start())) this.deps.onRestarted?.();
  }

  /** Wakes the extensions `trigger` names. Failures are shown to the user and returned. */
  async activateFor(trigger: ActivationTrigger, report = true): Promise<ActivationResult[]> {
    if (!this.needsHost() || !(await this.start())) return [];
    let results: ActivationResult[];
    try {
      results = await this.deps.ipc.extActivateFor(trigger);
    } catch (error) {
      this.deps.events.emit("appError", { message: String(error).replace(/^Error: /, "") });
      return [];
    }
    for (const result of results) {
      this.log(
        result.ok
          ? `Activated ${result.id}.`
          : `Activation failed for ${result.id}: ${result.error ?? "unknown error"}`,
      );
      if (!result.ok && report) {
        this.deps.events.emit("appError", {
          message: result.error ?? `Activating ${result.id} failed.`,
        });
      }
    }
    if (results.length > 0) await this.deps.registry.refresh();
    return results;
  }

  /** One of the allow-listed requests to the running host (`host/resolveWebviewView`, `host/provideTasks`, ...). */
  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.isRunning()) throw new Error(this.status().error ?? "The extension host isn't running.");
    this.deps.sync.flush();
    return this.deps.ipc.extHostRequest(method, params);
  }

  /** Runs a command an extension registered, waking its extension first if needed. */
  async executeCommand(command: string, args: unknown[] = []): Promise<unknown> {
    const results = await this.activateFor({ kind: "command", command }, false);
    const failed = results.find((result) => !result.ok);
    if (failed) throw new Error(failed.error ?? `Activating ${failed.id} failed.`);
    if (!this.isRunning()) throw new Error(this.status().error ?? "The extension host isn't running.");
    this.deps.sync.flush();
    try {
      return await this.deps.ipc.extHostRequest("host/executeCommand", { command, args });
    } catch (error) {
      this.log(`Command ${command} failed: ${String(error)}`);
      throw error;
    }
  }

  private async answer(id: unknown, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.deps.bridge.handleRequest(method, params);
      await this.deps.ipc.extHostRespond(id, result ?? null, null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.ipc.extHostRespond(id, null, message).catch(() => undefined);
    }
  }
}
