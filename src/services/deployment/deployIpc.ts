import { invoke } from "@tauri-apps/api/core";

/** `openmind_deploy::Arch`. */
export type DeployArch = "x64" | "x86" | "arm64";
export type DeploymentKind = "networkShare" | "packageSource";
export type PackageKind = "installer" | "portable";
/** `openmind_deploy::discover::Outcome`. */
export type SearchOutcome =
  | "found"
  | "nothingFound"
  | "protocolIncompatible"
  | "networkBlocked"
  | "discoveryUnavailable";
/** `deploy::checks::Status`. */
export type CheckStatus = "pass" | "fail" | "blocked" | "notTested";
/** How a computer is provisioned from a deployment (`deploy_provision`'s `kind`). */
export type ProvisionKind = "share" | "setup" | "portable";

/** `deploy::local::ThisCopy`. */
export interface ThisCopy {
  exe: string;
  installDir: string;
  universalDir: string;
  onNetwork: boolean;
  layout: "portable" | "perUser" | "perMachine" | "network";
  dataScope: string;
  version: string;
  buildArch: DeployArch;
  osArch: DeployArch;
  hostname: string;
  user: string;
  profileId: string;
  dataRoot: string;
  dbPath: string;
  logsDir: string;
  tempDir: string;
  cacheDir: string;
  runtimesDir: string;
  runtimeStore: "local" | "shared";
  packagesDir: string;
}

export interface PackageEntry {
  name: string;
  kind: PackageKind;
  arch: DeployArch;
  version: string;
  size: number;
  sha256: string;
  signature: string;
}

export interface Manifest {
  deploymentId: string;
  appVersion: string;
  platform: string;
  arch: DeployArch;
  kind: DeploymentKind;
  sharePath?: string;
  packages: PackageEntry[];
  runtimes: { kind: string; version: string }[];
}

export interface DeploymentView {
  id: string;
  manifest: Manifest;
  sources: { address: string; appVersion: string; secondsAgo: number; servesPackages: boolean }[];
  incompatible: string | null;
  manifestError: string | null;
  /** Whether this computer's user trusted it; nothing is provisioned from an untrusted deployment. */
  trusted: boolean;
}

export interface SearchView {
  outcome: SearchOutcome;
  found: number;
  targets: string[];
  sent: number;
  sendErrors: string[];
  socketError: string | null;
  incompatible: string[];
  malformed: number;
  elapsedMs: number;
}

export interface OfferView {
  on: boolean;
  discoveryAddress: string | null;
  packageAddress: string | null;
  kind: DeploymentKind | null;
  deploymentId: string | null;
  packages: string[];
  runtimes: number;
  problems: string[];
  error: string | null;
}

export interface DeployStatus {
  copy: ThisCopy;
  offer: OfferView;
  deployments: DeploymentView[];
  lastSearch: SearchView | null;
}

export interface Check {
  id: string;
  status: CheckStatus;
  detail: string;
}

export interface TestReport {
  checks: Check[];
  passed: number;
  failed: number;
  blocked: number;
  notTested: number;
  search: SearchView;
  deployment: string | null;
}

export interface ProvisionOutcome {
  action: "shortcut" | "install" | "upgrade" | "repair";
  program: string;
  version: string;
  shortcut: string | null;
  dataLocation: string;
  steps: string[];
}

export interface DeployIpc {
  status: () => Promise<DeployStatus>;
  applyOffering: () => Promise<OfferView>;
  search: (targets: string[]) => Promise<{ search: SearchView; deployments: DeploymentView[] }>;
  test: (targets: string[], downloadPackage: boolean) => Promise<TestReport>;
  provision: (id: string, kind: ProvisionKind, destination: string | null) => Promise<ProvisionOutcome>;
  launch: (program: string) => Promise<void>;
  trust: (id: string) => Promise<void>;
}

export const tauriDeployIpc: DeployIpc = {
  status: () => invoke<DeployStatus>("deploy_status"),
  applyOffering: () => invoke<OfferView>("deploy_apply_offering"),
  search: (targets) => invoke("deploy_search", { targetsTyped: targets }),
  test: (targets, downloadPackage) => invoke<TestReport>("deploy_test", { targetsTyped: targets, downloadPackage }),
  provision: (id, kind, destination) => invoke<ProvisionOutcome>("deploy_provision", { id, kind, destination }),
  launch: (program) => invoke("deploy_launch", { program }).then(() => undefined),
  trust: (id) => invoke("deploy_trust", { id }).then(() => undefined),
};
