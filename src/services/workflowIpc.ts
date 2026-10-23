import { invoke } from "@tauri-apps/api/core";

import type { LaunchConfig } from "./ipc";

// Mirrors src-tauri::commands::{debug (debug_configurations), tasks, notebook} and the openmind_dap::launch,
// openmind_tasks and openmind_notebook types (serde camelCase). Milestone 19.

/** One configuration of a launch.json. `config` is set when it can run; otherwise `problem` says why. */
export interface DiscoveredConfig {
  name: string;
  source: string;
  typeName: string;
  request: string;
  config: LaunchConfig | null;
  problem: string | null;
  notes: string[];
}

export interface LaunchCompound {
  name: string;
  configurations: string[];
  problem: string;
}

export interface LaunchFile {
  path: string;
  configurations: DiscoveredConfig[];
  compounds: LaunchCompound[];
  error: string | null;
}

export interface ExtensionDebugger {
  kind: string;
  label: string | null;
  extension: string;
}

export interface DebugConfigurations {
  files: LaunchFile[];
  extensionDebuggers: ExtensionDebugger[];
}

/** What the debug adapter can do (from its `initialize` answer). */
export interface DebugCapabilities {
  conditionalBreakpoints: boolean;
  hitConditionalBreakpoints: boolean;
  logPoints: boolean;
  loadedSources: boolean;
  modules: boolean;
}

export interface SourceBreakpoint {
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

export interface MatcherInfo {
  name: string;
  supported: boolean;
  reason: string | null;
}

export interface WorkspaceTaskInfo {
  id: string;
  label: string;
  source: string;
  typeName: string;
  commandLine: string | null;
  cwd: string | null;
  group: string | null;
  isDefault: boolean;
  dependsOn: string[];
  isBackground: boolean;
  matchers: MatcherInfo[];
  notes: string[];
  problem: string | null;
  detail: string | null;
  hide: boolean;
}

export interface TaskFileInfo {
  path: string;
  error: string | null;
  notes: string[];
}

export interface TaskListing {
  folder: string | null;
  files: TaskFileInfo[];
  tasks: WorkspaceTaskInfo[];
}

export interface TaskStep {
  label: string;
  source: string;
  kind: "shell" | "process";
  commandLine: string;
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  isBackground: boolean;
  matchers: MatcherInfo[];
  problemMatchers: unknown[];
  risks: string[];
  notes: string[];
  fingerprint: string;
}

export interface TaskProblem {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info";
  message: string;
  code: string | null;
  source: string;
}

export type ShellKindName = "powerShell" | "cmd" | "gitBash" | "wsl";

export interface TaskTerminalInfo {
  id: string;
  shell: ShellKindName;
  cwd: string;
  pid: number | null;
}

export type NotebookCellKind = "code" | "markdown" | "raw";

export interface NotebookCell {
  index: number;
  id: string | null;
  kind: NotebookCellKind;
  source: string;
  executionCount: number | null;
  outputs: Record<string, unknown>[];
}

export interface NotebookModel {
  nbformat: number;
  nbformatMinor: number;
  language: string;
  kernelName: string | null;
  cells: NotebookCell[];
}

export interface OpenedNotebook {
  model: NotebookModel;
  fingerprint: string;
  trusted: boolean;
  /** The interpreter of the kernel already running for it, if any. */
  kernel: string | null;
}

export interface NotebookCellEdit {
  origin: number | null;
  kind: NotebookCellKind;
  source: string;
  executionCount: number | null;
  outputs: Record<string, unknown>[] | null;
}

export interface KernelCandidate {
  interpreter: string;
  label: string;
  source: "project" | "portable" | "system";
  hasIpykernel: boolean;
}

export interface CellResult {
  ok: boolean;
  executionCount: number | null;
  outputs: Record<string, unknown>[];
}

export interface WorkflowIpc {
  extensionTaskRun?: (task: { kind: string; commandLine: string; shellCommand?: string | null; shellArgs?: string[]; program?: string | null; args?: string[]; cwd: string; env: Record<string, string> }, shell: ShellKindName | null, cols: number, rows: number) => Promise<TaskTerminalInfo>;
  tasksMatcherInfo?: (matchers: unknown[]) => Promise<{ name: string; supported: boolean; reason: string | null }[]>;
  debugConfigurations: (activeFile: string | null) => Promise<DebugConfigurations>;
  tasksList: (activeFile: string | null) => Promise<TaskListing>;
  tasksPlan: (
    id: string,
    activeFile: string | null,
    shell: ShellKindName | null,
  ) => Promise<{ steps: TaskStep[] }>;
  taskRunStep: (
    id: string,
    label: string,
    activeFile: string | null,
    shell: ShellKindName | null,
    cols: number,
    rows: number,
  ) => Promise<TaskTerminalInfo>;
  tasksProblems: (matchers: unknown[], output: string, cwd: string) => Promise<TaskProblem[]>;
  notebookOpen: (path: string) => Promise<OpenedNotebook>;
  notebookSave: (
    path: string,
    cells: NotebookCellEdit[],
    fingerprint: string,
    overwrite: boolean,
  ) => Promise<{ fingerprint: string }>;
  notebookSetTrust: (path: string, trusted: boolean) => Promise<boolean>;
  notebookKernels: () => Promise<KernelCandidate[]>;
  notebookKernelStart: (path: string, interpreter: string) => Promise<string>;
  notebookKernelStop: (path: string) => Promise<void>;
  notebookExecute: (
    path: string,
    cellIndex: number,
    code: string,
    fingerprint: string,
  ) => Promise<CellResult>;
}

export const tauriWorkflowIpc: WorkflowIpc = {
  extensionTaskRun: (task, shell, cols, rows) => invoke<TaskTerminalInfo>("extension_task_run", { task, shell, cols, rows }),
  tasksMatcherInfo: matchers => invoke("tasks_matcher_info", { matchers }),
  debugConfigurations: (activeFile) =>
    invoke<DebugConfigurations>("debug_configurations", { activeFile }),
  tasksList: (activeFile) => invoke<TaskListing>("tasks_list", { activeFile }),
  tasksPlan: (id, activeFile, shell) =>
    invoke<{ steps: TaskStep[] }>("tasks_plan", { id, activeFile, shell }),
  taskRunStep: (id, label, activeFile, shell, cols, rows) =>
    invoke<TaskTerminalInfo>("task_run_step", { id, label, activeFile, shell, cols, rows }),
  tasksProblems: (matchers, output, cwd) =>
    invoke<TaskProblem[]>("tasks_problems", { matchers, output, cwd }),
  notebookOpen: (path) => invoke<OpenedNotebook>("notebook_open", { path }),
  notebookSave: (path, cells, fingerprint, overwrite) =>
    invoke<{ fingerprint: string }>("notebook_save", { path, cells, fingerprint, overwrite }),
  notebookSetTrust: (path, trusted) => invoke<boolean>("notebook_set_trust", { path, trusted }),
  notebookKernels: () => invoke<KernelCandidate[]>("notebook_kernels"),
  notebookKernelStart: (path, interpreter) =>
    invoke<string>("notebook_kernel_start", { path, interpreter }),
  notebookKernelStop: (path) => invoke("notebook_kernel_stop", { path }).then(() => undefined),
  notebookExecute: (path, cellIndex, code, fingerprint) =>
    invoke<CellResult>("notebook_execute", { path, cellIndex, code, fingerprint }),
};

