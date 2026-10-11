import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { RoomView } from "./roomIpc";

// Mirrors src-tauri/src/commands/collab/net_presence.rs and crates/collab/src/presence.rs (Milestone 24, phase 7).
// Presence is ephemeral: it is never stored and never part of the canonical state. No Room Code, key, machine identity
// or Owner folder path travels between computers; `activePath` exists only on the Owner's own computer.

export type CollabRole = "owner" | "admin" | "editor" | "viewer";

/** A member as the Owner lists it, from the room's membership (never from what a member says about itself). */
export interface RosterEntry {
  peer: string;
  displayName: string;
  role: CollabRole;
  online: boolean;
}

/** A cursor and selection as Yjs relative positions (base64), so they survive concurrent edits. */
export interface CursorState {
  anchor: string;
  head: string;
}

/** What a member says about itself. */
export interface PresenceState {
  seq: number;
  /** The shared file it has active (a file id, never a path). */
  active: string | null;
  cursor: CursorState | null;
  typing: boolean;
}

export type PresenceNotice =
  | { kind: "roster"; members: RosterEntry[] }
  /** `activePath`: on the Owner's computer only, where `state.active` is on this computer. */
  | { kind: "peer"; peer: string; state: PresenceState; activePath: string | null }
  | { kind: "gone"; peer: string }
  /** The connection ended: everyone else's presence is gone. */
  | { kind: "reset" }
  /** Participant: the room and its members as this member may manage them (phase 8). */
  | { kind: "room"; view: RoomView };

export interface PresenceEventPayload {
  roomUid: string;
  side: "host" | "participant";
  event: PresenceNotice;
}

/** What this window reports (the computer merges its windows into one presence per room). */
export interface LocalPresence {
  active: string | null;
  /** The Owner's own editor: the file's place on this computer (resolved to the shared file there). */
  path?: string | null;
  cursor: CursorState | null;
  typing: boolean;
}

export interface PresenceSnapshot {
  /** This computer's own peer: shown as "you", never as a collaborator. */
  me: string;
  roster: RosterEntry[];
  peers: { peer: string; state: PresenceState; activePath: string | null }[];
  /** Participant: the Owner's last room view for this member. */
  room: RoomView | null;
}

export interface PresenceIpc {
  set: (roomUid: string, presence: LocalPresence) => Promise<void>;
  snapshot: (roomUid: string) => Promise<PresenceSnapshot>;
  onPresence: (listener: (payload: PresenceEventPayload) => void) => Promise<UnlistenFn>;
}

export const PRESENCE_EVENT = "collab:presence";

export const tauriPresenceIpc: PresenceIpc = {
  set: (roomUid, presence) => invoke("collab_presence_set", { roomUid, presence }),
  snapshot: (roomUid) => invoke("collab_presence_snapshot", { roomUid }),
  onPresence: (listener) =>
    listen<PresenceEventPayload>(PRESENCE_EVENT, (event) => {
      listener(event.payload);
    }),
};
