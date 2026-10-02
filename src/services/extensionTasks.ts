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
  kind: "shell" | "process";
  cwd: string | null;
  cwdInsideFolder: boolean;
  env: Record<string, string>;
  problemMatchers: string[];
  isBackground: boolean;
}

export interface ExtensionTaskDeps {
  host: {
    activateFor: (trigger: ActivationTrigger, report?: boolean) => Promise<ActivationResult[]>;
    request: (method: string, params: unknown) => Promise<unknown>;
    needsHost: () => boolean;
  };
  terminals: Pick<TerminalService, "createTerminal" | "write" | "getState" | "subscribe" | "closeTerminal">;
  quickPick: (request: Omit<QuickPickPrompt, "kind" | "id">) => Promise<number | number[] | null>;
  confirm: (request: Omit<ConfirmPrompt, "kind" | "id">) => Promise<string | null>;
  notifyHost: (method: string, params: unknown) => void;
  notice: (message: string) => void;
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
}

/**
 * Tasks extensions provide (`tasks.registerTaskProvider`, Milestone 18). Nothing is asked for or run in the
 * background: Terminal > Run Task... (`tasks.run`) wakes the task providers, lists their tasks, and the chosen one is
 * shown in a confirmation (command, folder, environment, what isn't supported) before it runs in a new terminal. An
 * extension's own `tasks.executeTask` goes through the same confirmation. Problem matchers are not supported (said in
 * the confirmation). A task ends when its terminal is closed or its shell exits. UI-free.
 */
export class ExtensionTaskService {
  private readonly running = new Map<string, Running>();

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
    if (!task.cwdInsideFolder) {
      const reason = t("extTask.outside", { folder: task.cwd ?? t("common.none") });
      this.deps.notice(reason);
      return { started: false, reason };
    }
    const notes = [
      t("extTask.note"),
      ...(task.problemMatchers.length > 0
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
    this.running.set(task.handle, { task, sessionId });
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
      this.running.delete(handle);
      this.deps.notifyHost("host/taskEnded", { handle, exitCode: session?.exitCode ?? null });
    }
  }
}
