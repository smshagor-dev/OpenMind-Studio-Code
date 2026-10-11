import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { CollabRole } from "./presenceIpc";

// Mirrors openmind_collab::authority::Command, openmind_collab::roomview and src-tauri/src/commands/collab
// (`collab_room_*`, `net_manage.rs`), Milestone 24 phase 8. Every command is decided by the room's Owner: this side
// only says what the user asked for. A Room Code appears only in `create`/`invite` answers and is never stored here.

/** A room or membership change (`Command`, tagged by `command`). */
export type RoomCommand =
  | { command: "setLocked"; locked: boolean }
  | { command: "setApproval"; required: boolean }
  | { command: "rotateInvite" }
  | { command: "closeRoom" }
  | { command: "transferOwnership"; target: string }
  | { command: "approve"; target: string }
  | { command: "denyJoin"; target: string }
  | { command: "kick"; target: string }
  | { command: "remove"; target: string }
  | { command: "ban"; target: string }
  | { command: "unban"; target: string }
  | { command: "changeRole"; target: string; role: CollabRole }
  | { command: "setOverrides"; target: string; overrides: { grant: string[]; deny: string[] } }
  | { command: "forceMute"; target: string; muted: boolean };

export type MemberStatus = "pending" | "active" | "kicked" | "removed" | "banned";

/** One member as the Owner lets this member see it (`roomview::ViewMember`). */
export interface ViewMember {
  peer: string;
  displayName: string;
  role: CollabRole;
  status: MemberStatus;
  online: boolean;
  granted: string[] | null;
  denied: string[] | null;
  permissions: string[] | null;
}

/** The room as the Owner lets this member see it (participants; `roomview::RoomView`). */
export interface RoomView {
  name: string;
  owner: string;
  locked: boolean;
  approvalRequired: boolean;
  defaultRole: CollabRole;
  closed: boolean;
  you: { role: CollabRole; permissions: string[] };
  members: ViewMember[];
}

/** The backend's permissions as data (`roomview::PermissionModel`). */
export interface PermissionModel {
  permissions: { name: string; group: string }[];
  roles: { role: CollabRole; defaults: string[] }[];
  ownerOnly: string[];
}

/** Why a join didn't work (`net_manage::JoinError`). */
export interface JoinError {
  kind: string;
  message: string;
}

export type JoinStage = "searching" | "connecting" | "pending" | "connected" | "failed";

export interface CreatedRoom {
  roomUid: string;
  code: string;
}

export interface RoomIpc {
  create: (name: string) => Promise<CreatedRoom>;
  /** The current Room Code of a room this computer hosts (shown only on request). */
  invite: (roomUid: string) => Promise<string>;
  /** A command run by this computer's user on a room it hosts. */
  hostCommand: (roomUid: string, command: RoomCommand) => Promise<void>;
  /** A command sent to a joined room's Owner; resolves with its answer. */
  remoteCommand: (roomUid: string, command: RoomCommand) => Promise<void>;
  permissionModel: () => Promise<PermissionModel>;
  identity: () => Promise<{ peerId: string }>;
  onJoin: (listener: (stage: JoinStage) => void) => Promise<UnlistenFn>;
}

export const JOIN_EVENT = "collab:join";

export const tauriRoomIpc: RoomIpc = {
  create: (name) => invoke("collab_room_create", { name, displayName: null }),
  invite: (roomUid) => invoke("collab_room_invite", { roomUid }),
  hostCommand: (roomUid, command) => invoke("collab_room_command", { roomUid, command }),
  remoteCommand: (roomUid, command) => invoke("collab_remote_command", { roomUid, command }),
  permissionModel: () => invoke("collab_permission_model"),
  identity: () => invoke("collab_identity"),
  onJoin: (listener) =>
    listen<{ stage: JoinStage }>(JOIN_EVENT, (event) => {
      listener(event.payload.stage);
    }),
};

/** A failed command's error as text (Tauri hands back the backend's `Err` value). */
export function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    if (typeof err.message === "string") return err.message;
  }
  return String(err);
}

/** A join failure: the backend's category when it sent one, else `other`. */
export function joinError(err: unknown): JoinError {
  if (typeof err === "object" && err !== null && "kind" in err && "message" in err) {
    const { kind, message } = err;
    if (typeof kind === "string" && typeof message === "string") return { kind, message };
  }
  return { kind: "other", message: errorText(err) };
}
