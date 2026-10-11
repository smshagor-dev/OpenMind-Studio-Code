import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CollabMemberView, CollabRoomView } from "../../services/collab/collabIpc";
import { panelRooms, type RoomPanel } from "../../services/collab/collabPanelModel";
import type { PermissionModel } from "../../services/collab/roomIpc";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));
vi.mock("../../services/container", async () => {
  const collab = (await import("../../testUtils/collabStub")).collabStub();
  return {
    get container() {
      return {
        collab: { ...collab, ...((harness.current as { collab?: object } | null)?.collab ?? {}) },
      };
    },
  };
});

import { CollabDiagnostics } from "./CollabDiagnostics";
import { CreateRoomForm, JoinRoomForm } from "./CollabForms";
import { RoomSection } from "./RoomSection";
import { SharedFiles } from "./SharedFiles";

const ALL = [
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
  "room.rotateInvite",
  "room.manage",
  "file.read",
  "file.write",
  "file.delete",
];

const MODEL: PermissionModel = {
  permissions: [
    { name: "file.read", group: "file" },
    { name: "file.write", group: "file" },
    { name: "file.delete", group: "file" },
    { name: "member.kick", group: "member" },
    { name: "room.close", group: "room" },
  ],
  roles: [{ role: "editor", defaults: ["file.read", "file.write"] }],
  ownerOnly: ["room.close"],
};

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

function room(
  members: CollabMemberView[],
  me = "o",
  over: Partial<CollabRoomView> = {},
): RoomPanel {
  const view: CollabRoomView = {
    roomUid: "r",
    name: "Physics Lab",
    relation: "created",
    localRole: "owner",
    ownerPeer: "o",
    locked: false,
    approvalRequired: true,
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
  };
  const [panel] = panelRooms({
    status: { hosting: ["r"], joined: [], states: {}, lanEndpoints: {}, routes: {} },
    rooms: [view],
    view: () => null,
    peers: () => [],
    me,
    fileName: () => null,
  });
  if (!panel) throw new Error("no room");
  return panel;
}

function manageStub(over: Record<string, unknown> = {}) {
  const manage = {
    run: vi.fn(() => Promise.resolve(true)),
    setRole: vi.fn(() => Promise.resolve(true)),
    permissionModel: vi.fn(() => Promise.resolve(MODEL)),
    isBusy: () => false,
    code: vi.fn((): string | null => null),
    reveal: vi.fn(() => Promise.resolve()),
    hide: vi.fn(),
    copyCode: vi.fn(() => Promise.resolve()),
    subscribe: () => () => undefined,
    getVersion: () => 0,
    leave: vi.fn(() => Promise.resolve()),
    joinProgress: vi.fn(() => ({ busy: false, stage: null, error: null, room: null })),
    joinRoom: vi.fn(() => Promise.resolve(null)),
    resetJoin: vi.fn(),
    diagnostics: vi.fn(),
    ...over,
  };
  harness.current = { collab: { manage } };
  return manage;
}

const owner = member("o", "Olga", "owner", { permissions: ALL });

afterEach(() => {
  harness.current = null;
});

