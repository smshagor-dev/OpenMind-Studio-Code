// The OpenMindAI Agent panel's brain: the model list and downloads, the chosen model and mode, and the conversation
// (folded from backend events by agentModel.ts). UI-free; the panel reads `getState()` through useSyncExternalStore.
import type { AgentEvent, AgentIpc, AgentMode, AgentOverview, Decision, DownloadEvent, DownloadProgress } from "./agentIpc";
import { AgentTasks, lastInterruptedTask, type AgentTask, type TaskState } from "./agentTasks";
import { agentOptions, DEFAULT_AGENT_OPTIONS, type AgentOptions } from "./agentOptions";
import { agentName } from "./agentBrand";
import { addNotice, addUser, applyEvent, EMPTY_TRANSCRIPT, nextMode, type Transcript } from "./agentModel";

export interface AgentHost {
  /** Absolute paths of this window's files with unsaved edits (the agent leaves those alone). */
  unsavedPaths: () => string[];
  /** The UI language's English name, for the agent's first words. */
  uiLanguage: () => string;
  /** Whether a folder is open (the agent works inside one). */
  hasFolder: () => boolean;
  workspacePath?: () => string | null;
  taskScope?: string;
  /** Installs the local engine through the Runtime Manager; `true` when it is installed afterwards. */
  installEngine: () => Promise<boolean>;
  confirm: (message: string, okLabel: string) => Promise<boolean>;
  notify: (message: string) => void;
  openFile: (path: string) => void;
  /** Files of the open folder matching what is typed after `@` (relative paths). */
  suggestFiles: (query: string) => Promise<string[]>;
  settingGet: (key: string) => Promise<string | null>;
  settingSet: (key: string, value: string) => Promise<void>;
  text: (key: string, params?: Record<string, string | number>) => string;
}

export interface DownloadState {
  progress: DownloadProgress | null;
  error: string | null;
}

export interface AgentState {
  options?: AgentOptions;
  taskState?: TaskState;
  showSettings?: boolean;
  engineState: "idle" | "loading" | "ready" | "failed";
  overview: AgentOverview | null;
  overviewError: string | null;
  setupError?: string | null;
  loadingOverview: boolean;
  installingEngine: boolean;
  downloads: Record<string, DownloadState>;
  modelId: string | null;
  mode: AgentMode;
  transcript: Transcript;
  /** The setup page is open over the conversation (choosing or downloading a model). */
  showSetup: boolean;
}

const MODEL_KEY = "agent.model";
const MODE_KEY = "agent.mode";

export class AgentService {
  private state: AgentState = {
    engineState: "idle",
    overview: null,
    overviewError: null,
    setupError: null,
    loadingOverview: false,
    installingEngine: false,
    downloads: {},
    modelId: null,
    mode: "ask",
    transcript: EMPTY_TRANSCRIPT,
    showSetup: false,
  };
  private readonly listeners = new Set<() => void>();
  private unlisten: (() => void)[] = [];
  private started = false;
  private warming: Promise<void> | null = null;
  private readonly tasks: AgentTasks;
  private saves: Promise<void> = Promise.resolve();

  constructor(
    private readonly ipc: AgentIpc,
    private readonly host: AgentHost,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tasks = new AgentTasks({
      run: (task, signal) => this.runTask(task, signal),
      stop: (id) => this.ipc.stop(id),
      changed: (taskState) => { this.set({ taskState }); this.persistTasks(taskState); },
    });
  }

  options(): AgentOptions { return this.state.options ?? { ...DEFAULT_AGENT_OPTIONS }; }

  async updateOptions(change: Partial<AgentOptions>): Promise<void> {
    const options = agentOptions({ ...this.options(), ...change });
    this.set({ options });
    await this.host.settingSet("agent.options", JSON.stringify(options)).catch(() => {
      this.host.notify(this.host.text("agent.tasks.saveFailed"));
    });
  }

