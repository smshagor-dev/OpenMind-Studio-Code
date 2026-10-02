import type { DocumentService } from "./documentService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient, LspLogEvent, LspServerInfo, LspSnapshot, LspSyncOutcome } from "./ipc";
import {
  actionAvailability,
  removeBlocked,
  restartAvailability,
  type Availability,
  type FileLspStatus,
  type LspAction,
} from "./lspAvailability";
import { lspLanguageId } from "./lspLanguages";

/** How long after the last keystroke the server is told about the new text. */
export const SYNC_DELAY_MS = 250;

export interface LspState {
  /** What the backend reports (null until the first answer). */
  snapshot: LspSnapshot | null;
}

export interface LspDeps {
  /** Writes a line to the "LSP" output channel. */
  log: (line: string) => void;
  /** The document whose editor is in front, if any. */
  activeDocId: () => string | null;
  /** The `lsp.enabled` setting; without it language servers are always on. */
  enabled?: () => boolean;
}

export const LSP_DISABLED_REASON =
  "Language servers are turned off. Turn them on in Settings > Language Servers.";

/**
 * Language servers as the editor sees them. It never talks to a server itself:
 * the backend starts servers on demand for files inside the open workspace,
 * and this keeps them told about every open file (open, edits, save, close, a
 * file deleted or replaced on disk), remembers what each file's last sync
 * said (why a file has no language features), installs and restarts servers
 * when the user asks, and answers "can this action run for this file?".
 */
export class LspService {
  private state: LspState = { snapshot: null };
  private readonly listeners = new Set<() => void>();
  private readonly outcomes = new Map<string, LspSyncOutcome>();
  /** Where each document was last told to its server (so a renamed/saved-as file closes its old path). */
  private readonly sent = new Map<string, string>();
  private readonly watchers = new Map<string, () => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private confirmRemove: (server: LspServerInfo) => Promise<boolean> = () => Promise.resolve(false);
  private readonly reported = new Set<string>();
  private readonly removing = new Set<string>();
  /** Installs started from this window that haven't answered yet (a second click starts nothing). */
  private readonly installs = new Set<string>();
  private previouslyRunning = new Set<string>();
  private offs: (() => void)[] = [];

  constructor(
    private readonly ipc: IpcClient,
    private readonly events: EventBus<AppEvents>,
    private readonly documents: DocumentService,
    private readonly deps: LspDeps,
  ) {}