describe("the Collaboration panel", () => {
  it("shows a Viewer no management controls at all", () => {
    manageStub();
    const panel = room([owner, member("v", "Vic", "viewer"), member("e", "Eve", "editor")], "v");
    render(<RoomSection room={panel} />);
    expect(screen.queryByRole("button", { name: /Manage/ })).toBeNull();
    expect(screen.queryByText("Lock Room")).toBeNull();
    expect(screen.queryByText("Close Room")).toBeNull();
    expect(screen.getByText("Vic (you)")).toBeTruthy();
  });

  it("lets the Owner change a role from the member menu, through the backend", () => {
    const manage = manageStub();
    render(<RoomSection room={room([owner, member("v", "Vic", "viewer")])} />);
    fireEvent.click(screen.getByRole("button", { name: "Manage Vic" }));
    fireEvent.click(screen.getByText("Make Editor"));
    expect(manage.setRole).toHaveBeenCalledWith("r", "v", "editor");
    fireEvent.click(screen.getByRole("button", { name: "Manage Vic" }));
    fireEvent.click(screen.getByText("Make Admin"));
    expect(manage.setRole).toHaveBeenCalledWith("r", "v", "admin");
  });

  it("asks before a ban, and only then sends it", () => {
    const manage = manageStub();
    render(<RoomSection room={room([owner, member("a", "Alice", "editor")])} />);
    fireEvent.click(screen.getByRole("button", { name: "Manage Alice" }));
    fireEvent.click(screen.getByText("Ban"));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("Ban Alice from this room?")).toBeTruthy();
    expect(within(dialog).getByText(/will not be able to rejoin until unbanned/)).toBeTruthy();
    expect(manage.run).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByText("Cancel"));
    expect(manage.run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Manage Alice" }));
    fireEvent.click(screen.getByText("Ban"));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Ban" }));
    expect(manage.run).toHaveBeenCalledWith("r", [{ command: "ban", target: "a" }]);
  });

  it("transfers ownership only after the member's name is typed, and says hosting stays here", () => {
    const manage = manageStub();
    render(<RoomSection room={room([owner, member("a", "Alice", "admin")])} />);
    fireEvent.click(screen.getByRole("button", { name: "Manage Alice" }));
    fireEvent.click(screen.getByText("Transfer Ownership…"));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/does not move the active hosting process/)).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: "Transfer Ownership…" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Alice" } });
    fireEvent.click(confirm);
    expect(manage.run).toHaveBeenCalledWith("r", [{ command: "transferOwnership", target: "a" }]);
  });

  it("edits permissions with role defaults, overrides and the backend's effective values", async () => {
    const manage = manageStub();
    const eve = member("e", "Eve", "editor", {
      denied: ["file.write"],
      permissions: ["file.read"],
    });
    render(<RoomSection room={room([owner, eve])} />);
    fireEvent.click(screen.getByRole("button", { name: "Manage Eve" }));
    await act(async () => {
      fireEvent.click(screen.getByText("Permissions…"));
      await Promise.resolve();
    });
    const dialog = await screen.findByRole("dialog", { name: "Permissions of Eve" });
    expect(within(dialog).queryByText("Close room")).toBeNull();
    const write = within(dialog).getByRole("combobox", { name: "Override for Edit files" });
    expect((write as HTMLSelectElement).value).toBe("deny");
    const rowText = write.parentElement?.textContent ?? "";
    expect(rowText).toContain("Allowed");
    expect(rowText).toContain("Denied");
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Override for Delete files" }), {
      target: { value: "allow" },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByText("Save"));
      await Promise.resolve();
    });
    expect(manage.run).toHaveBeenCalledWith("r", [
      {
        command: "setOverrides",
        target: "e",
        overrides: { grant: ["file.delete"], deny: ["file.write"] },
      },
    ]);
  });

  it("keeps the Room Code hidden until revealed, and asks before rotating it", () => {
    const manage = manageStub();
    render(<RoomSection room={room([owner])} />);
    expect(screen.getByText("Hidden")).toBeTruthy();
    fireEvent.click(screen.getByText("Reveal"));
    expect(manage.reveal).toHaveBeenCalledWith("r");
    fireEvent.click(screen.getByText("Copy"));
    expect(manage.copyCode).toHaveBeenCalledWith("r");
    fireEvent.click(screen.getByText("Rotate Code…"));
    expect(screen.getByRole("alertdialog").textContent).toContain("stay connected");
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Rotate Code…" }),
    );
    expect(manage.run).toHaveBeenCalledWith("r", [{ command: "rotateInvite" }]);
  });

  it("approves a waiting member as a chosen role, rejects one, locks, unbans and closes", () => {
    const manage = manageStub();
    const panel = room([
      owner,
      member("p", "Pat", "viewer", { status: "pending" }),
      member("b", "Bo", "viewer", { status: "banned" }),
    ]);
    render(<RoomSection room={panel} />);
    expect(screen.getByText("Join requests (1)")).toBeTruthy();
    fireEvent.click(screen.getByText("Approve as Editor"));
    expect(manage.run).toHaveBeenLastCalledWith("r", [
      { command: "changeRole", target: "p", role: "editor" },
      { command: "approve", target: "p" },
    ]);
    fireEvent.click(screen.getByText("Reject"));
    expect(manage.run).toHaveBeenLastCalledWith("r", [{ command: "denyJoin", target: "p" }]);
    fireEvent.click(screen.getByText("Lock Room"));
    expect(manage.run).toHaveBeenLastCalledWith("r", [{ command: "setLocked", locked: true }]);
    fireEvent.click(screen.getByText("Unban"));
    expect(manage.run).toHaveBeenLastCalledWith("r", [{ command: "unban", target: "b" }]);
    fireEvent.click(screen.getByText("Close Room"));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Close Room" }),
    );
    expect(manage.run).toHaveBeenLastCalledWith("r", [{ command: "closeRoom" }]);
  });

  it("follows the backend: a demotion that arrives while a menu is open removes the menu", () => {
    manageStub();
    const before = room(
      [
        member("o", "Olga", "owner"),
        member("a", "Ada", "admin", { permissions: ["member.kick"] }),
        member("v", "Vic", "viewer"),
      ],
      "a",
    );
    const { rerender } = render(<RoomSection room={before} />);
    expect(screen.getByRole("button", { name: "Manage Vic" })).toBeTruthy();
    const after = room(
      [member("o", "Olga", "owner"), member("a", "Ada", "viewer"), member("v", "Vic", "viewer")],
      "a",
    );
    rerender(<RoomSection room={after} />);
    expect(screen.queryByRole("button", { name: "Manage Vic" })).toBeNull();
  });

  it("offers Leave in a joined room, after a confirmation", () => {
    const manage = manageStub();
    const joined: RoomPanel = {
      ...room([owner, member("me", "Me", "viewer")], "me"),
      side: "participant",
      route: "localLan",
    };
    render(<RoomSection room={joined} />);
    expect(screen.queryByText("Reveal")).toBeNull();
    expect(screen.getByText("Local network")).toBeTruthy();
    fireEvent.click(screen.getByText("Leave Room"));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Leave Room" }),
    );
    expect(manage.leave).toHaveBeenCalledWith("r");
  });
});

