// Mirrors `src-tauri/src/commands/collab/view.rs` (the `collaboration` canonical domain). It never carries a Room
// Code, a key or a local folder path.

export interface CollabMemberView {
  peer: string;
  fingerprint: string;
  displayName: string;
  role: "owner" | "admin" | "editor" | "viewer";
  status: "pending" | "active" | "kicked" | "removed" | "banned";
  forceMuted: boolean;
  /** What the member may do now (role defaults with overrides applied). */
  permissions: string[];
  granted: string[];
  denied: string[];
  online: boolean;
  lastSeenAt: number;
}

export interface CollabRoomView {
  roomUid: string;
  name: string;
  relation: "created" | "joined";
  localRole: string;
  ownerPeer: string;
  locked: boolean;
  approvalRequired: boolean;
  defaultRole: string;
  closed: boolean;
  archived: boolean;
  workspaceName: string | null;
  inviteGeneration: number;
  createdAt: number;
  lastJoinedAt: number | null;
  lastSeenAt: number | null;
  members: CollabMemberView[];
}

export interface CollabSnapshot {
  rooms: CollabRoomView[];
}
