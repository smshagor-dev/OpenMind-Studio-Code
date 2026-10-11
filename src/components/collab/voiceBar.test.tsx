import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RoomPanel, ParticipantRow } from "../../services/collab/collabPanelModel";
import type { VoiceMember } from "../../services/collab/voice/voiceIpc";
import type { VoiceView } from "../../services/collab/voice/voiceService";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));
vi.mock("../../services/container", () => ({
  get container() {
    return harness.current;
  },
}));

import { MemberRow } from "./MemberRow";
import { VoiceBar } from "./VoiceBar";

const IDLE: VoiceView = {
  roomUid: null,
  phase: "idle",
  muted: true,
  handRaised: false,
  speaking: false,
  mic: "none",
  problem: null,
  detail: null,
  inputs: [],
  outputs: [],
  inputId: "",
  outputId: "",
  audioPeers: 0,
  audioConnected: 0,
};

function voice(
  view: Partial<VoiceView> = {},
  roster: VoiceMember[] = [],
  mode: "p2p" | "sfu" = "p2p",
) {
  const v = {
    subscribe: () => () => undefined,
    modeOf: () => ({ mode, capacity: mode === "sfu" ? 60 : 6 }),
    getVersion: () => 0,
    state: () => ({ ...IDLE, ...view }),
    roster: () => roster,
    join: vi.fn(() => Promise.resolve()),
    leave: vi.fn(() => Promise.resolve()),
    toggleMute: vi.fn(() => Promise.resolve()),
    setHand: vi.fn(() => Promise.resolve()),
    selectInput: vi.fn(() => Promise.resolve()),
    selectOutput: vi.fn(),
  };
  harness.current = { collab: { voice: v } };
  return v;
}

function room(permissions: string[], over: Partial<RoomPanel> = {}): RoomPanel {
  return {
    roomUid: "r",
    name: "Lab",
    side: "participant",
    state: "connected",
    route: "localLan",
    locked: false,
    approvalRequired: false,
    defaultRole: "viewer",
    closed: false,
    owner: "o",
    you: { peer: "me", role: "viewer", permissions: new Set(permissions) },
    participants: [],
    pending: [],
    banned: [],
    ...over,
  };
}

const member = (peer: string, over: Partial<VoiceMember> = {}): VoiceMember => ({
  peer,
  muted: false,
  speaking: false,
  handRaised: false,
  forceMuted: false,
  canSpeak: true,
  ...over,
});

afterEach(() => {
  harness.current = null;
});

describe("the voice bar", () => {
  it("joins only with voice.join, and passes whether this member may speak", () => {
    const v = voice();
    const { rerender } = render(<VoiceBar room={room([])} />);
    const join = screen.getByRole<HTMLButtonElement>("button", { name: "Join Voice" });
    expect(join.disabled).toBe(true);
    expect(join.title).toBe("You don't have permission to join voice in this room.");
    rerender(<VoiceBar room={room(["voice.join"])} />);
    fireEvent.click(screen.getByRole("button", { name: "Join Voice" }));
    expect(v.join).toHaveBeenCalledWith("r", true, false);
  });

  it("says the call is full without pretending more fit", () => {
    voice(
      {},
      Array.from({ length: 6 }, (_, i) => member(`p${String(i)}`)),
    );
    render(<VoiceBar room={room(["voice.join", "voice.speak"])} />);
    expect(screen.getByText("6 in the call")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Join Voice" }).disabled).toBe(
      true,
    );
  });

  it("in the call: mute, hand, microphone choice and leave; listen-only and force mute explained", () => {
    const v = voice(
      {
        roomUid: "r",
        phase: "joined",
        muted: false,
        mic: "ok",
        inputs: [{ id: "m2", label: "USB Mic" }],
      },
      [member("me")],
    );
    const { rerender } = render(<VoiceBar room={room(["voice.join", "voice.speak"])} />);
    fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    expect(v.toggleMute).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Raise Hand" }));
    expect(v.setHand).toHaveBeenCalledWith(true);
    fireEvent.change(screen.getByLabelText("Microphone"), { target: { value: "m2" } });
    expect(v.selectInput).toHaveBeenCalledWith("m2");
    fireEvent.click(screen.getByRole("button", { name: "Leave Voice" }));
    expect(v.leave).toHaveBeenCalled();
    voice({ roomUid: "r", phase: "joined", muted: true, mic: "none" }, [
      member("me", { canSpeak: false, forceMuted: true, muted: true }),
    ]);
    rerender(<VoiceBar room={room(["voice.join", "voice.speak"])} />);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Unmute" }).disabled).toBe(true);
    expect(screen.getByText(/A moderator muted you/)).toBeTruthy();
    // Force-muted isn't "no permission to speak": only the moderator's note is shown.
    expect(screen.queryByText(/Listen-only/)).toBeNull();
    voice({ roomUid: "r", phase: "joined", muted: true, mic: "none" }, [
      member("me", { canSpeak: false, muted: true }),
    ]);
    rerender(<VoiceBar room={room(["voice.join"])} />);
    expect(screen.getByText(/Listen-only/)).toBeTruthy();
    expect(screen.queryByText(/A moderator muted you/)).toBeNull();
  });

  it("explains a microphone problem in words, not the raw error", () => {
    voice({
      roomUid: "r",
      phase: "joined",
      mic: "privacy",
      problem: "privacy",
      detail: "NotAllowedError: Permission denied by system",
    });
    render(<VoiceBar room={room(["voice.join", "voice.speak"])} />);
    expect(screen.getByRole("alert").textContent).toContain("Windows blocks microphone access");
    expect(screen.queryByText(/NotAllowedError/)).toBeNull();
  });
});

