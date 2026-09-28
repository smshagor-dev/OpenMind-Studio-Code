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

export interface NetworkStatus {
  mode: "none" | "system" | "manual";
  source: ProxySource;
  active: boolean;
  http: string | null;
  https: string | null;
  socks: string | null;
  noProxy: string[];
  pacUrl: string | null;
  problems: { field: string; problem: string }[];
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
};
