import { describe, expect, it, vi } from "vitest";

import type { CollabNetIpc } from "./collabNetIpc";
import type { JoinStage, RoomCommand, RoomIpc } from "./roomIpc";
import { RoomManagementService, type RoomManagementHost } from "./roomManagementService";

function setup(side: "host" | "participant" | null = "host") {
  let joinListener: ((stage: JoinStage) => void) | null = null;
  const ipc = {
    create: vi.fn(() => Promise.resolve({ roomUid: "r", code: "CODE-1" })),
    invite: vi.fn(() => Promise.resolve("CODE-1")),
    hostCommand: vi.fn<(room: string, command: RoomCommand) => Promise<void>>(() =>
      Promise.resolve(),
    ),
    remoteCommand: vi.fn<(room: string, command: RoomCommand) => Promise<void>>(() =>
      Promise.resolve(),
    ),
    permissionModel: vi.fn(() => Promise.resolve({ permissions: [], roles: [], ownerOnly: [] })),
    identity: vi.fn(() => Promise.resolve({ peerId: "me" })),
    onJoin: (listener: (stage: JoinStage) => void) => {
      joinListener = listener;
      return Promise.resolve(() => undefined);
    },
  } satisfies RoomIpc;
  const net = {
    hostStart: vi.fn(() => Promise.resolve()),
    join: vi.fn(() =>
      Promise.resolve({ roomUid: "r", roomName: "R", role: "viewer", route: "localLan" as const }),
    ),
    leave: vi.fn(() => Promise.resolve()),
    diagnostics: vi.fn(),
  };
  const host = {
    side: vi.fn(() => side),
    refreshRooms: vi.fn(() => Promise.resolve()),
    copy: vi.fn(() => Promise.resolve()),
    error: vi.fn(),
  } satisfies RoomManagementHost;
  const service = new RoomManagementService(ipc, net as unknown as CollabNetIpc, host);
  return { service, ipc, net, host, stage: (s: JoinStage) => joinListener?.(s) };
}

describe("RoomManagementService", () => {
  it("runs a hosted room's command here and a joined room's at its Owner, in order, stopping at a refusal", async () => {
    const host = setup("host");
    const commands: RoomCommand[] = [
      { command: "changeRole", target: "p", role: "editor" },
      { command: "approve", target: "p" },
    ];
    expect(await host.service.run("r", commands)).toBe(true);
    expect(host.ipc.hostCommand.mock.calls.map((c) => c[1])).toEqual(commands);
    expect(host.ipc.remoteCommand).not.toHaveBeenCalled();

    const member = setup("participant");
    member.ipc.remoteCommand.mockRejectedValueOnce("that member's role is equal to or above yours");
    expect(await member.service.run("r", commands)).toBe(false);
    expect(member.ipc.remoteCommand).toHaveBeenCalledTimes(1);
    expect(member.host.error).toHaveBeenCalledWith("that member's role is equal to or above yours");
    expect(member.service.isBusy("r")).toBe(false);
  });

  it("does nothing for a room this computer isn't on the network with", async () => {
    const none = setup(null);
    expect(await none.service.run("r", [{ command: "rotateInvite" }])).toBe(false);
    expect(none.ipc.hostCommand).not.toHaveBeenCalled();
  });

  it("shows the Room Code only on request, copies without keeping it, and refreshes it after a rotation", async () => {
    const { service, ipc, host } = setup();
    expect(service.code("r")).toBeNull();
    await service.copyCode("r");
    expect(host.copy).toHaveBeenCalledWith("CODE-1");
    expect(service.code("r")).toBeNull();
    await service.reveal("r");
    expect(service.code("r")).toBe("CODE-1");
    ipc.invite.mockResolvedValueOnce("CODE-2");
    await service.run("r", [{ command: "rotateInvite" }]);
    expect(service.code("r")).toBe("CODE-2");
    service.hide("r");
    expect(service.code("r")).toBeNull();
  });

  it("creates a room, hosts it and shows its code", async () => {
    const { service, net, host } = setup();
    expect(await service.create("  Physics Lab ")).toBe("r");
    expect(net.hostStart).toHaveBeenCalledWith("r");
    expect(host.refreshRooms).toHaveBeenCalled();
    expect(service.code("r")).toBe("CODE-1");
  });

  it("reports join progress and a failure category", async () => {
    const { service, net, stage } = setup();
    await service.start();
    stage("searching");
    expect(service.joinProgress().stage).toBeNull();
    let finish: (v: unknown) => void = () => undefined;
    net.join.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finish = (v) => {
            if (v === "fail")
              // The backend's JoinError arrives as a plain object, not an Error.
              // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
              reject({ kind: "locked", message: "The room refused the connection: Locked" });
            else resolve(v as never);
          };
        }),
    );
    const joining = service.joinRoom(" CODE ");
    expect(net.join).toHaveBeenCalledWith("CODE", null);
    stage("pending");
    expect(service.joinProgress()).toMatchObject({ busy: true, stage: "pending" });
    finish("fail");
    expect(await joining).toEqual({
      kind: "locked",
      message: "The room refused the connection: Locked",
    });
    expect(service.joinProgress()).toMatchObject({ busy: false, stage: "failed" });
    expect(await service.joinRoom("CODE")).toBeNull();
    expect(net.join).toHaveBeenLastCalledWith("CODE", null);
  });

  it("leaves a room and forgets its code", async () => {
    const { service, net, host } = setup("participant");
    await service.leave("r");
    expect(net.leave).toHaveBeenCalledWith("r");
    expect(host.refreshRooms).toHaveBeenCalled();
  });
});
