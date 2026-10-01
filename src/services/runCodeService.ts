import { t } from "../i18n";
import { isMissingInputError, needsInteractiveInput } from "./deps/dependencyModel";
import { extensionOf } from "./editorAssociationService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type {
  CodeRunEvent,
  IpcClient,
  RunAvailability,
  RunRequestArgs,
  ShellKind,
  ShellStyle,
} from "./ipc";
import type { OutputService } from "./outputService";
import { stamped } from "./outputService";
import type { PanelService } from "./panelService";
import type { MarkerService, Problem } from "./markerService";
import type { RunConfigurationService, RunTarget } from "./runConfigurationService";
import type { TerminalService } from "./terminalService";
import type { WorkspaceService } from "./workspaceService";

export const RUN_CHANNEL = "Run Code";

export type RunButtonState =
  "ready" | "running" | "disabled" | "runtimeMissing" | "error" | "checking";

/** The editor Run Code would act on: the active tab of the active group. */
export interface RunEditor {
  tabId: string;
  docId: string;
  path: string | null;
  dirty: boolean;
}

export interface RunButtonView {
  state: RunButtonState;
  /** Whether clicking does something (run, or stop while running). */
  enabled: boolean;
  tooltip: string;
  /** A running process can be stopped. */
  canStop: boolean;
}

export interface LastRun {
  path: string;
  code: number | null;
  stopped: boolean;
  durationMs: number;
}

export interface RunState {
  availability: RunAvailability | null;
  /** The file (and command) `availability` was worked out for. */
  checkedKey: string | null;
  checking: boolean;
  /** File path -> id of its running process. */
  running: Readonly<Record<string, string>>;
  lastRun: LastRun | null;
  /** Why the last attempt to start failed, until the next attempt. */
  error: string | null;
}

export interface RunOptions {
  /** Overrides the file type's configured target. */
  target?: RunTarget;
  /** Bring up the Output panel on this run's channel. */
  showOutput?: boolean;
}

const INITIAL: RunState = {
  availability: null,
  checkedKey: null,
  checking: false,
  running: {},
  lastRun: null,
  error: null,
};

/** TypeScript runs on Node, so its output shares that channel. */
export function channelFor(language: string): string {
  return language === "TypeScript" ? "Node.js" : language;
}

function buildOwner(path: string): string {
  return `run:${path}`;
}

