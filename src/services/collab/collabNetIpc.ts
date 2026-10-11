import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// Mirrors src-tauri/src/commands/collab/net_commands.rs, net.rs and net_remote.rs, and the transient types of
// crates/collab-net (serde camelCase). Nothing here is canonical state: connection states, tree changes and transfer
// progress belong to one live connection and arrive as events. No Room Code, key or Owner folder path appears here.

/** `openmind_collab_net::ConnectionState`. */
export type ConnectionState =
  | "idle"
  | "signaling"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "failed"
  | "closed";

/**
 * How a connection was set up (`openmind_collab_net::ConnectionRoute`). `localLan`: found on the local network and
 * connected directly (nothing on the Internet involved); `internetRelay`: through the signaling server.
 */
export type ConnectionRoute = "localLan" | "internetRelay";

/** Which rooms are on the network now (`collab_net_status`). */
export interface NetStatus {
  hosting: string[];
  joined: string[];
  states: Record<string, ConnectionState>;
  /** Hosted rooms: `ip:port` addresses participants can type in when local discovery is blocked. */
  lanEndpoints: Record<string, string[]>;
  /** Joined rooms: how they were reached. */
  routes: Record<string, ConnectionRoute>;
}

/** `openmind_collab_net::owner::OwnerEvent` (the host side of `collab:net`). */
export type OwnerEvent =
  | { kind: "signaling"; state: ConnectionState }
  | { kind: "link"; slot: string; state: ConnectionState }
  | { kind: "admitted"; slot: string; peer: string; session: string; route: ConnectionRoute }
  | { kind: "pending"; slot: string; peer: string }
  | { kind: "left"; peer: string; session: string; reason: string }
  | { kind: "problem"; message: string };

/** The participant side of `collab:net`. */
export type ParticipantConnectionEvent =
  | { kind: "state"; state: ConnectionState }
  | { kind: "invalid"; reason: string }
  | { kind: "route"; route: ConnectionRoute }
  | { kind: "path"; path: IcePath };

export type NetEventPayload =
  | { roomUid: string; side: "host"; event: OwnerEvent }
  | { roomUid: string; side: "participant"; event: ParticipantConnectionEvent };

/** One shared file or folder (`openmind_collab::manifest::ManifestEntry`). `path` is workspace-relative. */
export interface ManifestEntry {
  id: string;
  parent: string | null;
  name: string;
  path: string;
  kind: "file" | "folder";
  size: number;
  modifiedMs: number;
  /** Guessed from the extension only; the transfer classifies the real bytes. */
  binaryHint: boolean;
}

/** `collab:remote` (participant only): tree changes and transfer progress. */
export type RemoteNotice =
  | { kind: "treeReady"; version: number }
  | {
      kind: "treeDelta";
      base: number;
      version: number;
      upserts: ManifestEntry[];
      removed: string[];
    }
  | { kind: "treeStale" }
  | { kind: "progress"; file: string; received: number; total: number };

export interface RemoteEventPayload {
  roomUid: string;
  side: "participant";
  event: RemoteNotice;
}

export interface RemoteTreeView {
  ready: boolean;
  version: number;
  /** The shared folder's display name (never its path). */
  root: string;
  entries: ManifestEntry[];
}

export type TextEncoding = "utf-8" | "utf-8-bom" | "utf-16-le" | "utf-16-be" | "windows-1252";

/** A fetched, checksum-verified file. Text files come decoded; binary ones carry no content. */
export interface RemoteFile {
  roomUid: string;
  fileId: string;
  path: string;
  name: string;
  size: number;
  sha256: string;
  binary: boolean;
  text: string | null;
  encoding: TextEncoding | null;
}

/** One local-network try (`openmind_collab_net::route::Attempt`). */
export interface LanAttempt {
  addr: string;
  source: "mdns" | "broadcast" | "known";
  outcome:
    | "connected"
    | "unreachable"
    | "noRoom"
    | "notOwner"
    | "refused"
    | "noDirectPath"
    | "found"
    | "other";
  millis: number;
}

/** Why no route worked: `blocked` = found or given but unreachable (firewall, network policy, client isolation). */
export type RouteFailure = "notFound" | "blocked" | "refused";

export interface RouteReport {
  lanTried: boolean;
  discovered: LanAttempt[];
  attempts: LanAttempt[];
  discoveryMillis: number;
  /** Why discovery couldn't search at all (empty: it searched and `discovered` is what answered). */
  discoveryProblems: string[];
  route: ConnectionRoute | null;
  failure: RouteFailure | null;
}

