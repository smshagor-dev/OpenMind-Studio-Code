import { invoke } from "@tauri-apps/api/core";

import type { TerminalSessionInfo } from "../ipc";

// Mirrors src-tauri/src/commands/deps.rs and crates/deps (serde camelCase).

/** What the 22.4 missing-package card installs (mapped onto a `DepsOp`). */
export type InstallKind = "pip" | "pipOffline" | "pipRequirements" | "npm" | "npmProject";

/** An operation the backend plans and runs; never a command line. */
export type DepsOp =
  | { op: "pythonCreateEnv" }
  | { op: "pythonInstallRequirements" }
  | { op: "pythonInstallPyproject" }
  | { op: "pythonAdd"; packages: string; offline: boolean }
  | { op: "pythonRemove"; package: string }
  | { op: "pythonUpdate"; package: string }
  | { op: "nodeInstall" }
  | { op: "nodeAdd"; package: string; dev: boolean }
  | { op: "nodeRemove"; package: string }
  | { op: "nodeUpdate"; package: string }
  | { op: "nodeRunScript"; script: string }
  | { op: "composerInstall" }
  | { op: "composerRequire"; package: string; dev: boolean }
  | { op: "composerRemove"; package: string }
  | { op: "composerUpdate"; package: string }
  | { op: "composerDumpAutoload" }
  | { op: "cargo"; command: "check" | "build" | "test" | "run" }
  | { op: "maven"; goal: "compile" | "test" | "package" }
  | { op: "gradle"; task: "build" | "test" }
  | { op: "cmakeConfigure"; preset: string | null }
  | { op: "cmakeBuild" }
  | { op: "cmakeClean" };

export interface DepsRequest {
  /** A file or folder inside the project (the project folder from the view). */
  base: string;
  op: DepsOp;
  /** `openmind` or one of the project's environment folders; `null` = the project's own, else OpenMind's. */
  pythonEnv?: string | null;
  /** The chosen package manager when the project's lock files disagree. */
  nodeManager?: string | null;
}

export type Network = "required" | "offline" | "may" | "none";

/** Exactly what an operation runs — shown before anything happens. */
export interface DepsPlan {
  manager: string;
  action: string;
  packages: string[];
  program: string;
  source: string;
  args: string[];
  command: string;
  cwd: string;
  target: string;
  network: Network;
  notes: string[];
}

export interface Dep {
  name: string;
  spec: string;
  installed: string | null;
}

export interface PythonEnv {
  name: string;
  interpreter: string;
  version: string | null;
  fromOpenmind: boolean;
}

export interface PythonInfo {
  manifests: string[];
  environments: PythonEnv[];
  requirements: Dep[];
  missing: string[];
  installed: { name: string; version: string }[];
  skipped: string[];
  notes: string[];
}

export interface NodeInfo {
  packageManager: string | null;
  conflict: string | null;
  lockfiles: string[];
  dependencies: Dep[];
  devDependencies: Dep[];
  scripts: { name: string; command: string; runnable: boolean }[];
  nodeModules: boolean;
  notes: string[];
}

export interface PhpInfo {
  lock: boolean;
  vendor: boolean;
  require: Dep[];
  requireDev: Dep[];
  platform: Dep[];
}

export interface RustInfo {
  name: string | null;
  version: string | null;
  edition: string | null;
  dependencies: Dep[];
  devDependencies: Dep[];
  features: string[];
  lock: boolean;
  workspaceOnly: boolean;
}

export interface JavaInfo {
  maven: boolean;
  gradle: boolean;
  kotlinDsl: boolean;
  gradleWrapper: boolean;
}

export interface CmakeInfo {
  presets: string[];
  configured: boolean;
}

export type SetupKind = "pythonNoEnv" | "nodeNotInstalled" | "composerNotInstalled";

export interface ProjectDeps {
  root: string;
  name: string;
  path: string;
  python: PythonInfo | null;
  node: NodeInfo | null;
  php: PhpInfo | null;
  rust: RustInfo | null;
  java: JavaInfo | null;
  cmake: CmakeInfo | null;
  setup: { kind: SetupKind }[];
}

export interface DepsSnapshot {
  projects: ProjectDeps[];
}

export interface ProjectInfo {
  pythonProject: string;
  requirementsTxt: string | null;
  pyprojectToml: string | null;
  /** Where Python packages would go; `null`: nowhere safe yet (install OpenMind's Python or create a .venv). */
  pythonTarget: "projectVenv" | "openmindPython" | null;
  nodeProject: string;
  packageJson: string | null;
}

export interface DepsIpc {
  depsPlan: (request: DepsRequest) => Promise<DepsPlan>;
  /** Starts the confirmed operation as a new terminal's own program (planned again by the backend). */
  depsRun: (request: DepsRequest, cols: number, rows: number) => Promise<TerminalSessionInfo>;
  depsProjectInfo: (base: string) => Promise<ProjectInfo>;
}

export const tauriDepsIpc: DepsIpc = {
  depsPlan: (request) => invoke<DepsPlan>("deps_plan", { request }),
  depsRun: (request, cols, rows) => invoke<TerminalSessionInfo>("deps_run", { request, cols, rows }),
  depsProjectInfo: (base) => invoke<ProjectInfo>("deps_project_info", { base }),
};
