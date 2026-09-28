import { translateBackend } from "../i18n/backendText";
import type { ConfirmPrompt, QuickPickPrompt } from "./extensionPromptService";
import type { ExtensionTask } from "./extensionTasks";
import type { IpcClient } from "./ipc";
import type { Problem } from "./markerService";
import type { ShellKindName, TaskProblem, TaskStep, WorkspaceTaskInfo } from "./workflowIpc";
import { t } from "../i18n";

/** What the task runner needs from the terminals. */
export interface TaskTerminals {
  createTaskTerminal: (
    title: string,
    start: (
      cols: number,
      rows: number,
    ) => Promise<{ id: string; shell: ShellKindName; cwd: string }>,
    show: boolean,
  ) => Promise<string | null>;
  onOutput: (id: string, listener: (data: Uint8Array) => void) => () => void;
  waitForExit: (id: string) => Promise<number | null>;
  closeTerminal: (id: string) => Promise<void>;
  setActive: (id: string) => void;
  lastShell: () => ShellKindName | null;
}

export interface WorkspaceTaskDeps {
  ipc: Pick<
    IpcClient,
    "tasksList" | "tasksPlan" | "taskRunStep" | "tasksProblems" | "settingsGet" | "settingsSet"
  >;
  terminals: TaskTerminals;
  confirm: (request: Omit<ConfirmPrompt, "kind" | "id">) => Promise<string | null>;
  quickPick: (request: Omit<QuickPickPrompt, "kind" | "id">) => Promise<number | number[] | null>;
  /** Problems from a task's output (owner `task:<label>`), in the Problems panel. */
  setProblems: (
    owner: string,
    files: { path: string; title: string; problems: Problem[] }[],
  ) => void;
  activeFile: () => string | null;
  notice: (message: string) => void;
  log: (line: string) => void;
  /** Tasks extensions provide (Milestone 18), listed in the same picker. */
  extensionTasks?: {
    list: () => Promise<ExtensionTask[]>;
    confirmAndRun: (task: ExtensionTask) => Promise<unknown>;
  };
}

export interface RunningTask {
  id: string;
  label: string;
  terminalId: string;
}

/** The confirmation's buttons in English (the dialog shows them in the UI language; see `runTaskLabel`). */
export const RUN_TASK = "Run Task";
export const RUN_ALWAYS = "Run and Don't Ask Again for This Task";
const runTaskLabel = () => t("tasks.confirm.run");
const runAlwaysLabel = () => t("tasks.confirm.runAlways");
const RECENT_KEY = "tasks.recent";
const APPROVED_KEY = "tasks.approved";
const MAX_OUTPUT = 4 * 1024 * 1024;

function shortPath(path: string): string {
  return path.replace(/\\/g, "/").split("/").slice(-2).join("/");
}

function fileName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

/** Task problems grouped by file for the Problems panel. */
export function problemFiles(
  problems: TaskProblem[],
): { path: string; title: string; problems: Problem[] }[] {
  const byFile = new Map<string, Problem[]>();
  for (const found of problems) {
    const list = byFile.get(found.file) ?? [];
    list.push({
      severity: found.severity,
      message: found.code ? `${found.message} (${found.code})` : found.message,
      source: found.source,
      line: found.line,
      column: found.column,
      endLine: found.line,
      endColumn: found.column + 1,
    });
    byFile.set(found.file, list);
  }
  return [...byFile.entries()].map(([path, list]) => ({
    path,
    title: fileName(path),
    problems: list,
  }));
}

/** The confirmation of a task: every step with command, folder, environment, source, risks and unsupported parts. */
export function confirmationOf(
  task: WorkspaceTaskInfo,
  steps: TaskStep[],
): Omit<ConfirmPrompt, "kind" | "id"> {
  const details = steps.flatMap((step, index) => {
    const prefix = steps.length > 1 ? `${String(index + 1)}. ${step.label}: ` : "";
    const env = Object.entries(step.env);
    return [
      {
        label: `${prefix}${t("tasks.confirm.command")}`,
        value: step.commandLine === "" ? t("tasks.confirm.dependenciesOnly") : step.commandLine,
      },
      { label: `${prefix}${t("tasks.confirm.folder")}`, value: step.cwd },
      ...(env.length > 0
        ? [
            {
              label: `${prefix}${t("tasks.confirm.environment")}`,
              value: env.map(([k, v]) => `${k}=${v}`).join("  "),
            },
          ]
        : []),
    ];
  });
  details.push({ label: t("tasks.confirm.from"), value: shortPath(task.source) });
  const notes = [
    ...new Set([
      ...steps.flatMap((step) => step.risks.map(translateBackend)),
      t("tasks.confirm.eachStep"),
      ...steps.flatMap((step) =>
        step.matchers
          .filter((m) => !m.supported)
          .map((m) => m.reason ?? t("tasks.confirm.matcherUnsupported", { name: m.name })),
      ),
      ...steps.flatMap((step) => step.notes),
    ]),
  ];
  return {
    extension: shortPath(task.source),
    title: t("tasks.confirm.title", { label: task.label }),
    details,
    notes,
    buttons: [runTaskLabel(), runAlwaysLabel()],
  };
}

