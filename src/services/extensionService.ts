import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { ExtensionHostService } from "./extensionHostService";
import { OUTSIDE_WORKSPACE, displayName } from "./extensionModel";
import type { ExtensionRegistryService } from "./extensionRegistryService";
import type { InstalledExtension } from "./extensionsIpc";
import type { IpcClient } from "./ipc";
import type { SettingsService } from "./settingsService";
import { t } from "../i18n";

/** A `.vsix` chosen and read, waiting for the user to accept the trust warning. */
export interface PendingInstall {
  path: string;
  extension: InstalledExtension;
  /** An extension with this id is installed already: installing replaces it. */
  replaces: InstalledExtension | null;
}

export interface ExtensionUiState {
  selectedId: string | null;
  pendingInstall: PendingInstall | null;
  pendingUninstall: string | null;
  /** An extension the user is about to give access to files outside the workspace. */
  pendingGrant: string | null;
  /** The extension host's log, shown in the Extensions view while open. */
  logs: string | null;
  busy: string | null;
  notice: string | null;
  error: string | null;
}

export interface Availability {
  enabled: boolean;
  reason?: string;
}

const INITIAL: ExtensionUiState = {
  selectedId: null,
  pendingInstall: null,
  pendingUninstall: null,
  pendingGrant: null,
  logs: null,
  busy: null,
  notice: null,
  error: null,
};

/**
 * What the user does in the Extensions view: install a `.vsix` (after the trust warning), enable,
 * disable, uninstall, look at details and logs, reload the host. Every action reports what happened
 * (notice or error) and every button asks `*Availability` for its reason to be disabled. UI-free.
 */
