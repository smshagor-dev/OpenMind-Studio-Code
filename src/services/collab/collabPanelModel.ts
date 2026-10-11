import type { CollabRoomView } from "./collabIpc";
import type { ConnectionRoute, ConnectionState, NetStatus } from "./collabNetIpc";
import type { CollabRole } from "./presenceIpc";
import type { PeerPresence } from "./presenceService";
import { colorOf } from "./presenceService";
import type { MemberStatus, RoomCommand, RoomView } from "./roomIpc";
import type { VoiceMember } from "./voice/voiceIpc";

// The Collaboration panel's data (Milestone 24, phases 7-8), built from what the backend says: the canonical
// `collaboration` domain on the Owner's computer, the Owner's room view on a participant's. Nothing here decides
// whether an action is allowed — the Owner does, for every command. The rules below only keep menus free of entries
// the backend would certainly refuse (no permission, oneself, an equal or higher rank); anything shown can still be
// refused, and a refusal is shown as such.

/** A member as the panel lists it. Later phases (voice) add their own fields here. */
export interface ParticipantRow {
  peer: string;
  name: string;
  role: CollabRole;
  status: MemberStatus;
  you: boolean;
  connection: "online" | "reconnecting" | "offline";
  /** The file it has active (a name for display; never an Owner path sent from elsewhere). */
  activeFile: string | null;
  typing: boolean;
  color: number;
  /** Overrides and effective permissions — only when the backend let this member see them. */
  granted: string[] | null;
  denied: string[] | null;
  permissions: string[] | null;
  /** In the room's voice call (phase 9): muted, speaking, hand, moderation — as the Owner said. */
  voice: VoiceMember | null;
}

export interface RoomPanel {
  roomUid: string;
  name: string;
  side: "host" | "participant";
  state: ConnectionState | null;
  route: ConnectionRoute | null;
  locked: boolean;
  approvalRequired: boolean;
  defaultRole: CollabRole;
  closed: boolean;
  owner: string;
  /** This computer's member: its role and effective permissions, as the backend computed them. */
  you: { peer: string; role: CollabRole; permissions: ReadonlySet<string> };
  /** Active members, Owner first. */
  participants: ParticipantRow[];
  pending: ParticipantRow[];
  banned: ParticipantRow[];
}

export interface PanelInputs {
  status: NetStatus;
  rooms: readonly CollabRoomView[];
  /** Participant rooms: the Owner's view for this member. */
  view: (roomUid: string) => RoomView | null;
  peers: (roomUid: string) => PeerPresence[];
  /** This computer's peer id (the same in every room). */
  me: string | null;
  fileName: (roomUid: string, peer: PeerPresence) => string | null;
  /** The room's voice call (phase 9). */
  voice?: (roomUid: string) => VoiceMember[];
}

export const RANK: Record<CollabRole, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

/** A role name from stored state (anything unexpected reads as the lowest role). */
export function roleOf(text: string | undefined): CollabRole {
  return text === "owner" || text === "admin" || text === "editor" ? text : "viewer";
}

interface SourceMember {
  peer: string;
  name: string;
  role: CollabRole;
  status: MemberStatus;
  online: boolean;
  granted: string[] | null;
  denied: string[] | null;
  permissions: string[] | null;
}

function hostSource(view: CollabRoomView): SourceMember[] {
  return view.members.map((m) => ({
    peer: m.peer,
    name: m.displayName,
    role: m.role,
    status: m.status,
    online: m.online,
    granted: m.granted,
    denied: m.denied,
    permissions: m.permissions,
  }));
}

function viewSource(view: RoomView): SourceMember[] {
  return view.members.map((m) => ({
    peer: m.peer,
    name: m.displayName,
    role: m.role,
    status: m.status,
    online: m.online,
    granted: m.granted,
    denied: m.denied,
    permissions: m.permissions,
  }));
}

function sortRows(rows: ParticipantRow[]): ParticipantRow[] {
  return rows.sort(
    (a, b) =>
      RANK[b.role] - RANK[a.role] ||
      Number(b.connection === "online") - Number(a.connection === "online") ||
      a.name.localeCompare(b.name),
  );
}

