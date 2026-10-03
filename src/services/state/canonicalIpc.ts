import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import type { DepsSnapshot } from "../deps/depsIpc";
import type { ExtensionsSnapshot } from "../extensionsIpc";
import type { DebugStatus, GitSnapshot, LspSnapshot, MySqlStatus, PhpServerInfo, RuntimeStatus } from "../ipc";
import type { WorkspaceStatus } from "../language/languageIpc";
import type { ToolchainPacks } from "../toolchains/toolchainIpc";

// Mirrors `src-tauri/src/state/domain.rs`. Each domain's data is exactly what its own command returns.

/** A counter that rises once per package change in a runtime or an OpenMind package install. */
export interface PackagesState {
  generation: number;
}

/** OpenMind's managed servers (app-wide, like XAMPP's): what `php_server_status` and `mysql_status` return. */
export interface ServersState {
  php: PhpServerInfo | null;
  mysql: MySqlStatus;
}

/** Which debuggers can start for one folder (the running session arrives as `debug:state`). */
export type DebugReadinessState = Omit<DebugStatus, "run">;

/** One value for the whole app, shared by every window. */
export interface GlobalDomainData {
  runtimes: RuntimeStatus[];
  tools: ToolchainPacks;
  languageServers: LspSnapshot;
  extensions: ExtensionsSnapshot;
  packages: PackagesState;
  servers: ServersState;
}

/** One value per open folder, received only by the windows that have that folder open. */
export interface WorkspaceDomainData {
  git: GitSnapshot;
  dependencies: DepsSnapshot;
  project: WorkspaceStatus;
  debug: DebugReadinessState;
}

export type DomainData = GlobalDomainData & WorkspaceDomainData;
export type Domain = keyof DomainData;
export type GlobalDomain = keyof GlobalDomainData;
export type WorkspaceDomain = keyof WorkspaceDomainData;

export const GLOBAL_DOMAINS: readonly GlobalDomain[] = [
  "runtimes",
  "tools",
  "languageServers",
  "extensions",
  "packages",
  "servers",
];
export const WORKSPACE_DOMAINS: readonly WorkspaceDomain[] = ["git", "dependencies", "project", "debug"];
export const DOMAINS: readonly Domain[] = [...GLOBAL_DOMAINS, ...WORKSPACE_DOMAINS];

export function isWorkspaceDomain(domain: Domain): domain is WorkspaceDomain {
  return (WORKSPACE_DOMAINS as readonly string[]).includes(domain);
}

/**
 * One domain's new state at `revision` (the revision right after the change). A per-workspace domain names its
 * folder in `scope`; `removed` means that folder's state is gone; `tick` is the revision without the data, sent to a
 * window that doesn't have that folder open.
 */
export type StateDelta = {
  [D in Domain]: {
    revision: number;
    domain: D;
    scope?: string;
    data: DomainData[D] | null;
    removed?: boolean;
    tick?: boolean;
  };
}[Domain];

export type DomainEntry = { [D in Domain]: { domain: D; scope?: string; data: DomainData[D] } }[Domain];

/** The global state and the asking window's own folder's state at `revision`; an unread domain is absent. */
export interface StateSnapshot {
  revision: number;
  workspace?: string;
  domains: DomainEntry[];
}

export const STATE_DELTA_EVENT = "state:delta";

export interface CanonicalIpc {
  onDelta: (handler: (delta: StateDelta) => void) => Promise<() => void>;
  /** `null` when the backend has no canonical state (it couldn't start): the stores then stay empty, never guess. */
  snapshot: () => Promise<StateSnapshot | null>;
  revision: () => Promise<number>;
  /** This window opened a folder, closed it or started: its scope follows. The folder's key, or `null`. */
  attach: () => Promise<string | null>;
  /** Brings domains up to date (a folder's ones are read once for every window asking at the same time). */
  refresh: (domains: Domain[]) => Promise<void>;
}

function isDomain(value: unknown): value is Domain {
  return typeof value === "string" && (DOMAINS as readonly string[]).includes(value);
}

export const tauriCanonicalIpc: CanonicalIpc = {
  // Only the deltas addressed to this window: another folder's data is never even delivered here.
  onDelta: (handler) =>
    listen<StateDelta>(
      STATE_DELTA_EVENT,
      (event) => {
        if (typeof event.payload.revision === "number" && isDomain(event.payload.domain)) handler(event.payload);
      },
      { target: { kind: "WebviewWindow", label: getCurrentWebviewWindow().label } },
    ),
  snapshot: () => invoke<StateSnapshot | null>("state_snapshot"),
  revision: () => invoke<number>("state_revision"),
  attach: () => invoke<string | null>("state_workspace_attach"),
  refresh: (domains) => invoke("state_refresh", { domains }),
};