export class ExtensionService {
  private state: ExtensionUiState = INITIAL;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly ipc: IpcClient,
    private readonly events: EventBus<AppEvents>,
    private readonly registry: ExtensionRegistryService,
    private readonly host: ExtensionHostService,
    private readonly settings: SettingsService,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  getState(): ExtensionUiState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(next: Partial<ExtensionUiState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  clearMessages(): void {
    this.set({ notice: null, error: null });
  }

  select(id: string | null): void {
    this.set({ selectedId: id });
  }

  // --- availability (each disabled button carries its reason) ---

  installAvailability(): Availability {
    if (this.state.busy !== null) return { enabled: false, reason: "Wait for the current action to finish." };
    return { enabled: true };
  }

  toggleAvailability(extension: InstalledExtension): Availability {
    if (this.state.busy !== null) return { enabled: false, reason: "Wait for the current action to finish." };
    return { enabled: true, reason: extension.enabled ? "Disable" : "Enable" };
  }

  reloadAvailability(): Availability {
    if (this.state.busy !== null) return { enabled: false, reason: "Wait for the current action to finish." };
    if (!this.host.needsHost() && !this.host.isRunning()) {
      return { enabled: false, reason: "No installed extension has code to run." };
    }
    return { enabled: true };
  }

  // --- install ---

  /** Asks for a `.vsix`, reads it and waits for confirmation. Nothing is installed yet. */
  async chooseVsix(): Promise<void> {
    if (!this.installAvailability().enabled) return;
    this.set({ error: null, notice: null });
    let path: string | null;
    try {
      path = await this.ipc.extPickVsix();
    } catch (error) {
      this.set({ error: `Couldn't open the file dialog: ${String(error)}` });
      return;
    }
    if (path === null) return;
    await this.inspect(path);
  }

  /** Reads `path` as an extension package and asks the user to confirm (also used by tests and drops). */
  async inspect(path: string): Promise<void> {
    this.set({ busy: "Reading the extension…" });
    try {
      const extension = await this.ipc.extInspectVsix(path);
      const replaces = this.registry.find(extension.id) ?? null;
      this.set({ pendingInstall: { path, extension, replaces }, busy: null });
    } catch (error) {
      this.set({ busy: null, error: cleanMessage(error) });
    }
  }

  cancelInstall(): void {
    this.set({ pendingInstall: null });
  }

  /** The user accepted the trust warning. */
  async confirmInstall(): Promise<void> {
    const pending = this.state.pendingInstall;
    if (pending === null) return;
    this.set({ pendingInstall: null, busy: `Installing ${displayName(pending.extension)}…` });
    try {
      const installed = await this.ipc.extInstall(pending.path, pending.replaces !== null);
      await this.registry.refresh();
      await this.settings.reload();
      this.log(`Installed ${installed.id} ${installed.manifest.version} (permissions: ${installed.permissions.accepted.join(", ") || "none"}).`);
      this.set({
        busy: null,
        selectedId: installed.id,
        notice: `Installed ${displayName(installed)} ${installed.manifest.version}.`,
      });
      await this.wake(installed);
    } catch (error) {
      this.log(`Install failed: ${cleanMessage(error)}`);
      this.set({ busy: null, error: cleanMessage(error) });
    }
  }

  /** An extension that starts with the app (`*`, `onStartupFinished`) is woken right after installing it. */
  private async wake(installed: InstalledExtension): Promise<void> {
    const startsEarly = installed.activationEvents.some(
      (event) => event === "*" || event === "onStartupFinished",
    );
    if (startsEarly && installed.enabled) await this.host.activateFor({ kind: "startup" });
  }

  // --- enable / disable / uninstall ---

  /** A colour theme of this extension in use goes back to the default (Dark) instead of staying as a dangling value. */
  private async releaseTheme(id: string): Promise<void> {
    const current = this.settings.string("workbench.colorTheme", "");
    if (current.startsWith(`extension:${id}/`)) {
      await this.settings.reset("user", "workbench.colorTheme");
      this.log(`The colour theme of ${id} was in use: back to the default theme.`);
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const extension = this.registry.find(id);
    if (extension === undefined) return;
    if (!enabled) await this.releaseTheme(id);
    this.set({ busy: `${enabled ? "Enabling" : "Disabling"} ${displayName(extension)}…`, error: null });
    try {
      await this.ipc.extSetEnabled(id, enabled);
      await this.registry.refresh();
      await this.settings.reload();
      this.log(`${extension.id} ${enabled ? "enabled" : "disabled"}.`);
      const languages = extension.manifest.contributes.languages.length > 0;
      this.set({
        busy: null,
        notice:
          `${displayName(extension)} is ${enabled ? "enabled" : "disabled"}.` +
          (languages && !enabled ? " Its languages stay registered until OpenMind Studio restarts." : ""),
      });
      // `extension` is how it was before this change: it is enabled now.
      if (enabled) await this.wake({ ...extension, enabled: true });
    } catch (error) {
      this.set({ busy: null, error: cleanMessage(error) });
    }
  }

  requestGrantOutsideWorkspace(id: string): void {
    this.set({ pendingGrant: id });
  }

  cancelGrant(): void {
    this.set({ pendingGrant: null });
  }

  /** After the warning: stores the permission, then reloads the host so the extension can retry with it. */
  async confirmGrant(): Promise<void> {
    const id = this.state.pendingGrant;
    if (id === null) return;
    const extension = this.registry.find(id);
    this.set({ pendingGrant: null, busy: "Granting access…", error: null });
    try {
      await this.ipc.extGrantPermission(id, OUTSIDE_WORKSPACE);
      await this.registry.refresh();
      this.log(`${id}: granted access to files outside the workspace.`);
      if (this.host.isRunning()) await this.host.reload();
      this.set({
        busy: null,
        notice: `${extension ? displayName(extension) : id} can now use files outside the open workspace.`,
      });
      this.events.emit("extensionsChanged", undefined);
    } catch (error) {
      this.set({ busy: null, error: cleanMessage(error) });
    }
  }

  requestUninstall(id: string): void {
    this.set({ pendingUninstall: id });
  }

  cancelUninstall(): void {
    this.set({ pendingUninstall: null });
  }

  async confirmUninstall(): Promise<void> {
    const id = this.state.pendingUninstall;
    if (id === null) return;
    const extension = this.registry.find(id);
    await this.releaseTheme(id);
    this.set({ pendingUninstall: null, busy: "Uninstalling…" });
    try {
      await this.ipc.extUninstall(id);
      await this.registry.refresh();
      await this.settings.reload();
      this.log(`${id} uninstalled.`);
      this.set({
        busy: null,
        selectedId: this.state.selectedId === id ? null : this.state.selectedId,
        notice: `Uninstalled ${extension ? displayName(extension) : id}.`,
      });
    } catch (error) {
      this.set({ busy: null, error: cleanMessage(error) });
    }
  }

  // --- folders, logs, host ---

  /** How many secrets the extension keeps (`context.secrets`); never their values. */
  async secretCount(id: string): Promise<number> {
    try {
      return await this.ipc.extSecretsCount(id);
    } catch {
      return 0;
    }
  }

  /** Forgets every secret of the extension (its details page, after the user confirmed). */
  async clearSecrets(id: string): Promise<void> {
    try {
      await this.ipc.extSecretsClear(id);
      this.log(`Cleared the secrets of ${id}.`);
    } catch (error) {
      this.set({ error: cleanMessage(error) });
    }
  }

  openFolder(id: string): void {
    const extension = this.registry.find(id);
    if (extension === undefined) return;
    void this.ipc.panelOpenFolder(extension.path).catch((error: unknown) => {
      this.set({ error: cleanMessage(error) });
    });
  }

  openLogsFolder(): void {
    const dir = this.registry.getState().snapshot?.logsDir;
    if (dir === undefined) return;
    void this.ipc.panelOpenFolder(dir).catch((error: unknown) => {
      this.set({ error: cleanMessage(error) });
    });
  }

  async showLogs(): Promise<void> {
    try {
      this.set({ logs: (await this.ipc.extHostLog()) || "The extension host has not written anything yet." });
    } catch (error) {
      this.set({ error: cleanMessage(error) });
    }
  }

  hideLogs(): void {
    this.set({ logs: null });
  }

  async reloadHost(): Promise<void> {
    if (!this.reloadAvailability().enabled) return;
    this.set({ busy: "Reloading the extension host…", error: null });
    await this.host.reload();
    this.set({ busy: null, notice: this.host.isRunning() ? "Extension host reloaded." : null });
    this.events.emit("extensionsChanged", undefined);
  }

  /** The user allows the machine's Node.js for the host when OpenMind's own isn't installed. */
  async allowSystemNode(): Promise<void> {
    const result = await this.settings.set("user", "extensions.allowSystemNode", true);
    if (!result.ok) {
      this.set({ error: result.error });
      return;
    }
    await this.registry.refresh();
    if (this.host.needsHost()) await this.host.start();
  }

  /** Why extension code can't run at all right now, if that is so. */
  runtimeProblem(): string | null {
    const snapshot = this.registry.getState().snapshot;
    if (snapshot === null || !this.host.needsHost()) return null;
    if (snapshot.host.state === "running") return null;
    const { node } = snapshot;
    if (node.portable || (node.system !== null && node.allowSystem)) {
      return snapshot.host.state === "crashed" ? (snapshot.host.error ?? "The extension host stopped.") : null;
    }
    return t("extensions.nodeRequired");
  }
}

function cleanMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error: /, "");
}
