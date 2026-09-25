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
}

/**
 * The debug session as the UI sees it: what can be started and why not, starting (the file is
 * saved first, breakpoints go along), the controls, and the run's life as the backend reports
 * it — pausing, resuming, ending — turned into events the call stack, variables and watches
 * follow. Nothing starts except through `start()`, which only a user action calls.
 */
export class DebugService {
  private state: DebugState = { status: null, run: null };
  private readonly listeners = new Set<() => void>();
  private offs: (() => void)[] = [];
  private lastConfig: LaunchConfig | null = null;

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
        await this.ipc.onRuntimeChanged(() => {
          void this.refreshStatus();
        }),
      );
    } catch (error) {
      this.events.emit("appError", { message: `Debugging unavailable: ${String(error)}` });
    }
    await this.refreshStatus();
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
  }

  /** Re-reads which debuggers and runtimes are installed (after an install, a runtime change, ...). */
  async refreshStatus(): Promise<void> {
    try {
      const status = await this.ipc.debugStatus();
      this.state = { status, run: this.state.run ?? status.run };
      this.notify();
    } catch (error) {
      this.deps.log(`Couldn't read the debugger status: ${String(error)}`);
    }
  }

  isDebugging(): boolean {
    const run = this.state.run;
    return run !== null && run.state !== "terminated";
  }

  // --- What the UI may offer ---

  startState(): StartAvailability {
    return startAvailability({
      path: this.deps.activeFile()?.path ?? null,
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
    const chosen = this.configs.current(file?.path ?? null, this.deps.workspacePath());
    if (file === null || chosen === null) return false;
    const stopOnEntry = chosen.stopOnEntry || (this.deps.stopOnEntry?.() ?? false);
    return this.startWith({ ...chosen, stopOnEntry }, file.docId);
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

  // --- The backend's reports ---

  private onRun(run: DebugRun): void {
    const before = this.state.run;
    this.state = { ...this.state, run };
    this.events.emit("debugRunChanged", run);
    this.notify();
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
