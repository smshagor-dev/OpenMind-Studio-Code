import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { ComposerAction, IpcClient, ProjectInfo, RunEvent, RunInfo } from "./ipc";
import type { OutputService } from "./outputService";
import { stamped } from "./outputService";
import type { PanelService } from "./panelService";
import type { Availability, RuntimeService } from "./runtimeService";

export const COMPOSER_CHANNEL = "Composer";
const SETTINGS_KEY = "composer.project";
export const NO_COMPOSER_PROJECT = "Select a Composer project folder first.";

export const COMPOSER_ACTIONS: readonly { action: ComposerAction; label: string }[] = [
  { action: "install", label: "composer install" },
  { action: "update", label: "composer update" },
  { action: "dump-autoload", label: "composer dump-autoload" },
];

export interface ComposerState {
  /** The Composer command that is running, if any. */
  running: RunInfo | null;
  runningAction: ComposerAction | null;
  project: ProjectInfo | null;
  /**
   * The project Composer works on — its own choice, not the PHP server's web
   * root (the server serves every site; Composer works on one project).
   */
  projectRoot: string | null;
  /** How the last command ended, until the next one starts. */
  lastResult: string | null;
  error: string | null;
}

const INITIAL: ComposerState = {
  running: null,
  runningAction: null,
  project: null,
  projectRoot: null,
  lastResult: null,
  error: null,
};

export interface ComposerInput {
  composerInstalled: boolean;
  phpInstalled: boolean;
  phpActive: boolean;
  root: string | null;
  project: ProjectInfo | null;
  running: boolean;
}

/** Pure: whether a Composer command can start, and if not, why. */
export function composerAvailability(input: ComposerInput): Availability {
  if (!input.composerInstalled) return { enabled: false, reason: "Composer is not installed yet." };
  if (!input.phpInstalled) return { enabled: false, reason: "PHP runtime is not installed yet." };
  if (!input.phpActive) {
    return { enabled: false, reason: "No PHP is active — set a PHP version active first." };
  }
  if (input.root === null || input.project?.isDir === false) {
    return { enabled: false, reason: NO_COMPOSER_PROJECT };
  }
  if (input.project?.hasComposerJson === false) {
    return { enabled: false, reason: "This folder has no composer.json." };
  }
  if (input.running) return { enabled: false, reason: "A Composer command is already running." };
  return { enabled: true };
}

/**
 * Composer's project commands (install, update, dump-autoload) run from the
 * selected project root on the portable Composer + active portable PHP. Each is
 * an explicit click; its command, cwd and output are logged to the "Composer"
 * Output channel, and nothing is ever run in the background.
 */
export class ComposerService {
  private state: ComposerState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private offs: (() => void)[] = [];

  constructor(
    private readonly ipc: IpcClient,
    private readonly events: EventBus<AppEvents>,
    private readonly output: OutputService,
    private readonly runtime: RuntimeService,
    private readonly panel: PanelService,
  ) {}

  getState(): ComposerState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async initialize(): Promise<void> {
    try {
      this.offs.push(
        await this.ipc.onComposerEvent((event) => {
          this.handleEvent(event);
        }),
        await this.ipc.onComposerChanged(() => {
          void this.syncRunning();
        }),
      );
    } catch (error) {
      this.events.emit("appError", { message: `Composer output unavailable: ${String(error)}` });
    }
    const saved = await this.ipc.settingsGet(SETTINGS_KEY).catch(() => null);
    if (saved !== null && saved !== "") this.update({ projectRoot: saved });
    await this.syncRunning();
    await this.refreshProject();
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
  }

  /** Re-reads whether the project folder exists and has a composer.json. */
  async refreshProject(): Promise<void> {
    const root = this.state.projectRoot;
    if (root === null) {
      this.update({ project: null });
      return;
    }
    const project = (await this.ipc.phpProjectInfo(root).catch(() => null)) ?? null;
    if (root === this.state.projectRoot) this.update({ project });
  }

