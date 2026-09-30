import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// Mirrors src-tauri/src/commands/broker.rs and crates/broker (serde camelCase).

export type BrokerProvider =
  | "download"
  | "pypi"
  | "npm"
  | "go"
  | "git"
  | "composer"
  | "cargo"
  | "yarn"
  | "pnpm"
  | "rustup";

export type BrokerPhase =
  | "resolving"
  | "connecting"
  | "downloading"
  | "verifying"
  | "finalizing"
  | "cleaning"
  | "complete"
  | "failed"
  | "cancelled";

/** Why a broker operation failed (`openmind_broker::FailureKind`). */
export type FailureKind =
  | "dns"
  | "connection"
  | "timeout"
  | "tls"
  | "certificate"
  | "proxyUnavailable"
  | "proxyAuthentication"
  | "authentication"
  | "blocked"
  | "notFound"
  | "registry"
  | "http"
  | "checksum"
  | "integrity"
  | "invalidMetadata"
  | "gitRemote"
  | "diskFull"
  | "permissionDenied"
  | "cancelled"
  | "refused"
  | "other";

export interface BrokerEvent {
  id: number;
  provider: BrokerProvider;
  /** The file (or host, for a tunnel; repository, for Git). */
  artifact: string;
  phase: BrokerPhase;
  bytes: number;
  total: number | null;
  /** Bytes per second. */
  speed: number;
  retry: number | null;
  failure: FailureKind | null;
  detail: string | null;
}

/** A tool the gateway leaves on the user's own configuration. */
export interface SkippedTool {
  tool: string;
  reason: string;
}

export interface RecoveryReport {
  removed: number;
  keptPartial: number;
  inUse: number;
}

export interface BrokerStatus {
  /** The setting "Route Package Downloads Through OpenMind". */
  enabled: boolean;
  running: boolean;
  problem: string | null;
  port: number | null;
  npmPort: number | null;
  tempDir: string;
  shimsDir: string;
  skipped: SkippedTool[];
  recent: BrokerEvent[];
  recovery: RecoveryReport | null;
}

export interface BrokerIpc {
  brokerStatus: () => Promise<BrokerStatus>;
  brokerCancel: (id: number) => Promise<boolean>;
  /** Writes `openmind-network-diagnostics.json` (runs the checks) and returns its path. */
  exportDiagnostics: () => Promise<string>;
  onProgress: (listener: (event: BrokerEvent) => void) => Promise<() => void>;
}

export const tauriBrokerIpc: BrokerIpc = {
  brokerStatus: () => invoke<BrokerStatus>("broker_status"),
  brokerCancel: (id) => invoke<boolean>("broker_cancel", { id }),
  exportDiagnostics: () => invoke<string>("network_diagnostics_export"),
  onProgress: (listener) =>
    listen<BrokerEvent>("broker:progress", (event) => {
      listener(event.payload);
    }),
};
