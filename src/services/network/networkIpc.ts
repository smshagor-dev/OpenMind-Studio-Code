import { invoke } from "@tauri-apps/api/core";

// Mirrors src-tauri/src/commands/network.rs and network_offline.rs (serde camelCase).

export type ProxySource =
  | "off"
  | "manual"
  | "systemUser"
  | "systemWinHttp"
  | "environment"
  | "noneDetected";

export type NetProblem =
  | "dns"
  | "timeout"
  | "connectionFailed"
  | "unreachable"
  | "proxyUnavailable"
  | "proxyAuthRequired"
  | "tls"
  | "blocked"
  | "notFound"
  | "http"
  | "checksum"
  | "insecureUrl"
  | "cancelled"
  | "io"
  | "other";

/** Why a proxy address is ignored (`openmind_network::proxy::ProxyProblem`). */
export type ProxyProblem = "empty" | "invalidAddress" | "unsupportedScheme" | "badPort" | "credentialsInAddress";

/** Something about the proxy settings the user should know (`openmind_network::diagnostics::Diagnostic`). */
export type NetworkDiagnostic = { severity: "warning" | "info" } & (
  | {
      kind: "ignoredField";
      /** `http`, `https`, `socks`, or an environment variable name in System mode. */
      field: string;
      problem: ProxyProblem;
    }
  | { kind: "pacNotEvaluated"; url: string }
  | { kind: "autoDetectNotEvaluated" }
  | { kind: "socksOnly" }
  | { kind: "noCredentials" }
  | { kind: "credentialsUnreadable" }
);

export interface NetworkStatus {
  mode: "none" | "system" | "manual";
  source: ProxySource;
  active: boolean;
  http: string | null;
  https: string | null;
  socks: string | null;
  noProxy: string[];
  pacUrl: string | null;
  diagnostics: NetworkDiagnostic[];
  hasCredentials: boolean;
  username: string | null;
  credentialProblem: string | null;
  useWheelhouse: boolean;
  goProxy: string | null;
  testUrl: string;
}

export interface TestOutcome {
  ok: boolean;
  problem: NetProblem | null;
  status: number | null;
  /** `direct`, `proxy` or `unchanged` (OpenMind added no proxy). */
  route: string;
  proxy: string | null;
  elapsedMs: number;
  detail: string | null;
}

export type PackageKind =
  | "runtime"
  | "vsix"
  | "wheel"
  | "npmPackage"
  | "composerPackage"
  | "sourceArchive";

export interface Inspection {
  path: string;
  fileName: string;
  kind: PackageKind | null;
  name: string;
  version: string | null;
  architecture: string | null;
  compatible: boolean;
  sha256: string;
  size: number;
  reason: string | null;
  runtime: [string, string] | null;
}

export interface CacheEntry {
  id: string;
  kind: PackageKind;
  name: string;
  version: string | null;
  architecture: string | null;
  sha256: string;
  size: number;
  file: string;
  importedAt: number;
  source: string;
  runtime: [string, string] | null;
}

/** A wheel file of an imported folder that wasn't imported, and why. */
export interface RefusedWheel {
  file: string;
  reason: string;
}

export interface WheelFolderImport {
  imported: CacheEntry[];
  refused: RefusedWheel[];
}

export interface Wheelhouse {
  folder: string;
  /** The folder as the file URL pip reads (works with spaces). */
  url: string;
  wheels: CacheEntry[];
}

export interface NetworkIpc {
  networkStatus: () => Promise<NetworkStatus>;
  networkSetCredentials: (username: string, password: string) => Promise<NetworkStatus>;
  networkClearCredentials: () => Promise<NetworkStatus>;
  networkTest: (url: string | null) => Promise<TestOutcome>;
  networkTerminalEnv: () => Promise<[string, string][]>;
  offlineInspect: (path: string) => Promise<Inspection>;
  offlineImport: (path: string) => Promise<CacheEntry>;
  offlineList: () => Promise<CacheEntry[]>;
  offlineRemove: (id: string) => Promise<void>;
  offlineClear: () => Promise<void>;
  offlineFolder: () => Promise<string>;
  offlinePath: (id: string) => Promise<string>;
  offlineExtract: (id: string, destination: string) => Promise<number>;
  offlineImportWheels: (folder: string) => Promise<WheelFolderImport>;
  wheelhouse: () => Promise<Wheelhouse>;
  /** The argument list that installs `requirements` from the wheelhouse only (`--no-index`). */
  wheelhouseCommand: (requirements: string) => Promise<string[]>;
}

export const tauriNetworkIpc: NetworkIpc = {
  networkStatus: () => invoke<NetworkStatus>("network_status"),
  networkSetCredentials: (username, password) =>
    invoke<NetworkStatus>("network_set_credentials", { username, password }),
  networkClearCredentials: () => invoke<NetworkStatus>("network_clear_credentials"),
  networkTest: (url) => invoke<TestOutcome>("network_test", { url }),
  networkTerminalEnv: () => invoke<[string, string][]>("network_terminal_env"),
  offlineInspect: (path) => invoke<Inspection>("network_offline_inspect", { path }),
  offlineImport: (path) => invoke<CacheEntry>("network_offline_import", { path }),
  offlineList: () => invoke<CacheEntry[]>("network_offline_list"),
  offlineRemove: (id) => invoke<undefined>("network_offline_remove", { id }).then(() => undefined),
  offlineClear: () => invoke<undefined>("network_offline_clear").then(() => undefined),
  offlineFolder: () => invoke<string>("network_offline_folder"),
  offlinePath: (id) => invoke<string>("network_offline_path", { id }),
  offlineExtract: (id, destination) =>
    invoke<number>("network_offline_extract", { id, destination }),
  offlineImportWheels: (folder) => invoke<WheelFolderImport>("network_offline_import_wheels", { folder }),
  wheelhouse: () => invoke<Wheelhouse>("network_wheelhouse"),
  wheelhouseCommand: (requirements) => invoke<string[]>("network_wheelhouse_command", { requirements }),
};
