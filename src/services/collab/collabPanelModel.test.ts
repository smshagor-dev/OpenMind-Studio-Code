import { describe, expect, it } from "vitest";

import type { CollabMemberView, CollabRoomView } from "./collabIpc";
import type { NetStatus } from "./collabNetIpc";
import {
  approvalRoles,
  approveCommands,
  assignableRoles,
  baseName,
  memberActions,
  panelRooms,
  type PanelInputs,
  type RoomPanel,
} from "./collabPanelModel";
import type { PeerPresence } from "./presenceService";
import type { RoomView, ViewMember } from "./roomIpc";

const status = (over: Partial<NetStatus>): NetStatus => ({
  hosting: [],
  joined: [],
  states: {},
  lanEndpoints: {},
  routes: {},
  ...over,
});

function member(
  peer: string,
  name: string,
  role: CollabMemberView["role"],
  over: Partial<CollabMemberView> = {},
): CollabMemberView {
  return {
    peer,
    fingerprint: "fp",
    displayName: name,
    role,
    status: "active",
    forceMuted: false,
    permissions: [],
    granted: [],
    denied: [],
    online: true,
    lastSeenAt: 0,
    ...over,
  };
}

const hostRoom = (
  members: CollabMemberView[],
  over: Partial<CollabRoomView> = {},
): CollabRoomView => ({
  roomUid: "h",
  name: "Lab",
  relation: "created",
  localRole: "owner",
  ownerPeer: "o",
  locked: false,
  approvalRequired: false,
  defaultRole: "viewer",
  closed: false,
  archived: false,
  workspaceName: null,
  inviteGeneration: 1,
  createdAt: 0,
  lastJoinedAt: null,
  lastSeenAt: null,
  members,
  ...over,
});

const ALL_MEMBER = [
  "member.approve",
  "member.kick",
  "member.remove",
  "member.ban",
  "member.unban",
  "member.changeRole",
  "member.managePermissions",
  "room.transferOwnership",
  "room.close",
  "room.lock",
];

function viewMember(
  peer: string,
  name: string,
  role: ViewMember["role"],
  over: Partial<ViewMember> = {},
): ViewMember {
  return {
    peer,
    displayName: name,
    role,
    status: "active",
    online: true,
    granted: null,
    denied: null,
    permissions: null,
    ...over,
  };
}

const inputs = (over: Partial<PanelInputs>): PanelInputs => ({
  status: status({}),
  rooms: [],
  view: () => null,
  peers: () => [],
  me: "me",
  fileName: () => null,
  ...over,
});

function hosted(members: CollabMemberView[]): RoomPanel {
  const [room] = panelRooms(
    inputs({ status: status({ hosting: ["h"] }), rooms: [hostRoom(members)], me: "o" }),
  );
  if (!room) throw new Error("no room");
  return room;
}