/** What Windows Firewall does with inbound connections to this app on the connected networks. */
export interface FirewallStatus {
  verdict: "allowed" | "blocked" | "noRule" | "unknown";
  networks: string[];
}

/** Which kind of path a collaboration connection takes (no address). */
export type IcePath = "direct" | "stun" | "turnUdp" | "turnTcp" | "turnTls";

/** `collab_net_diagnostics`: this computer's local-network state (no Room Code, key, identity or path). */
export interface NetDiagnostics {
  lanEnabled: boolean;
  signalingConfigured: boolean;
  /** Whether TURN is set up here (servers and a saved login) and over which protocols; never a host or login. */
  turn: {
    status: "notConfigured" | "noLogin" | "configured";
    protocols: ("udp" | "tcp" | "tls")[];
    /** Debug builds' relay-only test mode. */
    relayOnly: boolean;
  };
  /** Joined rooms: the kind of path the connection to the Owner takes. */
  paths: Record<string, IcePath>;
  /** Hosted rooms: the kinds of path members' connections take. */
  hostPaths: Record<string, IcePath[]>;
  /** The interfaces local rooms use, best first (0: LAN with a router, 1: without, 2: VPN/other, 3: link-local). */
  interfaces: { rank: number; addresses: string[] }[];
  hosting: Record<
    string,
    {
      rendezvousPort: number;
      /** False if the rendezvous stopped accepting connections unexpectedly. */
      listening: boolean;
      endpoints: string[];
      broadcast: boolean;
      mdns: boolean;
    }
  >;
  routes: Record<string, ConnectionRoute>;
  lastJoin: RouteReport | null;
  /** Read when a room is hosted (read-only): whether other computers' connections reach this app. */
  firewall: FirewallStatus | null;
}

export interface JoinedRoom {
  roomUid: string;
  roomName: string;
  role: string;
  route: ConnectionRoute;
}

export interface CollabNetIpc {
  hostStart: (roomUid: string) => Promise<void>;
  hostStop: (roomUid: string) => Promise<void>;
  /**
   * Joins with a Room Code. The local network is tried first; `lanAddress` (the Owner's `ip:port`) is for networks
   * that block discovery — the Room Code is still what authenticates.
   */
  join: (
    code: string,
    displayName: string | null,
    lanAddress?: string | null,
  ) => Promise<JoinedRoom>;
  rejoin: (
    roomUid: string,
    displayName: string | null,
    lanAddress?: string | null,
  ) => Promise<JoinedRoom>;
  leave: (roomUid: string) => Promise<void>;
  status: () => Promise<NetStatus>;
  diagnostics: () => Promise<NetDiagnostics>;
  remoteTree: (roomUid: string) => Promise<RemoteTreeView>;
  remoteOpen: (roomUid: string, fileId: string) => Promise<RemoteFile>;
  remoteCancel: (roomUid: string, fileId: string) => Promise<void>;
  remoteRefresh: (roomUid: string) => Promise<void>;
  onNet: (listener: (payload: NetEventPayload) => void) => Promise<UnlistenFn>;
  onRemote: (listener: (payload: RemoteEventPayload) => void) => Promise<UnlistenFn>;
}

export const NET_EVENT = "collab:net";
export const REMOTE_EVENT = "collab:remote";

export const tauriCollabNetIpc: CollabNetIpc = {
  hostStart: (roomUid) => invoke("collab_host_start", { roomUid }),
  hostStop: (roomUid) => invoke("collab_host_stop", { roomUid }),
  join: (code, displayName, lanAddress = null) =>
    invoke("collab_join", { code, displayName, lanAddress }),
  rejoin: (roomUid, displayName, lanAddress = null) =>
    invoke("collab_rejoin", { roomUid, displayName, lanAddress }),
  leave: (roomUid) => invoke("collab_leave", { roomUid }),
  status: () => invoke("collab_net_status"),
  diagnostics: () => invoke("collab_net_diagnostics"),
  remoteTree: (roomUid) => invoke("collab_remote_tree", { roomUid }),
  remoteOpen: (roomUid, fileId) => invoke("collab_remote_open", { roomUid, fileId }),
  remoteCancel: (roomUid, fileId) => invoke("collab_remote_cancel", { roomUid, fileId }),
  remoteRefresh: (roomUid) => invoke("collab_remote_refresh", { roomUid }),
  onNet: (listener) =>
    listen<NetEventPayload>(NET_EVENT, (event) => {
      listener(event.payload);
    }),
  onRemote: (listener) =>
    listen<RemoteEventPayload>(REMOTE_EVENT, (event) => {
      listener(event.payload);
    }),
};