  getState(): LspState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async initialize(): Promise<void> {
    this.dispose();
    try {
      this.offs.push(
        await this.ipc.onLspChanged(() => {
          void this.refresh();
        }),
        await this.ipc.onLspLog((event) => {
          this.log(event);
        }),
        await this.ipc.onLspDiagnostics((event) => {
          this.events.emit("lspDiagnostics", event);
        }),
      );
    } catch (error) {
      this.events.emit("appError", { message: `Language servers unavailable: ${String(error)}` });
    }
    this.offs.push(
      this.events.on("documentOpened", ({ id }) => {
        this.track(id);
      }),
      this.events.on("documentClosed", ({ id, path }) => {
        this.untrack(id, path);
      }),
      this.events.on("documentSaved", ({ id, path }) => {
        this.saved(id, path);
      }),
      this.events.on("documentExternalChanged", ({ id }) => {
        this.externalChanged(id);
      }),
      this.events.on("workspaceFolderChanged", () => {
        void this.workspaceChanged();
      }),
    );
    for (const id of this.documents.fileBackedIds()) this.track(id);
    await this.refresh();
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
    for (const off of this.watchers.values()) off();
    this.watchers.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  // --- Status ---

  async refresh(): Promise<void> {
    try {
      this.state = { snapshot: await this.ipc.lspStatus() };
    } catch (error) {
      this.deps.log(`Couldn't read language server status: ${String(error)}`);
      return;
    }
    const running = new Set(this.runningServerIds());
    for (const server of this.previouslyRunning) {
      if (!running.has(server)) this.events.emit("lspServerStopped", { server });
    }
    this.previouslyRunning = running;
    this.events.emit("lspChanged", undefined);
    this.notify();
  }

  servers(): readonly LspServerInfo[] {
    return this.state.snapshot?.servers ?? [];
  }

  runningServerIds(): string[] {
    return this.servers()
      .filter((server) => server.state === "running")
      .map((server) => server.id);
  }

  /** The server that handles this file's language, if the backend lists one. */
  serverForPath(path: string): LspServerInfo | null {
    const language = lspLanguageId(path);
    if (language === null) return null;
    return this.servers().find((server) => server.languages.includes(language)) ?? null;
  }

  /** What is known about a document's language support. */
  fileStatus(docId: string | null): FileLspStatus {
    if (docId === null || !this.documents.has(docId)) {
      return { path: null, server: null, outcome: null };
    }
    const path = this.documents.snapshot(docId).path;
    return {
      path,
      server: path === null ? null : this.serverForPath(path),
      outcome: this.outcomes.get(docId) ?? null,
    };
  }

  activeFileStatus(): FileLspStatus {
    return this.fileStatus(this.deps.activeDocId());
  }

  available(action: LspAction, docId: string | null): Availability {
    if (!this.isEnabled()) return { enabled: false, reason: LSP_DISABLED_REASON };
    return actionAvailability(action, this.fileStatus(docId));
  }

  activeAvailable(action: LspAction): Availability {
    return this.available(action, this.deps.activeDocId());
  }

  activeRestartAvailability(): Availability {
    return restartAvailability(this.activeFileStatus());
  }

  // --- Keeping servers told about documents ---

  private isEnabled(): boolean {
    return this.deps.enabled?.() ?? true;
  }

  /** `lsp.enabled` changed: turning it off stops every server, turning it on tells them about the open files again. */
  async applyEnabled(): Promise<void> {
    if (this.isEnabled()) {
      for (const id of this.documents.fileBackedIds()) this.track(id);
      await this.refresh();
      return;
    }
    for (const id of [...this.watchers.keys()]) this.untrack(id, null);
    await this.stopAll();
  }

  private isCandidate(id: string): string | null {
    if (!this.isEnabled() || !this.documents.has(id)) return null;
    const path = this.documents.snapshot(id).path;
    return path !== null && lspLanguageId(path) !== null ? path : null;
  }

  private track(id: string): void {
    if (this.watchers.has(id) || this.isCandidate(id) === null) return;
    this.watchers.set(
      id,
      this.documents.onDidChangeContent(id, () => {
        this.schedule(id);
      }),
    );
    void this.syncNow(id);
  }

  private untrack(id: string, path: string | null): void {
    this.watchers.get(id)?.();
    this.watchers.delete(id);
    const timer = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(id);
    this.outcomes.delete(id);
    const sentPath = this.sent.get(id) ?? path;
    this.sent.delete(id);
    if (sentPath !== null && lspLanguageId(sentPath) !== null) {
      void this.ipc.lspCloseDocument(sentPath).catch(() => undefined);
    }
    this.notify();
  }

  /** Sends any edit still waiting for its delay, so a request made right after typing sees the current text. */
  async flush(id: string): Promise<void> {
    const timer = this.timers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(id);
    await this.syncNow(id);
  }

  private schedule(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        void this.syncNow(id);
      }, SYNC_DELAY_MS),
    );
  }

  /** Tells the file's server the editor's current text (opening the file there on first use). */
  async syncNow(id: string): Promise<LspSyncOutcome | null> {
    const path = this.isCandidate(id);
    if (path === null) return null;
    const previous = this.sent.get(id);
    if (previous !== undefined && previous !== path) {
      void this.ipc.lspCloseDocument(previous).catch(() => undefined);
    }
    this.sent.set(id, path);
    let outcome: LspSyncOutcome;
    try {
      outcome = await this.ipc.lspSyncDocument(path, this.documents.contentOf(id));
    } catch (error) {
      outcome = { state: "failed", server: "", message: String(error) };
    }
    if (!this.documents.has(id)) return null;
    const before = this.outcomes.get(id);
    this.outcomes.set(id, outcome);
    if (outcome.state === "failed") this.reportFailure(outcome);
    if (before?.state !== outcome.state) {
      if (outcome.state === "ready") await this.refresh();
      this.notify();
    }
    return outcome;
  }

  private reportFailure(outcome: Extract<LspSyncOutcome, { state: "failed" }>): void {
    if (this.reported.has(outcome.server)) return;
    this.reported.add(outcome.server);
    const name = this.servers().find((server) => server.id === outcome.server)?.name;
    this.events.emit("appError", {
      message: `${name ?? "The language server"} couldn't start: ${outcome.message}`,
    });
  }

  private saved(id: string, path: string): void {
    if (!this.watchers.has(id)) {
      // A new file (Save As on an untitled document), or one whose type now has a server.
      this.track(id);
      return;
    }
    if (this.sent.get(id) !== path) {
      void this.syncNow(id);
      return;
    }
    void this.ipc.lspSaveDocument(path).catch(() => undefined);
  }

  private externalChanged(id: string): void {
    if (!this.documents.has(id)) return;
    if (this.documents.externalState(id) === "deleted") {
      // The file is gone: the server must not keep analysing something that isn't there.
      const sentPath = this.sent.get(id);
      this.sent.delete(id);
      this.outcomes.delete(id);
      if (sentPath !== undefined) void this.ipc.lspCloseDocument(sentPath).catch(() => undefined);
      this.notify();
      return;
    }
    if (this.isCandidate(id) !== null) {
      if (!this.watchers.has(id)) this.track(id);
      else
        void this.syncNow(id).then((outcome) => {
          this.savedOnDisk(id, outcome);
        });
    }
  }

  /**
   * A clean buffer that was reloaded from disk is the saved file: say so, as after a save. Servers that report problems
   * only for saved files (fortls re-reads the file on save) would otherwise keep showing problems of the old text. Never
   * for a buffer with unsaved edits or a conflict with the disk.
   */
  private savedOnDisk(id: string, outcome: LspSyncOutcome | null): void {
    if (outcome?.state !== "ready" || !this.documents.has(id)) return;
    if (this.documents.isDirty(id) || this.documents.externalState(id) !== "none") return;
    const path = this.sent.get(id);
    if (path !== undefined) void this.ipc.lspSaveDocument(path).catch(() => undefined);
  }

  private async workspaceChanged(): Promise<void> {
    await this.stopAll();
    this.reported.clear();
    await this.resyncAll();
  }

  /** Tells the servers about every open file again (after a restart, an install, a new workspace). */
  async resyncAll(languages?: readonly string[]): Promise<void> {
    for (const id of this.documents.fileBackedIds()) {
      const path = this.isCandidate(id);
      if (path === null) continue;
      const language = lspLanguageId(path);
      if (languages && (language === null || !languages.includes(language))) continue;
      if (!this.watchers.has(id)) this.track(id);
      else await this.syncNow(id);
    }
  }

  // --- Actions the user takes ---

  async stopAll(): Promise<void> {
    await this.ipc.lspStopAll().catch(() => undefined);
    this.sent.clear();
    this.outcomes.clear();
    await this.refresh();
  }

  /** Stops one server (its diagnostics are removed; files reopen it when they are next edited or the server is restarted). */
  async stop(serverId: string): Promise<void> {
    await this.ipc.lspStop(serverId).catch((error: unknown) => {
      this.events.emit("appError", {
        message: `Couldn't stop the language server: ${String(error)}`,
      });
    });
    this.outcomes.clear();
    await this.refresh();
  }

  /** Stops the server and starts it again by telling it about the open files. */
  async restart(serverId: string): Promise<void> {
    const server = this.servers().find((entry) => entry.id === serverId);
    if (!server) return;
    this.deps.log(`Restarting ${server.name}…`);
    await this.ipc.lspStop(serverId).catch((error: unknown) => {
      this.events.emit("appError", { message: `Couldn't stop ${server.name}: ${String(error)}` });
    });
    this.reported.delete(serverId);
    for (const [id, outcome] of [...this.outcomes]) {
      if (outcome.state === "ready" && this.serverIdOf(id) === serverId) this.outcomes.delete(id);
    }
    await this.refresh();
    await this.resyncAll(server.languages);
  }

  /** Restarts the server of the file in front. */
  async restartActive(): Promise<boolean> {
    const status = this.activeFileStatus();
    if (status.server === null || !this.activeRestartAvailability().enabled) return false;
    await this.restart(status.server.id);
    return true;
  }

  private serverIdOf(docId: string): string | null {
    const path = this.documents.has(docId) ? this.documents.snapshot(docId).path : null;
    return path === null ? null : (this.serverForPath(path)?.id ?? null);
  }

  /**
   * Makes a server ready on the user's request — unpacked from the offline bundle when the app carries it,
   * otherwise downloaded from npm — then starts telling it about open files.
   */
  async install(serverId: string): Promise<boolean> {
    const server = this.servers().find((entry) => entry.id === serverId);
    if (!server?.canInstall || this.isInstalling(serverId)) return false;
    this.installs.add(serverId);
    // A new snapshot object, so views reading `getState()` see the change.
    this.state = { ...this.state };
    this.notify();
    try {
      await this.ipc.lspInstall(serverId);
    } catch (error) {
      this.installs.delete(serverId);
      this.events.emit("appError", {
        message: `Installing ${server.name} failed: ${String(error)}`,
      });
      await this.refresh();
      return false;
    }
    this.installs.delete(serverId);
    this.events.emit("appNotice", {
      message: server.bundled
        ? `${server.name} is ready (unpacked from the offline bundle).`
        : `${server.name} installed.`,
    });
    this.reported.delete(serverId);
    await this.refresh();
    await this.resyncAll(server.languages);
    return true;
  }

  /** An install of this server is running (started here, or reported by the backend). */
  isInstalling(serverId: string): boolean {
    return this.installs.has(serverId) || this.servers().some((entry) => entry.id === serverId && entry.state === "installing");
  }

  /** Asks the user before a server is removed (`true` = go ahead); without it nothing is removed. */
  setRemoveConfirmation(confirm: (server: LspServerInfo) => Promise<boolean>): void {
    this.confirmRemove = confirm;
  }

  /**
   * Removes a downloaded language server (npm or pip) after the user confirms: its processes stop and its folder in
   * `language-servers/` is deleted. Files of its languages simply have no server afterwards.
   */
  async uninstall(serverId: string): Promise<boolean> {
    const server = this.servers().find((entry) => entry.id === serverId);
    // A second click while the question is open (or the removal runs) asks nothing more.
    if (server === undefined || removeBlocked(server) !== null || this.removing.has(serverId)) return false;
    this.removing.add(serverId);
    try {
      if (!(await this.confirmRemove(server))) return false;
      await this.ipc.lspUninstall(serverId);
    } catch (error) {
      this.events.emit("appError", { message: `Removing ${server.name} failed: ${String(error)}` });
      await this.refresh();
      return false;
    } finally {
      this.removing.delete(serverId);
    }
    this.events.emit("appNotice", { message: `${server.name} removed.` });
    this.reported.delete(serverId);
    await this.refresh();
    return true;
  }

  async setVerbose(verbose: boolean): Promise<void> {
    await this.ipc.lspSetVerbose(verbose).catch(() => undefined);
    await this.refresh();
  }

  /** Opens the server's log file in the system editor. */
  async openLog(serverId: string): Promise<boolean> {
    const server = this.servers().find((entry) => entry.id === serverId);
    if (!server?.logExists) return false;
    await this.ipc.panelOpenFile(server.logPath).catch((error: unknown) => {
      this.events.emit("appError", { message: String(error) });
    });
    return true;
  }

  private log(event: LspLogEvent): void {
    const tag = event.level === "info" ? "" : `${event.level}: `;
    this.deps.log(`[${event.server}] ${tag}${event.text}`);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