/**
 * The folder's own tasks (`.openmind/tasks.json`, `.vscode/tasks.json`), Milestone 19. Nothing runs by itself: a task
 * runs from Terminal > Run Task... (or Run Build/Test Task), after the user saw what it runs — every step, its folder,
 * environment and risks — and confirmed (a task the user said "don't ask again" for runs without asking, unless it
 * changed or has a risk). Each step runs as the program of a new terminal; a failing step stops the chain; problem
 * matchers turn the output into Problems. UI-free.
 */
export class WorkspaceTaskService {
  private running: RunningTask[] = [];
  private recent: string[] | null = null;
  private approved: string[] | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: WorkspaceTaskDeps) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getRunning(): readonly RunningTask[] {
    return this.running;
  }

  async list(): Promise<WorkspaceTaskInfo[]> {
    try {
      const listing = await this.deps.ipc.tasksList(this.deps.activeFile());
      for (const file of listing.files) {
        if (file.error) this.deps.log(`${shortPath(file.path)}: ${file.error}`);
        for (const note of file.notes) this.deps.log(`${shortPath(file.path)}: ${note}`);
      }
      return listing.tasks.filter((task) => !task.hide);
    } catch (error) {
      this.deps.notice(t("tasks.unreadable", { error: String(error) }));
      return [];
    }
  }

  private async loadList(key: string): Promise<string[]> {
    try {
      const raw = await this.deps.ipc.settingsGet(key);
      const value: unknown = raw === null ? [] : JSON.parse(raw);
      return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  }

  /** Terminal > Run Task...: the folder's tasks (recent first) and the extensions' tasks. */
  async pickAndRun(group?: "build" | "test"): Promise<void> {
    this.recent ??= await this.loadList(RECENT_KEY);
    const recent = this.recent;
    const own = (await this.list())
      .filter((task) => group === undefined || task.group === group)
      .sort((a, b) => {
        const rank = (t: WorkspaceTaskInfo) =>
          recent.includes(t.id) ? recent.indexOf(t.id) : 1000;
        return rank(a) - rank(b);
      });
    if (group !== undefined) {
      const preferred = own.find((task) => task.isDefault);
      if (preferred) {
        await this.run(preferred);
        return;
      }
    }
    const extension = group === undefined ? ((await this.deps.extensionTasks?.list()) ?? []) : [];
    if (own.length === 0 && extension.length === 0) {
      this.deps.notice(
        group === undefined
          ? t("tasks.none")
          : t("tasks.noneInGroup", { group }),
      );
      return;
    }
    const picked = await this.deps.quickPick({
      extension: "OpenMind Studio",
      placeHolder:
        group === undefined ? t("tasks.pick") : t("tasks.pickInGroup", { group }),
      canPickMany: false,
      items: [
        ...own.map((task) => ({
          label: `${task.problem ? "⚠ " : ""}${task.label}`,
          description: [
            shortPath(task.source),
            task.group,
            recent.includes(task.id) ? t("tasks.recent") : null,
          ]
            .filter(Boolean)
            .join(" · "),
          detail: task.problem ?? task.detail ?? task.commandLine ?? "",
        })),
        ...extension.map((task) => ({
          label: task.name,
          description: `${task.source} · ${t("tasks.extension")}`,
          detail: task.detail ?? task.commandLine,
        })),
      ],
    });
    if (typeof picked !== "number") return;
    const task = own[picked];
    if (task) await this.run(task);
    else {
      const provided = extension[picked - own.length];
      if (provided) await this.deps.extensionTasks?.confirmAndRun(provided);
    }
  }

  /** Plans, confirms and runs one task (with its dependencies first). */
  async run(task: WorkspaceTaskInfo): Promise<boolean> {
    if (task.problem) {
      this.deps.notice(task.problem);
      return false;
    }
    let steps: TaskStep[];
    try {
      steps = (
        await this.deps.ipc.tasksPlan(
          task.id,
          this.deps.activeFile(),
          this.deps.terminals.lastShell(),
        )
      ).steps;
    } catch (error) {
      this.deps.notice(String(error).replace(/^Error: /, ""));
      return false;
    }
    if (!(await this.approve(task, steps))) return false;
    await this.remember(RECENT_KEY, task.id, 5);
    return this.execute(task, steps);
  }

  private async approve(task: WorkspaceTaskInfo, steps: TaskStep[]): Promise<boolean> {
    this.approved ??= await this.loadList(APPROVED_KEY);
    const approved = this.approved;
    const risky = steps.some((step) => step.risks.length > 0);
    if (!risky && steps.every((step) => approved.includes(step.fingerprint))) return true;
    const answer = await this.deps.confirm(confirmationOf(task, steps));
    if (answer === null) return false;
    if (answer === runAlwaysLabel()) {
      for (const step of steps) await this.remember(APPROVED_KEY, step.fingerprint, 200);
    }
    return true;
  }

  private async remember(key: string, value: string, max: number): Promise<void> {
    const list = key === RECENT_KEY ? (this.recent ??= []) : (this.approved ??= []);
    const next = [value, ...list.filter((v) => v !== value)].slice(0, max);
    if (key === RECENT_KEY) this.recent = next;
    else this.approved = next;
    await this.deps.ipc.settingsSet(key, JSON.stringify(next)).catch(() => undefined);
  }

  /** Runs the steps in order; a step that fails stops the chain. */
  private async execute(task: WorkspaceTaskInfo, steps: TaskStep[]): Promise<boolean> {
    for (const [index, step] of steps.entries()) {
      if (step.program === "") continue;
      const code = await this.runStep(task, step, index === 0);
      if (step.isBackground) return true;
      if (code !== 0) {
        const rest = steps.length - index - 1;
        this.deps.notice(
          (code === null
            ? t("tasks.stepStopped", { label: step.label })
            : t("tasks.stepFailed", { label: step.label, code })) +
            (rest > 0 ? t("tasks.restSkipped", { count: rest }) : "."),
        );
        return false;
      }
    }
    return true;
  }

  private async runStep(
    task: WorkspaceTaskInfo,
    step: TaskStep,
    first: boolean,
  ): Promise<number | null> {
    const shell = this.deps.terminals.lastShell();
    const terminalId = await this.deps.terminals.createTaskTerminal(
      t("tasks.terminalName", { label: step.label }),
      (cols, rows) =>
        this.deps.ipc.taskRunStep(task.id, step.label, this.deps.activeFile(), shell, cols, rows),
      first,
    );
    if (terminalId === null) return null;
    this.deps.log(`Task "${step.label}": ${step.commandLine} (in ${step.cwd})`);
    const owner = `task:${step.label}`;
    this.deps.setProblems(owner, []);
    const decoder = new TextDecoder();
    let output = "";
    const off = this.deps.terminals.onOutput(terminalId, (data) => {
      output += decoder.decode(data, { stream: true });
      if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
    });
    this.running = [...this.running, { id: task.id, label: step.label, terminalId }];
    this.notify();
    const code = await this.deps.terminals.waitForExit(terminalId);
    off();
    this.running = this.running.filter((r) => r.terminalId !== terminalId);
    this.notify();
    this.deps.log(
      `Task "${step.label}" ended${code === null ? "" : ` with exit code ${String(code)}`}.`,
    );
    const matchers = step.problemMatchers.filter((_, i) => step.matchers[i]?.supported === true);
    if (matchers.length > 0 && output !== "") {
      const problems = await this.deps.ipc
        .tasksProblems(matchers, output, step.cwd)
        .catch(() => []);
      this.deps.setProblems(owner, problemFiles(problems));
    }
    return code;
  }

  /** Terminal > Terminate Task...: ends a running task (its terminal closes). */
  async terminate(): Promise<void> {
    const target = await this.pickRunning(t("tasks.pickToStop"));
    if (target) await this.deps.terminals.closeTerminal(target.terminalId);
  }

  /** Terminal > Show Running Tasks...: brings a running task's terminal to the front. */
  async showRunning(): Promise<void> {
    const target = await this.pickRunning(t("tasks.running"));
    if (target) this.deps.terminals.setActive(target.terminalId);
  }

  private async pickRunning(placeHolder: string): Promise<RunningTask | null> {
    if (this.running.length === 0) {
      this.deps.notice(t("tasks.noneRunning"));
      return null;
    }
    if (this.running.length === 1) return this.running[0] ?? null;
    const picked = await this.deps.quickPick({
      extension: "OpenMind Studio",
      placeHolder,
      canPickMany: false,
      items: this.running.map((r) => ({ label: r.label, description: "", detail: "" })),
    });
    return typeof picked === "number" ? (this.running[picked] ?? null) : null;
  }

  /** The folder closes: its running tasks end with it. */
  async stopAll(): Promise<void> {
    for (const task of [...this.running]) await this.deps.terminals.closeTerminal(task.terminalId);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