  /** Chooses the project Composer works on (saved). */
  async setProject(root: string): Promise<void> {
    this.update({ projectRoot: root, project: null, error: null, lastResult: null });
    await this.ipc.settingsSet(SETTINGS_KEY, root).catch(() => undefined);
    await this.refreshProject();
  }

  async selectProject(): Promise<boolean> {
    const picked = await this.ipc.openFolderDialog();
    if (picked === null) return false;
    await this.setProject(picked);
    return true;
  }

  private async syncRunning(): Promise<void> {
    const active = (await this.ipc.composerStatus().catch(() => [])) as RunInfo[] | undefined;
    const first = active?.[0] ?? null;
    if (first === null) {
      if (this.state.running !== null) this.update({ running: null, runningAction: null });
    } else if (this.state.running?.runId !== first.runId) {
      this.update({ running: first });
    }
  }

  // --- What the section shows ---

  availability(): Availability {
    const status = (id: string) =>
      this.runtime.getState().runtimes.find((entry) => entry.id === id);
    const root = this.state.projectRoot;
    return composerAvailability({
      composerInstalled: (status("composer")?.installed.length ?? 0) > 0,
      phpInstalled: (status("php")?.installed.length ?? 0) > 0,
      phpActive: status("php")?.installed.some((entry) => entry.active && entry.healthy) ?? false,
      root,
      project: this.state.project,
      running: this.state.running !== null,
    });
  }

  stopState(): Availability {
    return this.state.running === null
      ? { enabled: false, reason: "No Composer command is running." }
      : { enabled: true };
  }

  // --- Actions ---

  async run(action: ComposerAction): Promise<boolean> {
    const root = this.state.projectRoot;
    const availability = this.availability();
    if (!availability.enabled || root === null) {
      return this.fail(availability.reason ?? "Composer can't run.");
    }
    this.update({ error: null, lastResult: null });
    try {
      const run = await this.ipc.composerRun(action, root);
      this.update({ running: run, runningAction: action });
      this.output.select(COMPOSER_CHANNEL);
      return true;
    } catch (error) {
      this.output.append(COMPOSER_CHANNEL, stamped(`[Composer] ${String(error)}`));
      return this.fail(String(error));
    }
  }

  async stop(): Promise<boolean> {
    if (!this.stopState().enabled) return false;
    await this.ipc.composerStop().catch(() => undefined);
    return true;
  }

  async openLogs(): Promise<void> {
    this.output.ensureChannel(COMPOSER_CHANNEL);
    this.output.select(COMPOSER_CHANNEL);
    await this.panel.show("output");
  }

  // --- Internals ---

  private handleEvent(event: RunEvent): void {
    if (event.type === "started") {
      this.output.clear(COMPOSER_CHANNEL);
      this.output.append(COMPOSER_CHANNEL, stamped(`[Composer] ${event.commandLine}`));
      this.output.append(COMPOSER_CHANNEL, `cwd: ${event.cwd}`);
      this.output.append(COMPOSER_CHANNEL, `runtime: ${event.runtime}`);
      this.output.append(COMPOSER_CHANNEL, `resolved: ${event.resolved}`);
      this.output.append(COMPOSER_CHANNEL, "");
      return;
    }
    if (event.type === "output") {
      this.output.append(COMPOSER_CHANNEL, event.line);
      return;
    }
    const summary = event.stopped
      ? "Composer stopped."
      : event.code === 0
        ? "Composer finished."
        : `Composer exited with code ${event.code === null ? "unknown" : String(event.code)}.`;
    this.output.append(COMPOSER_CHANNEL, "");
    this.output.append(COMPOSER_CHANNEL, stamped(`[Composer] ${summary}`));
    this.update({ running: null, runningAction: null, lastResult: summary });
  }

  private fail(message: string): false {
    this.update({ error: message });
    this.events.emit("appError", { message });
    return false;
  }

  private update(patch: Partial<ComposerState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
