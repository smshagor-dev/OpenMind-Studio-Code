// The OpenMindAI Agent panel's brain: the model list and downloads, the chosen model and mode, and the conversation
// (folded from backend events by agentModel.ts). UI-free; the panel reads `getState()` through useSyncExternalStore.
import type { AgentEvent, AgentIpc, AgentMode, AgentOverview, Decision, DownloadEvent, DownloadProgress } from "./agentIpc";
import { addNotice, addUser, applyEvent, EMPTY_TRANSCRIPT, nextMode, type Transcript } from "./agentModel";

export interface AgentHost {
  /** Absolute paths of this window's files with unsaved edits (the agent leaves those alone). */
  unsavedPaths: () => string[];
  /** The UI language's English name, for the agent's first words. */
  uiLanguage: () => string;
  /** Whether a folder is open (the agent works inside one). */
  hasFolder: () => boolean;
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
  overview: AgentOverview | null;
  overviewError: string | null;
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
    overview: null,
    overviewError: null,
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

  constructor(
    private readonly ipc: AgentIpc,
    private readonly host: AgentHost,
    private readonly now: () => number = () => Date.now(),
  ) {}

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

  /** Called when the panel is first shown: listens to the backend and reads the model list. Nothing is downloaded. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unlisten.push(await this.ipc.onEvent((event) => { this.onEvent(event); }));
    this.unlisten.push(await this.ipc.onDownload((event) => { this.onDownload(event); }));
    const [model, mode] = await Promise.all([
      this.host.settingGet(MODEL_KEY).catch(() => null),
      this.host.settingGet(MODE_KEY).catch(() => null),
    ]);
    if (mode === "ask" || mode === "acceptEdits" || mode === "plan") this.set({ mode });
    if (model) this.set({ modelId: model });
    await this.refresh();
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
      this.set({ overview, modelId, loadingOverview: false });
    } catch (error) {
      this.set({ loadingOverview: false, overviewError: String(error) });
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
    if (this.state.transcript.busy) return this.host.text("agent.blocker.busy");
    return null;
  }

  openSetup(open: boolean): void {
    this.set({ showSetup: open });
  }

  async selectModel(id: string): Promise<void> {
    this.set({ modelId: id });
    await this.host.settingSet(MODEL_KEY, id).catch(() => undefined);
  }

  async setMode(mode: AgentMode): Promise<void> {
    this.set({ mode });
    await this.host.settingSet(MODE_KEY, mode).catch(() => undefined);
  }

  cycleMode(): Promise<void> {
    return this.setMode(nextMode(this.state.mode));
  }

  async installEngine(): Promise<void> {
    this.set({ installingEngine: true });
    try {
      await this.host.installEngine();
    } finally {
      this.set({ installingEngine: false });
      await this.refresh();
    }
  }

  /** Downloads a model after the user accepted its licence. */
  async download(id: string): Promise<void> {
    const model = this.state.overview?.models.find((m) => m.id === id);
    if (!model) return;
    const ok = await this.host.confirm(
      this.host.text("agent.download.confirm", {
        name: `${model.name} (${model.quant})`,
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
      this.host.text("agent.delete.confirm", { name: `${model.name} (${model.quant})` }),
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
      this.host.notify(this.host.text("agent.download.done", { name: model?.name ?? event.id }));
      if (!this.ready()) void this.selectModel(event.id);
    }
    void this.refresh();
  }

  private onEvent(event: AgentEvent): void {
    const transcript = applyEvent(this.state.transcript, event, (notice) =>
      notice.message ? `${this.host.text(notice.key)} ${notice.message}` : this.host.text(notice.key),
    );
    this.set({ transcript });
    if (event.type === "engine" && event.state === "failed" && event.message) {
      this.set({ transcript: addNotice(this.state.transcript, "error", event.message) });
    }
    if (event.type === "turnEnd") void this.refresh();
  }

  async send(text: string): Promise<boolean> {
    const message = text.trim();
    if (!message) return false;
    const blocker = this.sendBlocker();
    if (blocker) {
      this.host.notify(blocker);
      return false;
    }
    const { modelId, mode } = this.state;
    if (!modelId) return false;
    this.set({ transcript: addUser(this.state.transcript, message, this.now()) });
    try {
      await this.ipc.send({
        text: message,
        modelId,
        mode,
        unsaved: this.host.unsavedPaths(),
        uiLanguage: this.host.uiLanguage(),
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

  stop(): Promise<void> {
    return this.ipc.stop();
  }

  async newChat(): Promise<void> {
    if (this.state.transcript.busy) await this.ipc.stop();
    try {
      await this.ipc.reset();
      this.set({ transcript: EMPTY_TRANSCRIPT });
    } catch (error) {
      this.host.notify(String(error));
    }
  }

  async undo(): Promise<void> {
    try {
      const { restored, failed } = await this.ipc.undo();
      let transcript = addNotice(
        { ...this.state.transcript, canUndo: false },
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