/** The rooms this computer is on the network with, and who is in them. */
export function panelRooms(inputs: PanelInputs): RoomPanel[] {
  const sides = [
    ...inputs.status.hosting.map((r) => [r, "host"] as const),
    ...inputs.status.joined.map((r) => [r, "participant"] as const),
  ];
  const out: RoomPanel[] = [];
  for (const [roomUid, side] of sides) {
    const canonical = inputs.rooms.find((r) => r.roomUid === roomUid);
    const view = side === "participant" ? inputs.view(roomUid) : null;
    if (side === "host" && !canonical) continue;
    const source =
      canonical && side === "host" ? hostSource(canonical) : view ? viewSource(view) : [];
    const state = inputs.status.states[roomUid] ?? null;
    const reconnecting =
      side === "participant" && (state === "reconnecting" || state === "connecting");
    const peers = new Map(inputs.peers(roomUid).map((p) => [p.peer, p]));
    const voice = new Map((inputs.voice?.(roomUid) ?? []).map((v) => [v.peer, v]));
    const rows = source.map((m): ParticipantRow => {
      const presence = peers.get(m.peer);
      const you = m.peer === inputs.me;
      return {
        ...m,
        you,
        connection: reconnecting && !you ? "reconnecting" : m.online || you ? "online" : "offline",
        activeFile: presence?.state.active ? inputs.fileName(roomUid, presence) : null,
        typing: presence?.state.typing ?? false,
        color: colorOf(m.peer),
        voice: voice.get(m.peer) ?? null,
      };
    });
    const mine = rows.find((r) => r.you);
    const role = view?.you.role ?? mine?.role ?? "viewer";
    const permissions = new Set(view?.you.permissions ?? mine?.permissions ?? []);
    out.push({
      roomUid,
      name: view?.name ?? canonical?.name ?? "",
      side,
      state,
      route: side === "participant" ? (inputs.status.routes[roomUid] ?? null) : null,
      locked: view?.locked ?? canonical?.locked ?? false,
      approvalRequired: view?.approvalRequired ?? canonical?.approvalRequired ?? false,
      defaultRole: view?.defaultRole ?? roleOf(canonical?.defaultRole),
      closed: view?.closed ?? canonical?.closed ?? false,
      owner: view?.owner ?? canonical?.ownerPeer ?? "",
      you: { peer: inputs.me ?? "", role, permissions },
      participants: sortRows(rows.filter((r) => r.status === "active")),
      pending: rows.filter((r) => r.status === "pending"),
      banned: rows.filter((r) => r.status === "banned"),
    });
  }
  return out;
}

/** What a member's menu offers (the backend still decides each one). */
export type MemberAction =
  | { kind: "role"; role: CollabRole }
  | { kind: "permissions" }
  | { kind: "kick" }
  | { kind: "remove" }
  | { kind: "ban" }
  | { kind: "transfer" }
  /** Voice moderation: stop the member speaking until lifted (`voice.forceMute`). */
  | { kind: "forceMute"; muted: boolean };

/** Whether `room`'s own member can act on `target` at all: someone else, active, ranked below it. */
function outranks(room: RoomPanel, target: ParticipantRow): boolean {
  return !target.you && RANK[room.you.role] > RANK[target.role];
}

/** The roles this member could give someone: below its own rank, never Owner (ownership moves only by transfer). */
export function assignableRoles(room: RoomPanel): CollabRole[] {
  if (!room.you.permissions.has("member.changeRole")) return [];
  return (["admin", "editor", "viewer"] as const).filter((r) => RANK[r] < RANK[room.you.role]);
}

export function memberActions(room: RoomPanel, target: ParticipantRow): MemberAction[] {
  if (room.closed || target.status !== "active" || !outranks(room, target)) return [];
  const can = (p: string) => room.you.permissions.has(p);
  const actions: MemberAction[] = assignableRoles(room)
    .filter((role) => role !== target.role)
    .map((role) => ({ kind: "role", role }));
  if (can("member.managePermissions")) actions.push({ kind: "permissions" });
  if (can("voice.forceMute") && target.voice)
    actions.push({ kind: "forceMute", muted: !target.voice.forceMuted });
  if (can("room.transferOwnership")) actions.push({ kind: "transfer" });
  if (can("member.kick")) actions.push({ kind: "kick" });
  if (can("member.remove")) actions.push({ kind: "remove" });
  if (can("member.ban")) actions.push({ kind: "ban" });
  return actions;
}

/** The roles a waiting member can be approved as: the room's default, and others this member may assign. */
export function approvalRoles(room: RoomPanel): CollabRole[] {
  if (!room.you.permissions.has("member.approve")) return [];
  const roles = new Set<CollabRole>([room.defaultRole, ...assignableRoles(room)]);
  return (["viewer", "editor", "admin"] as const).filter((r) => roles.has(r));
}

/** The commands that approve `peer` as `role` (a role other than the default is set first, while it waits). */
export function approveCommands(room: RoomPanel, peer: string, role: CollabRole): RoomCommand[] {
  const approve: RoomCommand = { command: "approve", target: peer };
  return role === room.defaultRole
    ? [approve]
    : [{ command: "changeRole", target: peer, role }, approve];
}

/** The last part of a path (either slash style). */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/** An Owner's local-network address typed in by hand: `ip:port` (IPv4) or `[ipv6]:port`. Empty is fine. */
export function lanAddressProblem(text: string): "format" | "port" | null {
  const value = text.trim();
  if (value === "") return null;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(value);
  const v6 = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(value);
  const port = v4 ? Number(v4[5]) : v6 ? Number(v6[2]) : null;
  if (port === null) return "format";
  if (v4 && v4.slice(1, 5).some((part) => Number(part) > 255)) return "format";
  return port >= 1 && port <= 65535 ? null : "port";
}
