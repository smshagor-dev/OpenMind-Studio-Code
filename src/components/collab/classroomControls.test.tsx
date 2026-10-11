import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RoomPanel } from "../../services/collab/collabPanelModel";
import type { ClassroomIpc, ClassroomStatus } from "../../services/collab/voice/classroomIpc";
import type { VoiceMember } from "../../services/collab/voice/voiceIpc";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));
vi.mock("../../services/container", () => ({
  get container() {
    return harness.current;
  },
}));

import { ClassroomVoiceControls } from "./ClassroomVoiceControls";

function voiceWith(mode: "p2p" | "sfu", roster: VoiceMember[] = []) {
  const run = vi.fn();
  harness.current = {
    run,
    collab: {
      voice: {
        subscribe: () => () => undefined,
        getVersion: () => 0,
        modeOf: () => ({ mode, capacity: mode === "sfu" ? 60 : 6 }),
        roster: () => roster,
      },
    },
  };
  return run;
}

function status(over: Partial<ClassroomStatus> = {}): ClassroomStatus {
  return {
    localSupported: true,
    installed: true,
    local: { running: false, bind: null, url: null, httpPort: 7880, udpPort: 7882 },
    externalUrl: null,
    externalHasSecret: false,
    addresses: ["192.168.1.20", "127.0.0.1"],
    ...over,
  };
}

function fakeIpc(s: ClassroomStatus): ClassroomIpc {
  return {
    status: vi.fn(() => Promise.resolve(s)),
    startLocal: vi.fn(() => Promise.resolve()),
    stopLocal: vi.fn(() => Promise.resolve()),
    setMode: vi.fn(() => Promise.resolve()),
    setSecret: vi.fn(() => Promise.resolve()),
    clearSecret: vi.fn(() => Promise.resolve()),
    mediaRoom: vi.fn(() => Promise.resolve({ connected: 0, mayPublish: 0, publishingAudio: 0 })),
  };
}

function room(over: Partial<RoomPanel> = {}): RoomPanel {
  return {
    roomUid: "r",
    name: "Lab",
    side: "host",
    state: "connected",
    route: "localLan",
    locked: false,
    approvalRequired: false,
    defaultRole: "viewer",
    closed: false,
    owner: "me",
    you: { peer: "me", role: "owner", permissions: new Set() },
    participants: [],
    pending: [],
    banned: [],
    ...over,
  };
}

afterEach(() => {
  cleanup();
  harness.current = null;
});

describe("the Owner's classroom voice controls", () => {
  it("are not shown to a member", () => {
    voiceWith("p2p");
    const { container } = render(
      <ClassroomVoiceControls room={room({ side: "participant" })} ipc={fakeIpc(status())} />,
    );
    expect(container.textContent).toBe("");
  });

  it("switch the room to classroom voice, but not while anyone is in the call", async () => {
    voiceWith("p2p");
    const ipc = fakeIpc(status());
    render(<ClassroomVoiceControls room={room()} ipc={ipc} />);
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => {
      expect(ipc.setMode).toHaveBeenCalledWith("r", "sfu");
    });

    voiceWith("p2p", [
      {
        peer: "a",
        muted: true,
        speaking: false,
        handRaised: false,
        forceMuted: false,
        canSpeak: true,
      },
    ]);
    render(<ClassroomVoiceControls room={room()} ipc={fakeIpc(status())} />);
    expect(screen.getAllByRole("checkbox")[1]?.hasAttribute("disabled")).toBe(true);
  });

  it("start the local server on the chosen address, and offer the Runtime Manager when it isn't installed", async () => {
    voiceWith("sfu");
    const ipc = fakeIpc(status());
    render(<ClassroomVoiceControls room={room()} ipc={ipc} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start Server" }));
    await waitFor(() => {
      expect(ipc.startLocal).toHaveBeenCalledWith("192.168.1.20");
    });

    const run = voiceWith("sfu");
    render(<ClassroomVoiceControls room={room()} ipc={fakeIpc(status({ installed: false }))} />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Install the Classroom Voice Server/ }),
    );
    expect(run).toHaveBeenCalledWith("runtime.manage");
  });

  it("save a configured server's secret once and clear the field", async () => {
    voiceWith("sfu");
    const ipc = fakeIpc(status({ externalUrl: "wss://media.example.edu", installed: false }));
    render(<ClassroomVoiceControls room={room()} ipc={ipc} />);
    expect(await screen.findByText(/its secret isn't saved/)).toBeTruthy();
    const field = screen.getByPlaceholderText("Media server API secret");
    fireEvent.change(field, { target: { value: "a-long-enough-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Secret" }));
    await waitFor(() => {
      expect(ipc.setSecret).toHaveBeenCalledWith("a-long-enough-secret");
    });
    expect((field as HTMLInputElement).value).toBe("");
  });

  it("offer no local server where none can run (not Windows x64): only the explanation", async () => {
    voiceWith("sfu");
    render(
      <ClassroomVoiceControls
        room={room()}
        ipc={fakeIpc(status({ localSupported: false, installed: false }))}
      />,
    );
    expect(await screen.findByText(/can't run on this computer/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Start Server|Install/ })).toBeNull();
  });
});
