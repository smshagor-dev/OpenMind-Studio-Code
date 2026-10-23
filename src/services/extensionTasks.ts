import type { ConfirmPrompt, QuickPickPrompt } from "./extensionPromptService";
import type { ActivationResult, ActivationTrigger } from "./extensionsIpc";
import type { ShellKind } from "./ipc";
import type { TerminalService } from "./terminalService";
import { t } from "../i18n";

/** A task as the host describes it (`host/provideTasks`, `tasks/execute`). */
export interface ExtensionTask {
  handle: string;
  extension: string;
  name: string;
  source: string;
  type: string;
  detail: string | null;
  group: string | null;
  commandLine: string;
  shellCommand?: string | null;
  shellArgs?: string[];
  program?: string | null;
  args?: string[];
  kind: "shell" | "process" | "custom";
  cwd: string | null;
  cwdInsideFolder: boolean;
  env: Record<string, string>;
  problemMatchers: string[];
  matcherDefinitions?: unknown[];
  isBackground: boolean;
}

export interface ExtensionTaskDeps {
  host: {
    activateFor: (trigger: ActivationTrigger, report?: boolean) => Promise<ActivationResult[]>;
    request: (method: string, params: unknown) => Promise<unknown>;
    needsHost: () => boolean;
  };
  terminals: Pick<TerminalService, "createTerminal" | "write" | "getState" | "subscribe" | "closeTerminal"> & Partial<Pick<TerminalService, "onOutput">>;
  quickPick: (request: Omit<QuickPickPrompt, "kind" | "id">) => Promise<number | number[] | null>;
  confirm: (request: Omit<ConfirmPrompt, "kind" | "id">) => Promise<string | null>;
  notifyHost: (method: string, params: unknown) => void;
  notice: (message: string) => void;
  startTask?: (task: ExtensionTask, onOutput: (data: Uint8Array) => void) => Promise<{ sessionId: string; pid: number | null; disposeOutput?: () => void } | null>;
  matcherNotes?: (task: ExtensionTask) => Promise<string[]>;
  reportProblems?: (task: ExtensionTask, output: string, isCurrent: () => boolean) => Promise<void>;
  log?: (line: string) => void;
}

/** VS Code's own command name for the task list (extensions with `taskDefinitions` wake on it). */
export const RUN_TASK_COMMAND = "workbench.action.tasks.runTask";
export const RUN_TASK = "Run Task";

/**
 * The line typed into the terminal: `commandLine` with the task's environment set first, in the syntax of the
 * terminal's shell. `null` when a value can't be written safely for that shell (the task is then not run).
 */
