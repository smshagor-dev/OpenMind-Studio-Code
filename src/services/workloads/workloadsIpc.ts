import { invoke } from "@tauri-apps/api/core";

// Mirrors openmind_workloads and src-tauri/src/commands/workloads.rs (serde camelCase).

export type ComponentState =
  | "installed"
  | "available"
  | "heavySdk"
  | "externalRequired"
  | "manualInstall"
  | "adminRequired"
  | "unsupportedArchitecture"
  | "planned";

export type ComponentCategory =
  | "runtime"
  | "sdk"
  | "packageManager"
  | "framework"
  | "languageServer"
  | "debugger"
  | "formatter"
  | "linter"
  | "database"
  | "tool";

export type Provision =
  | { type: "runtime"; id: string }
  | { type: "includedWith"; runtime: string }
  | { type: "lspBundled"; server: string }
  | { type: "lspOnRequest"; server: string }
  | { type: "project"; command: string }
  | { type: "builtIn" }
  | { type: "external"; admin: boolean }
  | { type: "planned" };

export interface ComponentView {
  id: string;
  name: string;
  category: ComponentCategory;
  provision: Provision;
  requires: string[];
  state: ComponentState;
  version: string | null;
  source: string;
  runtime: string | null;
  found: string | null;
  downloadBytes: number | null;
  installBytes: number | null;
  reason: string | null;
  command: string | null;
  licenseAcceptance: boolean;
}

export interface Workload {
  id: string;
  name: string;
  summary: string;
  components: string[];
  frameworks: string[];
}

export interface Pack {
  id: string;
  name: string;
  components: string[];
}

export interface FrameworkView {
  id: string;
  name: string;
  needs: string[];
  missing: string[];
}

export interface WorkloadCatalog {
  workloads: Workload[];
  packs: Pack[];
  frameworks: FrameworkView[];
  components: ComponentView[];
  installRoot: string;
  offlineFolder: string;
  platform: string;
}

export interface Selection {
  workloads: string[];
  add: string[];
  remove: string[];
}

export type WarningKind =
  | "heavySdk"
  | "externalRequired"
  | "adminRequired"
  | "manualInstall"
  | "planned"
  | "unsupportedArchitecture"
  | "licenseAcceptance"
  | "dependencyAdded"
  | "missingDependency";

export interface Warning {
  kind: WarningKind;
  component: string;
  neededBy: string | null;
}

export interface Plan {
  components: string[];
  install: string[];
  downloadBytes: number;
  installBytes: number;
  unknownSizes: number;
  licenses: string[];
  warnings: Warning[];
}

export interface WorkloadsIpc {
  workloadsCatalog: () => Promise<WorkloadCatalog>;
  workloadsPlan: (selection: Selection) => Promise<Plan>;
  workloadsFirstRun: () => Promise<boolean>;
  workloadsFirstRunDone: () => Promise<void>;
  runtimeVerify: (kind: string) => Promise<string>;
}

export const tauriWorkloadsIpc: WorkloadsIpc = {
  workloadsCatalog: () => invoke<WorkloadCatalog>("workloads_catalog"),
  workloadsPlan: (selection) => invoke<Plan>("workloads_plan", { selection }),
  workloadsFirstRun: () => invoke<boolean>("workloads_first_run"),
  workloadsFirstRunDone: () => invoke<undefined>("workloads_first_run_done").then(() => undefined),
  runtimeVerify: (kind) => invoke<string>("runtime_verify", { kind }),
};