  openSettings(open: boolean): void { this.set({ showSettings: open }); }
  pauseQueue(): void { this.tasks.pause(); }
  resumeQueue(): void { this.tasks.resume(); }
  cancelTask(id: string): void { this.tasks.cancel(id); }
  async continueTask(): Promise<boolean> {
    const task = lastInterruptedTask(this.tasks.getState().tasks);
    if (task && task.workspace !== (this.host.workspacePath?.() ?? null)) {
      this.host.notify(this.host.text("agent.tasks.workspaceChanged"));
      return false;
    }
    const accepted = await this.send(`Continue the interrupted task. Inspect the current project state first; preserve changes already made and complete the remaining work. Original goal:\n${task?.text ?? "Complete the previous request."}`, true);
    if (accepted) this.tasks.resume();
    return accepted;
  }

  private persistTasks(state: TaskState): void {
    const payload = JSON.stringify(state.tasks);
    this.saves = this.saves.then(() => this.host.settingSet(`agent.tasks.${this.host.taskScope ?? "main"}`, payload)).catch(() => {
      this.host.notify(this.host.text("agent.tasks.saveFailed"));
    });
  }

  getState(): AgentState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(change: Partial<AgentState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }

  /** Called once per editor window; restores and preloads an existing setup without downloading. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      this.unlisten.push(await this.ipc.onEvent((event) => { this.onEvent(event); }));
      this.unlisten.push(await this.ipc.onDownload((event) => { this.onDownload(event); }));
      const [model, mode, savedOptions, savedTasks] = await Promise.all([
        this.host.settingGet(MODEL_KEY).catch(() => null),
        this.host.settingGet(MODE_KEY).catch(() => null),
        this.host.settingGet("agent.options").catch(() => null),
        this.host.settingGet(`agent.tasks.${this.host.taskScope ?? "main"}`).catch(() => null),
      ]);
      try { this.set({ options: agentOptions(JSON.parse(savedOptions ?? "null")) }); } catch { this.set({ options: { ...DEFAULT_AGENT_OPTIONS } }); }
      if (savedTasks) {
        try { this.tasks.restore(JSON.parse(savedTasks) as unknown); } catch { /* Invalid local state is ignored. */ }
      }
      if (mode === "ask" || mode === "acceptEdits" || mode === "auto" || mode === "plan") this.set({ mode });
      if (model) this.set({ modelId: model });
      await this.refresh();
      await this.activate();
    } catch {
      this.dispose();
      this.set({ overviewError: this.host.text("agent.ui.operationFailed") });
    }
  }

  /** Preloads the configured agent without downloading or starting a conversation. */
  activate(): Promise<void> {
    if (this.warming) return this.warming;
    if (!this.ready() || !this.state.modelId) return Promise.resolve();
    const id = this.state.modelId;
    this.set({ engineState: "loading" });
    this.warming = (async () => {
      try {
        const ready = await this.ipc.startEngine(id);
        await this.refresh();
        this.set({ engineState: ready || this.state.overview?.runningModel === id ? "ready" : "idle" });
      } catch {
        this.set({ engineState: "failed" });
      }
    })().finally(() => { this.warming = null; });
    return this.warming;
  }

  dispose(): void {
    for (const off of this.unlisten) off();
    this.unlisten = [];
    this.started = false;
  }

  async refresh(): Promise<void> {
    this.set({ loadingOverview: true, overviewError: null });
    try {
      const overview = await this.ipc.overview();
      const ready = overview.models.filter((m) => m.local.state === "ready");
      let modelId = this.state.modelId;
      if (!modelId || !ready.some((m) => m.id === modelId)) {
        modelId = ready.find((m) => m.id === overview.recommended)?.id ?? ready[0]?.id ?? modelId;
      }
      this.set({
        overview, modelId, loadingOverview: false,
        engineState: overview.runningModel === modelId && modelId !== null ? "ready" : this.state.engineState === "ready" ? "idle" : this.state.engineState,
      });
    } catch {
      this.set({ loadingOverview: false, overviewError: this.host.text("agent.ui.operationFailed") });
    }
  }

  /** Whether the conversation can be used: engine installed and the chosen model downloaded. */
  ready(): boolean {
    const { overview, modelId } = this.state;
    if (!overview?.engineInstalled || !modelId) return false;
    return overview.models.some((m) => m.id === modelId && m.local.state === "ready");
  }

  /** Why Send is unavailable, or `null`. */
  sendBlocker(): string | null {
    if (!this.host.hasFolder()) return this.host.text("agent.blocker.noFolder");
    if (!this.ready()) return this.host.text("agent.blocker.noModel");

    return null;
  }

  openSetup(open: boolean): void {
    this.set({ showSetup: open });
  }

  async selectModel(id: string): Promise<void> {
    if (this.warming || this.state.transcript.busy) return;
    this.set({ modelId: id });
    await this.host.settingSet(MODEL_KEY, id).catch(() => undefined);
    await this.activate();
  }

  async setMode(mode: AgentMode): Promise<void> {
    this.set({ mode });
    await this.host.settingSet(MODE_KEY, mode).catch(() => undefined);
  }

  cycleMode(): Promise<void> {
    return this.setMode(nextMode(this.state.mode));
  }

  async installEngine(): Promise<void> {
    this.set({ installingEngine: true, setupError: null });
    try {
      if (!await this.host.installEngine()) {
        this.set({ setupError: this.host.text("agent.ui.operationFailed") });
      }
    } catch {
      this.set({ setupError: this.host.text("agent.ui.operationFailed") });
    } finally {
      this.set({ installingEngine: false });
      await this.refresh();
      await this.activate();
    }
  }

  /** Downloads a model after the user accepted its licence. */
  async download(id: string, licenceAccepted = false): Promise<void> {
    const model = this.state.overview?.models.find((m) => m.id === id);
    if (!model) return;
    const ok = licenceAccepted || await this.host.confirm(
      this.host.text("agent.download.confirm", {
        name: agentName(model),
        license: model.license.name,
        url: model.license.url,
      }),
      this.host.text("agent.download.accept"),
    );
    if (!ok) return;
    this.set({ downloads: { ...this.state.downloads, [id]: { progress: null, error: null } } });
    try {
      await this.ipc.download(id);
      await this.refresh();
    } catch (error) {
      this.set({ downloads: { ...this.state.downloads, [id]: { progress: null, error: String(error) } } });
    }
  }

  cancelDownload(id: string): Promise<void> {
    return this.ipc.cancelDownload(id);
  }

  async deleteModel(id: string): Promise<void> {
    const model = this.state.overview?.models.find((m) => m.id === id);
    if (!model) return;
    const ok = await this.host.confirm(
      this.host.text("agent.delete.confirm", { name: agentName(model) }),
      this.host.text("agent.delete.ok"),
    );
    if (!ok) return;
    try {
      await this.ipc.deleteModel(id);
    } catch (error) {
      this.host.notify(String(error));
    }
    await this.refresh();
  }

  private onDownload(event: DownloadEvent): void {
    if (event.state === "progress" || event.state === "failed") {
      const entry: DownloadState =
        event.state === "progress"
          ? { progress: event.progress, error: null }
          : { progress: null, error: event.message };
      this.set({ downloads: { ...this.state.downloads, [event.id]: entry } });
      if (event.state === "progress") return;
    } else {
      this.set({
        downloads: Object.fromEntries(Object.entries(this.state.downloads).filter(([id]) => id !== event.id)),
      });
    }
    if (event.state === "done") {
      const model = this.state.overview?.models.find((m) => m.id === event.id);
      this.host.notify(this.host.text("agent.download.done", { name: model ? agentName(model) : "OpenMindAI Agent" }));
      if (!this.ready()) {
        this.set({ modelId: event.id });
        void this.host.settingSet(MODEL_KEY, event.id).catch(() => undefined);
      }
    }
    if (event.state === "done") {
      void this.refresh().then(() => this.activate());
    } else {
      void this.refresh();
    }
  }

  private onEvent(event: AgentEvent): void {
    if (event.taskId && event.taskId !== this.tasks.getState().activeId) return;
    if (event.type === "engine") {
      if (event.model !== this.state.modelId) {
        this.set({ engineState: "idle" });
        return;
      }
      this.set({ engineState: event.state });
      if (!this.state.transcript.busy) return;
    }
    const transcript = applyEvent(this.state.transcript, event, (notice) =>
      notice.message ? `${this.host.text(notice.key)} ${notice.message}` : this.host.text(notice.key),
    );
    this.set({ transcript });
    if (event.type === "engine" && event.state === "failed" && event.message) {
      this.set({ transcript: addNotice(this.state.transcript, "error", this.host.text("agent.ui.failed")) });
    }
    if (event.type === "turnEnd") { this.tasks.finish(event.reason); void this.refresh(); }
  }

  send(text: string, first = false): Promise<boolean> {
    const message = text.trim();
    if (!message || message.length > 100000) return Promise.resolve(false);
    const blocker = this.sendBlocker();
    if (blocker) { this.host.notify(blocker); return Promise.resolve(false); }
    const modelId = this.state.modelId;
    if (!modelId) return Promise.resolve(false);
    const accepted = this.tasks.enqueue({
      id: crypto.randomUUID(), text: message, modelId, mode: this.state.mode,
      workspace: this.host.workspacePath?.() ?? null, options: { ...this.options() },
      status: "pending", reason: null, createdAt: this.now(),
    }, first);
    if (!accepted) this.host.notify(this.host.text("agent.tasks.full"));
    return Promise.resolve(accepted);
  }

  private aborted(signal: AbortSignal): boolean { return signal.aborted; }

  private async runTask(task: AgentTask, signal: AbortSignal): Promise<boolean> {
    if (this.warming) {
      await new Promise<void>((resolve) => {
        const done = () => { signal.removeEventListener("abort", done); resolve(); };
        signal.addEventListener("abort", done, { once: true });
        void this.warming?.finally(done);
        if (signal.aborted) done();
      });
    }
    if (this.aborted(signal)) return false;
    try { await this.ipc.waitIdle?.(); } catch (error) { this.host.notify(String(error)); return false; }
    if (this.aborted(signal)) return false;
    if (!this.host.hasFolder() || task.workspace !== (this.host.workspacePath?.() ?? null)) {
      this.host.notify(this.host.text("agent.tasks.workspaceChanged"));
      return false;
    }
    this.set({ transcript: addUser(this.state.transcript, task.text, this.now()) });
    try {
      await this.ipc.send({
        text: task.text, modelId: task.modelId, mode: task.mode, taskId: task.id,
        options: task.options, workspace: task.workspace, unsaved: this.host.unsavedPaths(), uiLanguage: this.host.uiLanguage(),
      });
      return true;
    } catch (error) {
      const failed = addNotice(this.state.transcript, "error", String(error));
      this.set({ transcript: { ...failed, busy: false, phase: "idle", startedAt: null } });
      return false;
    }
  }

  async answer(decision: Decision): Promise<void> {
    const request = this.state.transcript.permission;
    if (!request) return;
    this.set({ transcript: { ...this.state.transcript, permission: null, phase: "tool" } });
    await this.ipc.answer(request.id, decision);
  }

  async stop(): Promise<void> {
    try {
      const active = this.tasks.getState().activeId;
      await this.tasks.stop();
      if (!active && this.state.transcript.busy) await this.ipc.stop();
    } catch (error) { this.host.notify(String(error)); }
  }

  async newChat(): Promise<void> {
    try {
      await this.tasks.stop();
      if (this.state.transcript.busy) await this.ipc.stop();
      await this.ipc.reset();
      this.tasks.clear();
      this.set({ transcript: EMPTY_TRANSCRIPT });
    } catch (error) {
      this.host.notify(String(error));
    }
  }

  async undo(): Promise<void> {
    try {
      const { restored, failed, canUndo } = await this.ipc.undo();
      let transcript = addNotice(
        { ...this.state.transcript, canUndo },
        "info",
        this.host.text("agent.undo.done", { files: restored.join(", ") || "—" }),
      );
      if (failed.length > 0) {
        transcript = addNotice(transcript, "error", this.host.text("agent.undo.failed", { files: failed.join(", ") }));
      }
      this.set({ transcript });
    } catch (error) {
      this.host.notify(String(error));
    }
  }

  openFile(path: string): void {
    this.host.openFile(path);
  }

  suggestFiles(query: string): Promise<string[]> {
    return this.host.suggestFiles(query).catch(() => []);
  }
}

