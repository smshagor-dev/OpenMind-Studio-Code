import type { DebugReadinessState } from "./state/canonicalIpc";
import type { WorkspaceFeed } from "./state/canonicalStateService";
import type { BreakpointService } from "./breakpointService";
import type { DebugConfigurationService } from "./debugConfigurationService";
import type { DebugConsoleService } from "./debugConsoleService";
import {
  consoleLineFromOutput,
  controlAvailability,
  startAvailability,
  type ControlState,
  type DebugControl,
  type StartAvailability,
} from "./debugModel";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { DebugRun, DebugStatus, IpcClient, LaunchConfig } from "./ipc";

export interface DebugState {
  status: DebugStatus | null;
  run: DebugRun | null;
}

/** What the debug session needs from the rest of the workbench. */
export interface DebugDeps {
  /** The text file in front, if any. */
  activeFile: () => { path: string; docId: string } | null;
  /** Saves the document when it has unsaved changes; `false` if that failed. */
  saveIfDirty: (docId: string) => Promise<boolean>;
  workspacePath: () => string | null;
  /** Brings the Debug Console (and the Run and Debug view) up. */
  showConsole: () => void;
  /** The `debug.stopOnEntry` setting: pause at the first line of every session. */
  stopOnEntry?: () => boolean;
  /** Writes a line to the "Debug" output channel. */
  log: (line: string) => void;
  /** Saves every edited file (a launch.json program may not be the file in front). */
  saveAll?: () => Promise<void>;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * The debug session as the UI sees it: what can be started and why not, starting (the file is
 * saved first, breakpoints go along), the controls, and the run's life as the backend reports
 * it — pausing, resuming, ending — turned into events the call stack, variables and watches
 * follow. Nothing starts except through `start()`, which only a user action calls.
 */
export class DebugService {
  private state: DebugState = { status: null, run: null };
  /** The canonical debug readiness of this window's folder (`src/services/state`). */
  private canonical: WorkspaceFeed<DebugReadinessState> | null = null;
  private readonly listeners = new Set<() => void>();
  private offs: (() => void)[] = [];
  private lastConfig: LaunchConfig | null = null;
  /** The run whose adapter abilities were already checked against the breakpoints. */
  private checkedRun: number | null = null;

  constructor(
    private readonly ipc: IpcClient,
    private readonly events: EventBus<AppEvents>,
    private readonly breakpoints: BreakpointService,
    private readonly configs: DebugConfigurationService,
    private readonly console: DebugConsoleService,
    private readonly deps: DebugDeps,
  ) {}

