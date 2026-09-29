import { invoke } from "@tauri-apps/api/core";

// Mirrors src-tauri/src/commands/deps.rs (serde camelCase).

export type InstallKind = "pip" | "pipOffline" | "pipRequirements" | "npm" | "npmProject";

export interface InstallPlan {
  argv: string[];
  /** The project folder the command runs in. */
  cwd: string;
  target: "projectVenv" | "openmindPython" | "npm";
  /** The interpreter a Python package goes into (absolute path). */
  interpreter: string | null;
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
  depsInstallPlan: (kind: InstallKind, packages: string | null, base: string) => Promise<InstallPlan>;
  depsProjectInfo: (base: string) => Promise<ProjectInfo>;
}

export const tauriDepsIpc: DepsIpc = {
  depsInstallPlan: (kind, packages, base) => invoke<InstallPlan>("deps_install_plan", { kind, packages, base }),
  depsProjectInfo: (base) => invoke<ProjectInfo>("deps_project_info", { base }),
};