describe("a call member's row", () => {
  const row = (voiceState: VoiceMember | null): ParticipantRow => ({
    peer: "a",
    name: "Ana",
    role: "editor",
    status: "active",
    you: false,
    connection: "online",
    activeFile: null,
    typing: false,
    color: 1,
    granted: null,
    denied: null,
    permissions: null,
    voice: voiceState,
  });

  it("shows speaking, muted, listen-only and a raised hand in words as well as icons", () => {
    voice();
    const r = room([]);
    const { rerender, container } = render(
      <MemberRow room={r} row={row(member("a", { speaking: true }))} onAction={vi.fn()} />,
    );
    expect(screen.getByRole("img", { name: "Speaking" })).toBeTruthy();
    expect(container.querySelector(".collab-person--speaking")).toBeTruthy();
    rerender(
      <MemberRow
        room={r}
        row={row(member("a", { muted: true, handRaised: true }))}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByRole("img", { name: "Muted, hand raised" })).toBeTruthy();
    rerender(
      <MemberRow
        room={r}
        row={row(member("a", { canSpeak: false, muted: true }))}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByRole("img", { name: "Listen-only" })).toBeTruthy();
    rerender(<MemberRow room={r} row={row(null)} onAction={vi.fn()} />);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("offers Force Mute and Allow Speaking only to a moderator with voice.forceMute", () => {
    voice();
    const onAction = vi.fn();
    const moderator = room(["voice.forceMute"], {
      you: { peer: "me", role: "admin", permissions: new Set(["voice.forceMute"]) },
    });
    const { rerender } = render(
      <MemberRow room={moderator} row={row(member("a"))} onAction={onAction} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Manage Ana" }));
    fireEvent.click(screen.getByText("Force Mute"));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ peer: "a" }), {
      kind: "forceMute",
      muted: true,
    });
    rerender(
      <MemberRow
        room={moderator}
        row={row(member("a", { forceMuted: true }))}
        onAction={onAction}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Manage Ana" }));
    expect(screen.getByText("Allow Speaking")).toBeTruthy();
    const plain = room([], { you: { peer: "me", role: "admin", permissions: new Set() } });
    rerender(<MemberRow room={plain} row={row(member("a"))} onAction={onAction} />);
    expect(screen.queryByRole("button", { name: "Manage Ana" })).toBeNull();
  });
});

describe("the voice bar in classroom mode", () => {
  it("says which mode the call uses and that the classroom server carries the audio", () => {
    voice({ roomUid: "r", phase: "joined", audioConnected: 1 }, [member("me")], "sfu");
    render(<VoiceBar room={room(["voice.join", "voice.speak"])} />);
    expect(screen.getByText("Voice: Classroom")).toBeTruthy();
    expect(screen.getByText("Audio connected through the classroom server")).toBeTruthy();
  });

  it("is full only at the classroom limit", () => {
    const six = ["a", "b", "c", "d", "e", "f"].map((p) => member(p));
    voice({}, six, "sfu");
    render(<VoiceBar room={room(["voice.join"])} />);
    expect(screen.getByRole("button", { name: "Join Voice" }).hasAttribute("disabled")).toBe(false);
  });
});