function titleOf(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

export function parseBuildProblem(line: string): Problem | null {
  const gcc = /^(.*?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.*)$/i.exec(line);
  const fpc = /^(.*?)\((\d+),(\d+)\)\s+(Fatal|Error|Warning|Note):\s*(.*)$/i.exec(line);
  const match = gcc ?? fpc;
  if (!match) return null;
  const lineNumber = Number(match[2]);
  const columnNumber = Number(match[3] ?? "1");
  const kind = (match[4] ?? "").toLowerCase();
  const message = match[5] ?? line;
  const severity = kind.includes("warning") ? "warning" : kind.includes("note") ? "info" : "error";
  return {
    severity,
    message,
    source: "compiler",
    line: Number.isFinite(lineNumber) && lineNumber > 0 ? lineNumber : 1,
    column: Number.isFinite(columnNumber) && columnNumber > 0 ? columnNumber : 1,
    endLine: Number.isFinite(lineNumber) && lineNumber > 0 ? lineNumber : 1,
    endColumn: Number.isFinite(columnNumber) && columnNumber > 0 ? columnNumber + 1 : 2,
  };
}

/** Terminal shell -> how its command line is quoted. WSL is not supported. */
export function shellStyleFor(shell: ShellKind): ShellStyle | null {
  switch (shell) {
    case "powerShell":
      return "powerShell";
    case "cmd":
      return "cmd";
    case "gitBash":
      return "bash";
    default:
      return null;
  }
}

/** What the Run button shows and does, decided from plain data (so it is tested without React). */
export function describeRunButton(input: {
  editor: RunEditor | null;
  availability: RunAvailability | null;
  availabilityCurrent: boolean;
  checking: boolean;
  running: boolean;
  error: string | null;
}): RunButtonView {
  const { editor, availability } = input;
  const disabled = (state: RunButtonState, tooltip: string): RunButtonView => ({
    state,
    enabled: false,
    tooltip,
    canStop: false,
  });
  if (input.running) {
    return {
      state: "running",
      enabled: true,
      tooltip: "Stop Running Code (Ctrl+Shift+F5)",
      canStop: true,
    };
  }
  if (editor === null) return disabled("disabled", "Open a file to run it.");
  if (editor.path === null) return disabled("disabled", "Save the file before running.");
  if (!input.availabilityCurrent || availability === null) {
    return disabled(input.checking ? "checking" : "disabled", "Checking how to run this file…");
  }
  if (!availability.runnable) {
    return disabled(
      availability.runtimeMissing ? "runtimeMissing" : "disabled",
      availability.reason ?? "This file can't be run.",
    );
  }
  if (input.error !== null) {
    return {
      state: "error",
      enabled: true,
      tooltip: `${input.error} — click to try again`,
      canStop: false,
    };
  }
  const command = availability.command === null ? "" : ` — ${availability.command}`;
  return { state: "ready", enabled: true, tooltip: `Run Code (Ctrl+F5)${command}`, canStop: false };
}

/**
 * Runs the active file. It decides whether the file can run (Rust does the
 * real work: resolving the interpreter, validating, spawning), starts and
 * stops runs, saves a file with changes first, streams the process's output
 * into the Output panel (channels "Run Code", plus one per language), or types
 * the command into a terminal. Runs only start from an explicit user action —
 * never on open, never from project scripts.
 */
export interface RunCodePrefs {
  saveBeforeRun: () => boolean;
  clearOutputBeforeRun: () => boolean;
}

const DEFAULT_RUN_PREFS: RunCodePrefs = {
  saveBeforeRun: () => true,
  clearOutputBeforeRun: () => true,
};

/**
 * Interactive programs: Run Code's Output shows a program's output but can't type into it (its stdin is closed), so a
 * file that reads the keyboard is offered the integrated terminal instead.
 */
export interface RunInteractiveHost {
  /** The current text of an open document. */
  text: (docId: string) => string | null;
  /** Asks what to do with a file that needs input: `terminal`, `output` (run anyway) or `null` (cancel). */
  choose: (file: string) => Promise<"terminal" | "output" | null>;
}

export class RunCodeService {
  private state: RunState = INITIAL;
  private interactive: RunInteractiveHost | null = null;
  /** Runs whose program asked for input it couldn't get (Python's EOFError). */
  private readonly missedInput = new Set<string>();
  /** Files that read input and were run in the Output anyway ("Run Anyway"). */
  private readonly withoutInput = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribers: (() => void)[] = [];
  /** Process id -> the file it runs and the Output channel its lines go to. */
  private readonly processes = new Map<string, { path: string; channel: string }>();
  private readonly buildProblems = new Map<string, { path: string; problems: Problem[] }>();
  /** Files whose run was requested but hasn't reported `started` yet. */
  private readonly starting = new Set<string>();
  /** Files whose run should bring the Output panel up once its channel is known. */
  private readonly wantOutput = new Set<string>();
  private token = 0;
  private lastSignature = "";
  private runtimeVersion = "";

  constructor(
    private readonly ipc: IpcClient,
    private readonly events: EventBus<AppEvents>,
    private readonly output: OutputService,
    private readonly workspace: WorkspaceService,
    private readonly configs: RunConfigurationService,
    private readonly terminal: TerminalService,
    private readonly panel: PanelService,
    /**
     * Also shows a run's channel beside the editor (the secondary side bar, at
     * half width), next to the Output panel below. Optional, so tests and
     * other hosts can leave it out.
     */
    private readonly showBeside: (channel: string) => void = () => undefined,
    /** The Run Code settings (`run.saveBeforeRun`, `run.clearOutputBeforeRun`); the defaults match the settings' defaults. */
    private readonly prefs: RunCodePrefs = DEFAULT_RUN_PREFS,
    private readonly markers?: Pick<MarkerService, "setExternal">,
  ) {}

  getState(): RunState {
    return this.state;
  }

  /** Wired after the prompts exist (the composition root). */
  setInteractiveHost(host: RunInteractiveHost): void {
    this.interactive = host;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Starts listening for process events and for changes that affect what can run. */
  async initialize(): Promise<void> {
    this.unsubscribers.push(
      this.events.on("tabsChanged", () => {
        void this.refresh();
      }),
      this.configs.subscribe(() => {
        void this.refresh();
      }),
    );
    try {
      this.unsubscribers.push(
        await this.ipc.onRunEvent((event) => {
          this.handleEvent(event);
        }),
      );
    } catch (error) {
      this.events.emit("appError", { message: `Run output unavailable: ${String(error)}` });
    }
    await this.refresh();
  }

  dispose(): void {
    for (const off of this.unsubscribers.splice(0)) off();
  }

  /** The editor Run Code would act on right now. */
  activeEditor(): RunEditor | null {
    const state = this.workspace.getState();
    const tab = state.tabs.find((candidate) => candidate.id === state.activeId);
    return tab ? { tabId: tab.id, docId: tab.docId, path: tab.path, dirty: tab.dirty } : null;
  }

  buttonView(): RunButtonView {
    const editor = this.activeEditor();
    return describeRunButton({
      editor,
      availability: this.state.availability,
      availabilityCurrent:
        editor?.path != null && this.state.checkedKey === this.keyFor(editor.path),
      checking: this.state.checking,
      running: editor?.path != null && editor.path in this.state.running,
      error: this.state.error,
    });
  }

  /** Whether *any* process is running (offers "Stop Running Code"). */
  isRunning(): boolean {
    return Object.keys(this.state.running).length > 0;
  }

  canRun(): boolean {
    const view = this.buttonView();
    return view.enabled && !view.canStop;
  }

  canStop(): boolean {
    return this.isRunning();
  }

  /** Re-works out how the active file would run (after switching files, changing a command or a runtime). */
  async refresh(): Promise<void> {
    const editor = this.activeEditor();
    if (editor?.path == null) {
      if (this.state.availability !== null || this.state.checking) {
        this.update({ availability: null, checkedKey: null, checking: false });
      }
      return;
    }
    const key = this.keyFor(editor.path);
    const signature = `${key}|${this.runtimeVersion}`;
    if (signature === this.lastSignature && this.state.checkedKey === key) return;
    this.lastSignature = signature;
    const token = ++this.token;
    this.update({ checking: true });
    let availability: RunAvailability;
    try {
      availability = await this.ipc.runResolve(this.requestFor(editor.path));
    } catch (error) {
      availability = {
        runnable: false,
        kind: null,
        language: null,
        reason: String(error),
        previewable: false,
        runtimeMissing: false,
        runtime: null,
        command: null,
        resolved: null,
      };
    }
    if (token !== this.token) return;
    this.update({ availability, checkedKey: key, checking: false });
  }

  /** Runs the active file. Resolves `true` if a process was started or the command was sent to a terminal. */
  async run(options: RunOptions = {}): Promise<boolean> {
    const editor = this.activeEditor();
    if (editor === null) return this.fail("Open a file to run it.");
    if (editor.path === null) return this.fail("Save the file before running.");
    if (editor.path in this.state.running || this.starting.has(editor.path)) return false;
    this.update({ error: null });

    if (editor.dirty && !this.prefs.saveBeforeRun()) {
      return this.fail(
        "The file has unsaved changes. Save it first (or turn on Save Before Run in Settings).",
      );
    }
    if (editor.dirty) {
      // Run what is on screen: save first (a failed save stops the run).
      await this.workspace.save(editor.tabId);
      if (this.activeEditor()?.dirty === true) {
        return this.fail("The file has unsaved changes and couldn't be saved.");
      }
    }
    const extension = extensionOf(editor.path);
    let target = options.target ?? this.configs.targetFor(extension);
    if (target !== "terminal" && this.interactive !== null) {
      const text = this.interactive.text(editor.docId);
      if (text !== null && needsInteractiveInput(extension ?? "", text)) {
        const choice = await this.interactive.choose(editor.path);
        if (choice === null) return false;
        target = choice === "terminal" ? "terminal" : target;
        // Run Anyway: the program reads input it won't get, so its end says why (C and Rust print no error for it).
        if (choice === "output") this.withoutInput.add(editor.path);
      }
    }
    const request = this.requestFor(editor.path);
    return target === "terminal"
      ? this.runInTerminal(request)
      : this.runManaged(request, options.showOutput ?? true);
  }

  /** Stops the active file's run, or the only run if that isn't it. */
  async stop(): Promise<void> {
    const editor = this.activeEditor();
    const own = editor?.path == null ? undefined : this.state.running[editor.path];
    const ids = own === undefined ? Object.values(this.state.running) : [own];
    for (const id of ids) {
      await this.ipc.runStop(id).catch((error: unknown) => {
        this.events.emit("appError", { message: `Couldn't stop the run: ${String(error)}` });
      });
    }
  }

  async stopAll(): Promise<void> {
    for (const id of Object.values(this.state.running)) {
      await this.ipc.runStop(id).catch(() => false);
    }
  }

  // --- Internals ---

  private async runManaged(request: RunRequestArgs, showOutput: boolean): Promise<boolean> {
    this.starting.add(request.file);
    if (showOutput) this.wantOutput.add(request.file);
    try {
      const info = await this.ipc.runStart(request);
      if (showOutput) {
        // `started` usually arrives first and has already picked the channel;
        // if not, it selects the channel when it does arrive.
        const known = this.processes.get(info.runId);
        if (known && this.wantOutput.delete(request.file)) this.revealOutput(known.channel);
      }
      return true;
    } catch (error) {
      this.wantOutput.delete(request.file);
      const message = String(error);
      this.output.append(RUN_CHANNEL, stamped(`[Run Code] ${message}`));
      if (showOutput) this.revealOutput(RUN_CHANNEL);
      return this.fail(message);
    } finally {
      this.starting.delete(request.file);
    }
  }

  private async runInTerminal(request: RunRequestArgs): Promise<boolean> {
    const view = this.terminal.getState();
    let session = view.sessions.find((s) => s.id === view.activeId && !s.exited);
    if (session === undefined) {
      const id = await this.terminal.createTerminal();
      session = this.terminal.getState().sessions.find((s) => s.id === id);
    }
    if (session === undefined) return this.fail("Couldn't open a terminal.");
    const style = shellStyleFor(session.shell);
    if (style === null) return this.fail("Run Code in Terminal isn't supported in WSL terminals.");
    try {
      const command = await this.ipc.runTerminalCommand(request, style);
      // The terminal echoes exactly what is typed, so the command is visible there.
      this.terminal.write(session.id, `${command.line}\r`);
      this.terminal.setActive(session.id);
      await this.panel.show("terminal");
      this.output.append(
        RUN_CHANNEL,
        stamped(`[Run Code] Sent to the terminal: ${command.display}`),
      );
      this.output.append(RUN_CHANNEL, `runtime: ${command.runtime}`);
      this.output.append(RUN_CHANNEL, `resolved: ${command.resolved}`);
      return true;
    } catch (error) {
      return this.fail(String(error));
    }
  }

  /**
   * Shows the run's channel beside the editor, and selects it in the bottom
   * panel's Output without opening the panel (it opens only when the user does).
   */
  private revealOutput(channel: string): void {
    this.output.select(channel);
    this.showBeside(channel);
  }

  private handleEvent(event: CodeRunEvent): void {
    switch (event.type) {
      case "building":
        this.onBuilding(event);
        return;
      case "started":
        this.onStarted(event);
        return;
      case "built": {
        const channel = this.processes.get(event.runId)?.channel ?? RUN_CHANNEL;
        const seconds = (event.durationMs / 1000).toFixed(2);
        this.output.append(
          channel,
          event.success
            ? `Build succeeded. (${seconds}s)`
            : `Build failed${event.code === null ? "" : ` with exit code ${String(event.code)}`}. The program was not run.`,
        );
        return;
      }
      case "output": {
        const channel = this.processes.get(event.runId)?.channel ?? RUN_CHANNEL;
        this.output.append(channel, event.line);
        if (event.phase === "build") this.recordBuildProblem(event.runId, event.line);
        if (isMissingInputError(event.line)) this.missedInput.add(event.runId);
        return;
      }
      case "exited":
        this.onExited(event);
    }
  }

  /** Registers a run's process: its file, its channel, the running state, and the Output panel when asked for. */
  private track(runId: string, file: string, language: string): string {
    const channel = channelFor(language);
    this.processes.set(runId, { path: file, channel });
    this.output.ensureChannel(channel);
    if (this.prefs.clearOutputBeforeRun()) this.output.clear(channel);
    this.update({ running: { ...this.state.running, [file]: runId } });
    if (this.wantOutput.delete(file)) this.revealOutput(channel);
    return channel;
  }

  /** A compiled language (C, C++, Java, Rust): the compile command comes first, its output under it. */
  private onBuilding(event: Extract<CodeRunEvent, { type: "building" }>): void {
    const channel = this.track(event.runId, event.file, event.language);
    this.buildProblems.set(event.runId, { path: event.file, problems: [] });
    this.markers?.setExternal(buildOwner(event.file), []);
    const header = `[Run Code] ${event.commandLine}`;
    this.output.append(RUN_CHANNEL, stamped(header));
    this.output.append(channel, header);
    this.output.append(channel, `cwd: ${event.cwd}`);
    this.output.append(channel, `compiler: ${event.runtime}`);
    this.output.append(channel, `resolved: ${event.compiler}`);
    this.output.append(channel, "");
    this.output.append(channel, "Building...");
  }

  private onStarted(event: Extract<CodeRunEvent, { type: "started" }>): void {
    const header = `[Run Code] ${event.commandLine}`;
    this.output.append(RUN_CHANNEL, stamped(header));
    const built = this.processes.get(event.runId);
    if (built !== undefined) {
      // After a successful build: the program's own output follows, apart from the compiler's.
      this.output.append(built.channel, "");
      this.output.append(built.channel, `> ${event.commandLine}`);
      this.output.append(built.channel, "");
      return;
    }
    const channel = this.track(event.runId, event.file, event.language);
    this.output.append(channel, header);
    this.output.append(channel, `cwd: ${event.cwd}`);
    this.output.append(channel, `runtime: ${event.runtime}`);
    this.output.append(channel, `resolved: ${event.resolved}`);
    this.output.append(channel, "");
  }

  private onExited(event: Extract<CodeRunEvent, { type: "exited" }>): void {
    const process = this.processes.get(event.runId);
    const path = process?.path ?? null;
    const channel = process?.channel ?? RUN_CHANNEL;
    this.processes.delete(event.runId);
    this.buildProblems.delete(event.runId);
    const ranWithoutInput = path !== null && this.withoutInput.delete(path) && event.buildFailed !== true;
    if (this.missedInput.delete(event.runId) || ranWithoutInput) {
      // The program asked for input; Run Code's Output can't answer it.
      this.output.append(channel, "");
      this.output.append(channel, t("run.interactive.eof"));
      this.events.emit("appNotice", { message: t("run.interactive.eof") });
    }
    const seconds = (event.durationMs / 1000).toFixed(2);
    const summary = event.stopped
      ? `Process stopped. (${seconds}s)`
      : event.buildFailed === true
        ? `Build failed. (${seconds}s)`
        : `Process exited with code ${event.code === null ? "unknown" : String(event.code)}. (${seconds}s)`;
    this.output.append(channel, "");
    this.output.append(channel, summary);
    this.output.append(RUN_CHANNEL, stamped(`[Run Code] ${summary}`));
    if (path !== null) {
      const running = Object.fromEntries(
        Object.entries(this.state.running).filter(([file]) => file !== path),
      );
      this.update({
        running,
        lastRun: { path, code: event.code, stopped: event.stopped, durationMs: event.durationMs },
      });
    }
  }

  private recordBuildProblem(runId: string, line: string): void {
    const parsed = parseBuildProblem(line);
    if (parsed === null) return;
    const state = this.buildProblems.get(runId);
    if (state === undefined) return;
    state.problems.push(parsed);
    this.markers?.setExternal(buildOwner(state.path), [
      { path: state.path, title: titleOf(state.path), problems: state.problems },
    ]);
  }

  private fail(message: string): false {
    this.update({ error: message });
    this.events.emit("appError", { message });
    return false;
  }

  private requestFor(path: string): RunRequestArgs {
    return {
      file: path,
      workspace: this.workspace.getActiveWorkspace()?.path ?? null,
      template: this.configs.templateFor(extensionOf(path)),
    };
  }

  private keyFor(path: string): string {
    return `${path}|${this.configs.templateFor(extensionOf(path)) ?? ""}`;
  }

  /** Called by the composition root when the installed/active runtimes change: an interpreter may have appeared or gone. */
  noteRuntimesChanged(signature: string): void {
    if (signature !== this.runtimeVersion) {
      this.runtimeVersion = signature;
      this.lastSignature = "";
      void this.refresh();
    }
  }

  private update(patch: Partial<RunState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