describe("joining and diagnostics", () => {
  it("creates a room only with a folder open, and kicks or removes after a confirmation", async () => {
    const create = vi.fn(() => Promise.resolve("r"));
    const manage = manageStub({ create });
    const done = vi.fn();
    const { unmount } = render(<CreateRoomForm folder={null} onDone={done} />);
    expect(screen.getByText(/Open a folder in this window first/)).toBeTruthy();
    unmount();
    render(<CreateRoomForm folder="Shared Project" onDone={done} />);
    expect(screen.getByText(/Shared Project/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Room name"), { target: { value: "Physics Lab" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Create and Host"));
      await Promise.resolve();
    });
    expect(create).toHaveBeenCalledWith("Physics Lab");
    expect(done).toHaveBeenCalled();
    render(<RoomSection room={room([owner, member("k", "Kim", "editor")])} />);
    for (const [label, command] of [
      ["Kick", "kick"],
      ["Remove from Room", "remove"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: "Manage Kim" }));
      fireEvent.click(screen.getByText(label));
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: label }));
      expect(manage.run).toHaveBeenLastCalledWith("r", [{ command, target: "k" }]);
    }
  });

  it("validates the optional Owner address and explains a failure by its category", () => {
    const manage = manageStub({
      joinProgress: vi.fn(() => ({
        busy: false,
        stage: "failed",
        error: { kind: "banned", message: "raw" },
      })),
    });
    render(<JoinRoomForm onDone={() => undefined} />);
    expect(screen.getByText("You are banned from this room.")).toBeTruthy();
    expect(screen.queryByText("raw")).toBeNull();
    fireEvent.click(screen.getByText("Details"));
    expect(screen.getByText("raw")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Room Code"), { target: { value: "CODE" } });
    fireEvent.click(screen.getByText("Owner's local address (optional)"));
    fireEvent.change(screen.getByLabelText(/Owner's local address/, { selector: "input" }), {
      target: { value: "server:1" },
    });
    expect(screen.getByText("Enter an address such as 192.168.1.20:47732.")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Join" }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Owner's local address/, { selector: "input" }), {
      target: { value: "192.168.1.20:47732" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    expect(manage.joinRoom).toHaveBeenCalledWith("CODE", "192.168.1.20:47732");
  });

  it("shows firewall guidance without secrets", async () => {
    manageStub({
      diagnostics: vi.fn(() =>
        Promise.resolve({
          lanEnabled: true,
          signalingConfigured: false,
          turn: { status: "configured", protocols: ["udp", "tls"], relayOnly: false },
          interfaces: [{ rank: 0, addresses: ["192.168.1.20"] }],
          hosting: {
            r: {
              rendezvousPort: 47732,
              listening: true,
              endpoints: ["192.168.1.20:47732"],
              broadcast: true,
              mdns: true,
            },
          },
          routes: {},
          paths: { joined: "turnTls" },
          hostPaths: { r: ["direct", "direct", "turnUdp"] },
          lastJoin: null,
          firewall: { verdict: "blocked", networks: ["Public"] },
        }),
      ),
    });
    render(<CollabDiagnostics onClose={() => undefined} />);
    expect(await screen.findByText("Blocks other computers")).toBeTruthy();
    expect(screen.getByText(/Windows Firewall blocks other computers' connections/)).toBeTruthy();
    expect(screen.getByText("Ready as a fallback (UDP, TLS)")).toBeTruthy();
    expect(screen.getByText("TURN relay (TLS)")).toBeTruthy();
    expect(screen.getByText("Direct × 2, TURN relay (UDP) × 1")).toBeTruthy();
  });

  it("reads a joined room's shared files when the panel opens after they arrived", () => {
    const loadTree = vi.fn(() => Promise.resolve());
    const room = {
      tree: { ready: false, version: 0, root: "", entries: new Map(), children: new Map() },
      expanded: new Set(),
      selected: null,
      loading: new Map(),
      connected: true,
    };
    harness.current = {
      collab: {
        remote: { subscribe: () => () => undefined, room: () => room, rows: () => [], loadTree },
      },
    };
    render(<SharedFiles roomUid="r" />);
    expect(loadTree).toHaveBeenCalledWith("r");
    expect(screen.getByText("Waiting for the Owner's file list…")).toBeTruthy();
  });
});