  getState(): DebugState {
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
        await this.ipc.onDebugState((run) => {
          this.onRun(run);
        }),
        await this.ipc.onDebugEvent((event) => {
          this.onEvent(event.name, event.body);
        }),
        await this.ipc.onDebugLog((event) => {
          const tag = event.level === "info" ? "" : `${event.level}: `;
          this.deps.log(`${tag}${event.text}`);
        }),
      );
    } catch (error) {
      this.events.emit("appError", { message: `Debugging unavailable: ${String(error)}` });
    }
    // The session running now (a window opened mid-session); later changes arrive as `debug:state`.
    const run: unknown = await this.ipc.debugRun().catch(() => null);
    if (typeof run === "object" && run !== null && this.state.run === null) this.onRun(run as DebugRun);
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
  }

  /**
   * Follows the backend's canonical debug readiness of this window's folder (interpreters, adapters, the reason one is
   * missing) — which also makes an extra window see its own folder's readiness, not the main window's.
   */
  useCanonical(feed: WorkspaceFeed<DebugReadinessState>): () => void {
    this.canonical = feed;
    const apply = (readiness: DebugReadinessState | undefined) => {
      if (readiness === undefined) return;
      this.state = { status: { ...readiness, run: this.state.run }, run: this.state.run };
      this.notify();
    };
    const off = feed.subscribe(apply);
    apply(feed.current());
    return () => {
      off();
      this.canonical = null;
    };
  }

  /** Refresh (after a debugger install): the backend reads the folder's debug readiness and this waits for it. */
  async refreshStatus(): Promise<void> {
    await this.canonical?.refresh();
  }

  isDebugging(): boolean {
    const run = this.state.run;
    return run !== null && run.state !== "terminated";
  }

  // --- What the UI may offer ---

  startState(): StartAvailability {
    const active = this.deps.activeFile()?.path ?? null;
    const entry = this.configs.currentEntry(active, this.deps.workspacePath());
    if (entry?.problem && (this.state.run === null || this.state.run.state === "terminated")) {
      return { enabled: false, reason: `${entry.name}: ${entry.problem}` };
    }
    return startAvailability({
      path: entry?.config?.program ?? active,
      status: this.state.status,
      run: this.state.run,
    });
  }

  controlState(control: DebugControl | "stop" | "restart"): ControlState {
    return controlAvailability(control, this.state.run);
  }

  /** Why the console can't evaluate now, or `null` when the program is paused. */
  evaluateUnavailable(): string | null {
    return this.state.run?.state === "stopped"
      ? null
      : "Expressions can only be evaluated while the program is paused at a breakpoint.";
  }

  // --- Actions ---

  /** F5: starts debugging the file in front. Returns whether a session was started. */
  async start(): Promise<boolean> {
    const availability = this.startState();
    if (!availability.enabled) return false;
    const file = this.deps.activeFile();
    // `${file}` in a launch.json depends on the file in front: read the configurations again for it.
    await this.configs.refresh(file?.path ?? null);
    const entry = this.configs.currentEntry(file?.path ?? null, this.deps.workspacePath());
    const chosen = entry?.config ?? null;
    if (entry === null || chosen === null) {
      if (entry?.problem)
        this.events.emit("appError", { message: `${entry.name}: ${entry.problem}` });
      return false;
    }
    const stopOnEntry = chosen.stopOnEntry || (this.deps.stopOnEntry?.() ?? false);
    const docId = file !== null && samePath(file.path, chosen.program) ? file.docId : null;
    if (docId === null) await this.deps.saveAll?.();
    const started = await this.startWith({ ...chosen, stopOnEntry }, docId);
    if (started) this.configs.recordUsed(entry.id);
    return started;
  }

  private async startWith(config: LaunchConfig, docId: string | null): Promise<boolean> {
    // The program that runs is the file on disk, so unsaved edits are saved first.
    if (docId !== null && !(await this.deps.saveIfDirty(docId))) {
      this.events.emit("appError", {
        message: "Couldn't save the file, so debugging didn't start.",
      });
      return false;
    }
    this.console.clear();
    this.console.append("system", `Starting ${config.name}…`);
    this.deps.log(`Starting ${config.name} (${config.program})`);
    this.deps.showConsole();
    try {
      const run = await this.ipc.debugStart(config, this.breakpoints.activeRows());
      this.lastConfig = config;
      this.onRun(run);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.console.append("error", message);
      this.deps.log(`error: ${message}`);
      this.events.emit("appError", { message });
      return false;
    }
  }

  async stop(): Promise<void> {
    if (!this.isDebugging()) return;
    try {
      await this.ipc.debugStop();
    } catch (error) {
      this.events.emit("appError", { message: `Couldn't stop debugging: ${String(error)}` });
    }
  }

  /** Stops the session and starts it again with the same configuration. */
  async restart(): Promise<boolean> {
    const config = this.lastConfig;
    if (config === null || !this.isDebugging()) return false;
    await this.stop();
    for (let attempt = 0; attempt < 40 && this.isDebugging(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.isDebugging()) return false;
    return this.startWith(config, this.deps.activeFile()?.docId ?? null);
  }

  async control(control: DebugControl): Promise<boolean> {
    if (!this.controlState(control).enabled) return false;
    try {
      await this.ipc.debugControl(control);
      return true;
    } catch (error) {
      this.events.emit("appError", { message: String(error) });
      return false;
    }
  }

  /** Evaluates an expression in the selected frame (the console and hover use this). */
  async evaluate(expression: string, frameId: number | null): Promise<unknown> {
    return this.ipc.debugRequest("evaluate", {
      expression,
      context: "repl",
      ...(frameId !== null ? { frameId } : {}),
    });
  }

  /**
   * What the program has loaded — scripts (js-debug) or modules (debugpy) — when the adapter can list them.
   * `null` without a session or when the adapter can't.
   */
  async loadedItems(): Promise<{ title: string; items: string[] } | null> {
    const abilities = this.state.run?.capabilities;
    if (!abilities || !this.isDebugging()) return null;
    const names = (list: unknown): string[] =>
      Array.isArray(list)
        ? list
            .map((item: unknown) => {
              const entry = item as { path?: unknown; name?: unknown };
              return typeof entry.path === "string"
                ? entry.path
                : typeof entry.name === "string"
                  ? entry.name
                  : "";
            })
            .filter((name) => name !== "")
        : [];
    if (abilities.loadedSources) {
      const answer = (await this.ipc.debugRequest("loadedSources", {})) as { sources?: unknown };
      return { title: "Loaded Scripts", items: names(answer.sources) };
    }
    if (abilities.modules) {
      const answer = (await this.ipc.debugRequest("modules", {
        startModule: 0,
        moduleCount: 500,
      })) as {
        modules?: unknown;
      };
      return { title: "Modules", items: names(answer.modules) };
    }
    return null;
  }

  // --- The backend's reports ---

  private onRun(run: DebugRun): void {
    const before = this.state.run;
    this.state = { ...this.state, run };
    this.events.emit("debugRunChanged", run);
    this.notify();
    this.checkAbilities(run);
    if (run.state === "stopped" && before?.state !== "stopped") {
      this.events.emit("debugPaused", { threadId: run.stopped?.threadId ?? 0 });
    } else if (before?.state === "stopped" && run.state !== "stopped") {
      this.events.emit("debugResumed", undefined);
    }
    if (run.state === "terminated" && before?.state !== "terminated") {
      this.events.emit("debugResumed", undefined);
      if (run.error) {
        this.console.append("error", run.error);
      } else {
        this.console.append("system", "The debug session ended.");
      }
      this.deps.log(run.error ? `ended: ${run.error}` : "ended");
    }
  }

  /** Once per run: a breakpoint condition, hit count or logpoint the adapter can't honour is named in the console. */
  private checkAbilities(run: DebugRun): void {
    const abilities = run.capabilities;
    if (!abilities || this.checkedRun === run.runId || run.state === "starting") return;
    this.checkedRun = run.runId;
    const uses = this.breakpoints.usesOptions();
    const missing = [
      uses.condition && !abilities.conditionalBreakpoints ? "conditions" : null,
      uses.hitCondition && !abilities.hitConditionalBreakpoints ? "hit counts" : null,
      uses.logMessage && !abilities.logPoints ? "logpoints" : null,
    ].filter((item): item is string => item !== null);
    if (missing.length > 0) {
      this.console.append(
        "error",
        `This debugger doesn't support breakpoint ${missing.join(", ")}: those breakpoints stop like plain ones or are ignored.`,
      );
    }
  }

  private onEvent(name: string, body: Record<string, unknown>): void {
    if (name === "output") {
      const line = consoleLineFromOutput(body);
      if (line) this.console.append(line.kind, line.text);
    } else if (name === "exited") {
      const code = typeof body.exitCode === "number" ? body.exitCode : null;
      this.console.append(
        "system",
        code === null ? "The program exited." : `The program exited with code ${String(code)}.`,
      );
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