describe("the Collaboration panel model", () => {
  it("lists the Owner's room from the canonical state, members grouped by status, Owner first", () => {
    const room = hosted([
      member("v", "Vic", "viewer", { online: false }),
      member("o", "Olga", "owner", { permissions: ALL_MEMBER }),
      member("p", "Pat", "viewer", { status: "pending" }),
      member("b", "Bo", "viewer", { status: "banned" }),
    ]);
    expect(room.participants.map((p) => [p.name, p.role, p.connection, p.you])).toEqual([
      ["Olga", "owner", "online", true],
      ["Vic", "viewer", "offline", false],
    ]);
    expect(room.pending.map((p) => p.name)).toEqual(["Pat"]);
    expect(room.banned.map((p) => p.name)).toEqual(["Bo"]);
    expect(room.you.role).toBe("owner");
  });

  it("lists a joined room from the Owner's view, with this member's permissions from the backend", () => {
    const view: RoomView = {
      name: "Physics",
      owner: "o",
      locked: true,
      approvalRequired: false,
      defaultRole: "viewer",
      closed: false,
      you: { role: "admin", permissions: ["member.kick", "room.lock"] },
      members: [
        viewMember("o", "Olga", "owner"),
        viewMember("me", "Me", "admin"),
        viewMember("v", "Vic", "viewer"),
      ],
    };
    const olga: PeerPresence = {
      peer: "o",
      state: { seq: 1, active: "f1", cursor: null, typing: true },
      activePath: null,
      at: 0,
    };
    const [room] = panelRooms(
      inputs({
        status: status({ joined: ["r"], states: { r: "connected" }, routes: { r: "localLan" } }),
        view: () => view,
        peers: () => [olga],
        fileName: () => "main.ts",
      }),
    );
    expect(room).toMatchObject({
      name: "Physics",
      side: "participant",
      locked: true,
      route: "localLan",
    });
    expect(room?.participants[0]).toMatchObject({
      name: "Olga",
      activeFile: "main.ts",
      typing: true,
    });
    expect([...(room?.you.permissions ?? [])]).toEqual(["member.kick", "room.lock"]);
  });

  it("marks others reconnecting while this participant's own connection is", () => {
    const view: RoomView = {
      name: "R",
      owner: "o",
      locked: false,
      approvalRequired: false,
      defaultRole: "viewer",
      closed: false,
      you: { role: "viewer", permissions: [] },
      members: [viewMember("o", "Olga", "owner"), viewMember("me", "Me", "viewer")],
    };
    const [room] = panelRooms(
      inputs({
        status: status({ joined: ["r"], states: { r: "reconnecting" } }),
        view: () => view,
      }),
    );
    expect(room?.participants.map((p) => p.connection)).toEqual(["reconnecting", "online"]);
  });

  it("offers a member's menu only for lower ranks, and only the actions the member's permissions cover", () => {
    const room = hosted([
      member("o", "Olga", "owner", { permissions: ALL_MEMBER }),
      member("a", "Ada", "admin"),
      member("v", "Vic", "viewer"),
    ]);
    const ada = room.participants.find((p) => p.name === "Ada");
    const vic = room.participants.find((p) => p.name === "Vic");
    const olga = room.participants.find((p) => p.you);
    if (!ada || !vic || !olga) throw new Error("rows");
    expect(memberActions(room, olga)).toEqual([]); // never oneself
    expect(
      memberActions(room, vic).map((a) => (a.kind === "role" ? `role:${a.role}` : a.kind)),
    ).toEqual(["role:admin", "role:editor", "permissions", "transfer", "kick", "remove", "ban"]);
    expect(assignableRoles(room)).not.toContain("owner");
    // An Admin viewing the same room: no Owner menu, nothing for another Admin, no role changes without the grant.
    const asAdmin: RoomPanel = {
      ...room,
      you: { peer: "a", role: "admin", permissions: new Set(["member.kick"]) },
    };
    expect(memberActions(asAdmin, { ...olga, you: false })).toEqual([]);
    expect(memberActions(asAdmin, { ...ada, you: false, role: "admin" })).toEqual([]);
    expect(memberActions(asAdmin, vic)).toEqual([{ kind: "kick" }]);
    expect(memberActions({ ...room, closed: true }, vic)).toEqual([]);
  });

  it("approves as the default role in one command, as another role by setting it first", () => {
    const room = hosted([member("o", "Olga", "owner", { permissions: ALL_MEMBER })]);
    expect(approvalRoles(room)).toEqual(["viewer", "editor", "admin"]);
    expect(approveCommands(room, "p", "viewer")).toEqual([{ command: "approve", target: "p" }]);
    expect(approveCommands(room, "p", "editor")).toEqual([
      { command: "changeRole", target: "p", role: "editor" },
      { command: "approve", target: "p" },
    ]);
    const approverOnly: RoomPanel = {
      ...room,
      you: { ...room.you, role: "admin", permissions: new Set(["member.approve"]) },
    };
    expect(approvalRoles(approverOnly)).toEqual(["viewer"]);
    expect(approvalRoles({ ...room, you: { ...room.you, permissions: new Set() } })).toEqual([]);
  });

  it("names files", () => {
    expect(baseName("C:\\work\\src\\a.ts")).toBe("a.ts");
    expect(panelRooms(inputs({}))).toEqual([]);
  });
});