export function taskLine(task: ExtensionTask, shell: ShellKind): string | null {
  const entries = Object.entries(task.env);
  if (entries.length === 0) return task.commandLine;
  if (entries.some(([key]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) return null;
  switch (shell) {
    case "powerShell":
      return `${entries.map(([key, value]) => `$env:${key}='${value.replace(/'/g, "''")}'`).join("; ")}; ${task.commandLine}`;
    case "cmd":
      if (entries.some(([, value]) => /["%^&|<>\r\n]/.test(value))) return null;
      return `${entries.map(([key, value]) => `set "${key}=${value}"`).join(" && ")} && ${task.commandLine}`;
    case "gitBash":
      return `${entries.map(([key, value]) => `${key}='${value.replace(/'/g, "'\\''")}'`).join(" ")} ${task.commandLine}`;
    default:
      return null;
  }
}

/** The labelled lines the confirmation shows for a task. */
export function taskDetails(task: ExtensionTask): { label: string; value: string }[] {
  const lines = [
    { label: t("extTask.task"), value: `${task.name} (${task.source})` },
    { label: t("tasks.confirm.command"), value: task.commandLine },
    { label: t("tasks.confirm.folder"), value: task.cwd ?? t("extTask.openFolder") },
  ];
  const env = Object.entries(task.env);
  if (env.length > 0)
    lines.push({
      label: t("tasks.confirm.environment"),
      value: env.map(([k, v]) => `${k}=${v}`).join("  "),
    });
  return lines;
}

interface Running {
  task: ExtensionTask;
  sessionId: string;
  capture?: (data: string) => void;
  finish?: () => void;
}

/**
 * Tasks extensions provide (`tasks.registerTaskProvider`, Milestone 18). Nothing is asked for or run in the
 * background: Terminal > Run Task... (`tasks.run`) wakes the task providers, lists their tasks, and the chosen one is
 * shown in a confirmation (command, folder, environment, what isn't supported) before it runs in a new terminal. An
 * extension's own `tasks.executeTask` goes through the same confirmation. Native tasks have their own process and
 * exit status; custom tasks use extension pseudoterminals. Output feeds the native problem matcher parser. UI-free.
 */
export class ExtensionTaskService {
  private readonly running = new Map<string, Running>();
  private readonly custom = new Map<string, { capture(data: string): void; finish(): void }>();
  private readonly owners = new Map<string, number>();
  private generation = 0;

  private problems(task: ExtensionTask): { capture(data: string): void; finish(): void } {
    let output = "", timer: ReturnType<typeof setTimeout> | undefined, revision = 0;
    const generation = this.generation, owner = `${task.extension}:${task.name}`;
    const version = (this.owners.get(owner) ?? 0) + 1; this.owners.set(owner, version);
    const publish = () => {
      const current = ++revision;
      void this.deps.reportProblems?.(task, output, () => generation === this.generation && this.owners.get(owner) === version && revision === current).catch((error: unknown) => { this.deps.log?.(`Task problem matching failed: ${String(error)}`); });
    };
    if (task.problemMatchers.length) publish();
    return {
      capture: data => { output = (output + data).slice(-1024 * 1024); if (task.problemMatchers.length) { clearTimeout(timer); timer = setTimeout(publish, 100); } },
      finish: () => { clearTimeout(timer); if (task.problemMatchers.length) publish(); },
    };
  }

  customOutput(params: Record<string, unknown>): void { if (typeof params.handle === "string" && typeof params.data === "string") this.custom.get(params.handle)?.capture(params.data); }
  customFinished(params: Record<string, unknown>): void { if (typeof params.handle !== "string") return; this.custom.get(params.handle)?.finish(); this.custom.delete(params.handle); }
  reset(): void { this.generation++; for (const run of this.running.values()) run.finish?.(); for (const run of this.custom.values()) run.finish(); this.running.clear(); this.custom.clear(); }


  constructor(private readonly deps: ExtensionTaskDeps) {
    deps.terminals.subscribe(() => {
      this.onSessionsChanged();
    });
  }

  /** The tasks of every provider, after waking the extensions that provide tasks. */
  async list(): Promise<ExtensionTask[]> {
    if (!this.deps.host.needsHost()) return [];
    await this.deps.host.activateFor({ kind: "command", command: RUN_TASK_COMMAND }, true);
    try {
      const answer = (await this.deps.host.request("host/provideTasks", {})) as { tasks?: ExtensionTask[] };
      return Array.isArray(answer.tasks) ? answer.tasks : [];
    } catch (error) {
      this.deps.notice(t("extTask.listFailed", { error: String(error).replace(/^Error: /, "") }));
      return [];
    }
  }

  /** Terminal > Run Task...: pick a task, confirm, run. */
  async pickAndRun(): Promise<void> {
    const tasks = await this.list();
    if (tasks.length === 0) {
      this.deps.notice(
        t("extTask.none"),
      );
      return;
    }
    const picked = await this.deps.quickPick({
      extension: "OpenMind Studio",
      items: tasks.map((task) => ({
        label: task.name,
        description: [task.source, task.group].filter(Boolean).join(" · "),
        detail: task.detail ?? task.commandLine,
      })),
      placeHolder: t("tasks.pick"),
      canPickMany: false,
    });
    const task = typeof picked === "number" ? tasks[picked] : undefined;
    if (task) await this.confirmAndRun(task);
  }

  /** `tasks/execute` from an extension: the same confirmation as a picked task. */
  async execute(params: Record<string, unknown>): Promise<{ started: boolean; reason?: string }> {
    const task = params.task as ExtensionTask | undefined;
    if (!task || typeof task.commandLine !== "string" || task.extension !== params.extension) {
      return { started: false, reason: "Invalid task." };
    }
    return this.confirmAndRun(task);
  }

  /** Shows the task and runs it after the user confirmed (the picker of Run Task... calls this too). */
  async confirmAndRun(task: ExtensionTask): Promise<{ started: boolean; reason?: string }> {
    if (!task.cwdInsideFolder && !(task.kind === "custom" && task.cwd === null)) {
      const reason = t("extTask.outside", { folder: task.cwd ?? t("common.none") });
      this.deps.notice(reason);
      return { started: false, reason };
    }
    const notes = [
      t("extTask.note"),
      ...(await this.deps.matcherNotes?.(task) ?? []),
      ...(task.problemMatchers.length > 0 && !this.deps.reportProblems
        ? [t("extTask.matchers", { list: task.problemMatchers.join(", ") })]
        : []),
      ...(task.isBackground ? [t("extTask.background")] : []),
    ];
    const answer = await this.deps.confirm({
      extension: task.extension,
      title: t("tasks.confirm.title", { label: task.name }),
      details: taskDetails(task),
      notes,
      buttons: [t("tasks.confirm.run")],
    });
    if (answer !== t("tasks.confirm.run")) return { started: false, reason: "The user cancelled the task." };
    return this.run(task);
  }

  private async run(task: ExtensionTask): Promise<{ started: boolean; reason?: string }> {
    if (task.kind === "custom") {
      this.custom.set(task.handle, this.problems(task));
      let result: unknown;
      try { result = await this.deps.host.request("host/executeCustomTask", { handle: task.handle }); }
      catch (error) { this.customFinished({ handle: task.handle }); throw error; }
      if (!result || typeof result !== "object" || !("started" in result) || result.started !== true) { this.customFinished({ handle: task.handle }); return { started: false, reason: "The custom task did not start." }; }
      return { started: true };
    }
    if (this.deps.startTask) {
      const problems = this.problems(task), decoder = new TextDecoder();
      const started = await this.deps.startTask(task, bytes => { problems.capture(decoder.decode(bytes, { stream: true })); });
      if (!started) { problems.finish(); return { started: false, reason: "The task process could not be started." }; }
      const off = started.disposeOutput;
      this.running.set(task.handle, { task, sessionId: started.sessionId, finish: () => { off?.(); problems.capture(decoder.decode()); problems.finish(); } });
      this.deps.notifyHost("host/taskStarted", { handle: task.handle, pid: started.pid });
      this.onSessionsChanged();
      return { started: true };
    }
    const sessionId = await this.deps.terminals.createTerminal(undefined, task.cwd, {
      // The extension holds this terminal's id: it is never restarted for new runtimes.
      refreshable: false,
      title: t("tasks.terminalName", { label: task.name }),
      show: true,
    });
    if (sessionId === null) return { started: false, reason: "The terminal could not be started." };
    const session = this.deps.terminals.getState().sessions.find((s) => s.id === sessionId);
    const line = session ? taskLine(task, session.shell) : null;
    if (line === null) {
      const reason = t("extTask.unsafeEnv");
      this.deps.notice(reason);
      return { started: false, reason };
    }
    const problems = this.problems(task), decoder = new TextDecoder();
    const off = this.deps.terminals.onOutput?.(sessionId, bytes => { problems.capture(decoder.decode(bytes, { stream: true })); });
    this.running.set(task.handle, { task, sessionId, finish: () => { off?.(); problems.capture(decoder.decode()); problems.finish(); } });
    // The host hears "started" before the answer, so `executeTask` resolves with the execution.
    this.deps.notifyHost("host/taskStarted", { handle: task.handle });
    this.deps.terminals.write(sessionId, `${line}\r`);
    this.deps.log?.(`[${task.extension}] task "${task.name}": ${task.commandLine}`);
    return { started: true };
  }

  /** `tasks/terminate`: the extension stops its task (its terminal closes). */
  async terminate(params: Record<string, unknown>): Promise<void> {
    const running = this.running.get((typeof params.handle === "string" ? params.handle : ""));
    if (running) await this.deps.terminals.closeTerminal(running.sessionId);
  }

  private onSessionsChanged(): void {
    const sessions = this.deps.terminals.getState().sessions;
    for (const [handle, running] of [...this.running]) {
      const session = sessions.find((s) => s.id === running.sessionId);
      if (session && !session.exited) continue;
      this.running.delete(handle); running.finish?.();
      this.deps.notifyHost("host/taskEnded", { handle, exitCode: session?.exitCode ?? null });
    }
  }
}

