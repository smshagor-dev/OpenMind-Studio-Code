import { describe, expect, it, vi } from "vitest";

import {
  VOICE_CAPACITY,
  type VoiceEventPayload,
  type VoiceIpc,
  type VoiceMedia,
  type VoiceMember,
  type VoiceMode,
  type VoiceSelf,
} from "./voiceIpc";
import { micProblem, rms, SpeakingDetector } from "./voiceMedia";
import { VoiceService, type VoiceHost } from "./voiceService";
import type { VoiceTransport } from "./voiceTransport";

function track() {
  return { enabled: true, stop: vi.fn() };
}

function member(peer: string, over: Partial<VoiceMember> = {}): VoiceMember {
  return {
    peer,
    muted: false,
    speaking: false,
    handRaised: false,
    forceMuted: false,
    canSpeak: true,
    ...over,
  };
}

function setup(
  over: {
    getUserMedia?: () => Promise<MediaStream>;
    refuse?: (v: VoiceSelf) => string | null;
    media?: VoiceIpc["media"];
    mode?: VoiceMode;
  } = {},
) {
  let emit: (p: VoiceEventPayload) => void = () => undefined;
  const states: VoiceSelf[] = [];
  const mic = track();
  const ipc: VoiceIpc = {
    setState: vi.fn((_room: string, v: VoiceSelf) => {
      const refusal = over.refuse?.(v) ?? null;
      // The backend rejects with its reason as a plain string, not an Error.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      if (refusal) return Promise.reject(refusal);
      states.push(v);
      return Promise.resolve();
    }),
    signal: vi.fn(() => Promise.resolve()),
    snapshot: vi.fn(() =>
      Promise.resolve({
        me: "me",
        members: [],
        capacity: VOICE_CAPACITY[over.mode ?? "p2p"],
        mode: over.mode ?? "p2p",
      }),
    ),
    media: vi.fn(
      over.media ??
        (() =>
          Promise.resolve({
            kind: "p2p" as const,
            iceServers: [],
            iceTransportPolicy: "all" as const,
          })),
    ),
    onVoice: (l) => {
      emit = l;
      return Promise.resolve(() => undefined);
    },
  };
  const transports: (VoiceTransport & {
    peers: string[];
    track: unknown;
    closed: boolean;
    media: VoiceMedia;
    setMuted: ReturnType<typeof vi.fn>;
  })[] = [];
  const getUserMedia = vi.fn(
    over.getUserMedia ??
      (() =>
        Promise.resolve({
          getAudioTracks: () => [mic],
          getTracks: () => [mic],
        } as unknown as MediaStream)),
  );
  let level = 0;
  let tick: () => void = () => undefined;
  const host: VoiceHost = {
    ipc,
    media: {
      getUserMedia,
      enumerateDevices: () =>
        Promise.resolve([
          { kind: "audioinput", deviceId: "mic-2", label: "USB Mic" } as MediaDeviceInfo,
        ]),
      onDeviceChange: () => () => undefined,
    },
    createTransport: (_room, _me, media) => {
      const t = {
        media,
        setMuted: vi.fn(),
        peers: [] as string[],
        track: null as unknown,
        closed: false,
        setPeers(p: readonly string[]) {
          t.peers = [...p];
        },
        setLocalTrack(x: MediaStreamTrack | null) {
          t.track = x;
        },
        handleSignal: vi.fn(),
        setOutputDevice: vi.fn(),
        close() {
          t.closed = true;
        },
        connectionCount: () => t.peers.length,
        connectedCount: () => 0,
        paths: () => Promise.resolve([]),
      };
      transports.push(t);
      return t;
    },
    meter: () => ({ level: () => level, stop: vi.fn() }),
    notice: vi.fn(),
    every: (run) => {
      tick = run;
      return () => undefined;
    },
  };
  const service = new VoiceService(host);
  const roster = (members: VoiceMember[]) => {
    emit({ roomUid: "r", side: "participant", event: { kind: "roster", members, mode: "p2p" } });
  };
  return {
    service,
    ipc,
    host,
    mic,
    states,
    transports,
    getUserMedia,
    roster,
    emit: (p: VoiceEventPayload) => {
      emit(p);
    },
    level: (v: number) => {
      level = v;
      tick();
    },
  };
}

describe("the voice service", () => {
  it("asks for no microphone without voice.join, and none for a listen-only member", async () => {
    const s = setup();
    await s.service.start();
    await s.service.join("r", false, false);
    expect(s.service.state().problem).toBe("notAllowed");
    expect(s.ipc.setState).not.toHaveBeenCalled();
    await s.service.join("r", true, false);
    expect(s.getUserMedia).not.toHaveBeenCalled();
    expect(s.service.state()).toMatchObject({ phase: "joined", muted: true, mic: "none" });
    expect(s.states).toEqual([{ joined: true, muted: true, speaking: false, handRaised: false }]);
  });

  it("asks for the ICE configuration (and any TURN login) only once the Owner accepted the join", async () => {
    const s = setup({ refuse: (v) => (v.joined ? "The voice call is full." : null) });
    await s.service.start();
    await s.service.join("r", true, false);
    expect(s.ipc.media).not.toHaveBeenCalled();
    const ok = setup();
    await ok.service.start();
    await ok.service.join("r", true, false);
    expect(ok.ipc.media).toHaveBeenCalledTimes(1);
    expect(ok.ipc.media).toHaveBeenCalledWith("r");
  });

  it("opens the microphone after joining and sends audio only once the Owner allowed the unmute", async () => {
    const s = setup();
    await s.service.start();
    await s.service.join("r", true, true);
    expect(s.states.map((v) => v.muted)).toEqual([true, false]);
    expect(s.mic.enabled).toBe(true);
    expect(s.transports[0]?.track).toBe(s.mic);
    await s.service.toggleMute();
    expect(s.mic.enabled).toBe(false);
    expect(s.states.at(-1)).toMatchObject({ muted: true });
  });

  it("stays muted when the Owner refuses an unmute, and explains a full call without touching the microphone", async () => {
    const s = setup({
      refuse: (v) => (v.muted ? null : "you may not speak in this room right now"),
    });
    await s.service.start();
    await s.service.join("r", true, true);
    expect(s.mic.enabled).toBe(false);
    expect(s.service.state()).toMatchObject({ muted: true, problem: "refused" });
    const full = setup({ refuse: () => "the voice call is full" });
    await full.service.start();
    await full.service.join("r", true, true);
    expect(full.service.state()).toMatchObject({ phase: "idle", problem: "full" });
    expect(full.getUserMedia).not.toHaveBeenCalled();
  });

  it("tells a denied, blocked, missing or busy microphone apart and keeps the member listening", async () => {
    const denied = setup({
      getUserMedia: () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")),
    });
    await denied.service.start();
    await denied.service.join("r", true, true);
    expect(denied.service.state()).toMatchObject({ phase: "joined", mic: "denied", muted: true });
    expect(micProblem(new DOMException("Permission denied by system", "NotAllowedError"))).toBe(
      "privacy",
    );
    expect(micProblem(new DOMException("", "NotFoundError"))).toBe("noDevice");
    expect(micProblem(new DOMException("", "NotReadableError"))).toBe("busy");
  });

  it("obeys the Owner: a moderator's mute and a lost permission stop sending, removal ends the call", async () => {
    const s = setup();
    await s.service.start();
    await s.service.join("r", true, true);
    s.roster([member("me"), member("you")]);
    expect(s.transports[0]?.peers).toEqual(["me", "you"]);
    s.roster([member("me", { muted: true, forceMuted: true, canSpeak: false }), member("you")]);
    expect(s.mic.enabled).toBe(false);
    expect(s.host.notice).toHaveBeenCalledWith("voice.notice.forceMuted");
    s.roster([member("you")]);
    expect(s.service.state().phase).toBe("idle");
    expect(s.transports[0]?.closed).toBe(true);
    expect(s.mic.stop).toHaveBeenCalled();
  });

  it("reports speaking steadily, raises a hand and leaves without leaving the room", async () => {
    const s = setup();
    await s.service.start();
    await s.service.join("r", true, true);
    s.level(0.2);
    expect(s.service.state().speaking).toBe(false);
    s.level(0.2);
    expect(s.service.state().speaking).toBe(true);
    for (let i = 0; i < 7; i++) s.level(0);
    expect(s.service.state().speaking).toBe(true);
    s.level(0);
    expect(s.service.state().speaking).toBe(false);
    await s.service.setHand(true);
    expect(s.states.at(-1)).toMatchObject({ handRaised: true });
    await s.service.leave();
    expect(s.states.at(-1)).toEqual({
      joined: false,
      muted: true,
      speaking: false,
      handRaised: false,
    });
    expect(s.mic.stop).toHaveBeenCalled();
    expect(s.transports[0]?.closed).toBe(true);
  });

  it("drops the media on a lost room connection and negotiates afresh on the new session", async () => {
    const s = setup();
    await s.service.start();
    await s.service.join("r", true, true);
    s.emit({ roomUid: "r", side: "participant", event: { kind: "reset" } });
    expect(s.service.state().phase).toBe("reconnecting");
    expect(s.transports[0]?.closed).toBe(true);
    await s.service.reconnected("r");
    expect(s.transports).toHaveLength(2);
    expect(s.transports[1]?.track).toBe(s.mic);
    expect(s.service.state().phase).toBe("joined");
  });

  it("forwards negotiation only for the call it is in", async () => {
    const s = setup();
    await s.service.start();
    await s.service.join("r", true, false);
    const offer = { kind: "offer" as const, sdp: "x" };
    s.emit({
      roomUid: "other",
      side: "participant",
      event: { kind: "signal", from: "a", signal: offer },
    });
    s.emit({
      roomUid: "r",
      side: "participant",
      event: { kind: "signal", from: "a", signal: offer },
    });
    expect(s.transports[0]?.handleSignal).toHaveBeenCalledTimes(1);
  });
});

describe("speaking detection", () => {
  it("needs two loud frames to start and eight quiet ones to stop", () => {
    const d = new SpeakingDetector();
    expect(d.push(0.1)).toBeNull();
    expect(d.push(0.1)).toBe(true);
    expect(d.push(0.03)).toBeNull(); // between the thresholds: still speaking
    for (let i = 0; i < 7; i++) expect(d.push(0)).toBeNull();
    expect(d.push(0)).toBe(false);
    expect(rms(new Uint8Array([128, 128]))).toBe(0);
  });
});

describe("roster freshness", () => {
  it("never lets an older snapshot overwrite a newer roster event", async () => {
    let resolveSnapshot: (v: {
      me: string;
      members: VoiceMember[];
      capacity: number;
      mode: "p2p" | "sfu";
    }) => void = () => undefined;
    let emit: (p: VoiceEventPayload) => void = () => undefined;
    const service = new VoiceService({
      ipc: {
        setState: () => Promise.resolve(),
        signal: () => Promise.resolve(),
        snapshot: () =>
          new Promise((r) => {
            resolveSnapshot = r;
          }),
        media: () => Promise.resolve({ kind: "p2p", iceServers: [], iceTransportPolicy: "all" }),
        onVoice: (l) => {
          emit = l;
          return Promise.resolve(() => undefined);
        },
      },
      media: {
        getUserMedia: () => Promise.reject(new Error("no")),
        enumerateDevices: () => Promise.resolve([]),
        onDeviceChange: () => () => undefined,
      },
      createTransport: () => {
        throw new Error("unused");
      },
      meter: () => ({ level: () => 0, stop: () => undefined }),
      notice: () => undefined,
      every: () => () => undefined,
    });
    await service.start();
    const loading = service.load("r");
    emit({
      roomUid: "r",
      side: "participant",
      event: { kind: "roster", members: [member("a"), member("b")], mode: "p2p" },
    });
    resolveSnapshot({ me: "me", members: [], capacity: 6, mode: "p2p" });
    await loading;
    expect(service.roster("r").map((m) => m.peer)).toEqual(["a", "b"]);
  });
});

describe("the room going away", () => {
  it("ends the call and releases the microphone when the room leaves the network", async () => {
    const s = setup();
    await s.service.start();
    await s.service.join("r", true, true);
    s.service.roomGone("other");
    expect(s.service.state().phase).toBe("joined");
    s.service.roomGone("r");
    expect(s.service.state()).toMatchObject({ phase: "idle", roomUid: null });
    expect(s.mic.stop).toHaveBeenCalled();
    expect(s.transports[0]?.closed).toBe(true);
  });
});

describe("classroom voice", () => {
  const grant = () =>
    Promise.resolve({
      kind: "sfu" as const,
      url: "ws://192.168.1.20:7880",
      token: "t",
      expiresMs: 1,
    });

  it("joins through the media server with the Owner's grant and mutes the publication itself", async () => {
    const s = setup({ mode: "sfu", media: grant });
    await s.service.start();
    await s.service.join("r", true, true);
    expect(s.service.modeOf("r")).toEqual({ mode: "sfu", capacity: 60 });
    expect(s.transports[0]?.media).toMatchObject({ kind: "sfu", url: "ws://192.168.1.20:7880" });
    expect(s.transports[0]?.setMuted).toHaveBeenLastCalledWith(false);
    await s.service.toggleMute();
    expect(s.transports[0]?.setMuted).toHaveBeenLastCalledWith(true);
    expect(s.mic.enabled).toBe(false);
  });

  it("asks a listen-only member for no microphone in a classroom either", async () => {
    const s = setup({ mode: "sfu", media: grant });
    await s.service.start();
    await s.service.join("r", true, false);
    expect(s.getUserMedia).not.toHaveBeenCalled();
    expect(s.transports[0]?.track).toBeNull();
    expect(s.service.state()).toMatchObject({ phase: "joined", mic: "none" });
  });

  it("an unreachable media server is a voice problem, and the member leaves the call it had joined", async () => {
    const s = setup({
      mode: "sfu",
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      media: () => Promise.reject("the classroom media server isn't available"),
    });
    await s.service.start();
    await s.service.join("r", true, true);
    expect(s.service.state()).toMatchObject({ phase: "idle", problem: "classroomUnavailable" });
    expect(s.getUserMedia).not.toHaveBeenCalled();
    expect(s.states.at(-1)).toMatchObject({ joined: false });
  });

  it("a lost media server ends the call and releases the microphone, and nothing else", async () => {
    const s = setup({ mode: "sfu", media: grant });
    await s.service.start();
    await s.service.join("r", true, true);
    s.service.transportLost();
    expect(s.service.state()).toMatchObject({ phase: "idle", problem: "classroomLost" });
    expect(s.mic.stop).toHaveBeenCalled();
    expect(s.transports[0]?.closed).toBe(true);
    expect(s.service.modeOf("r").mode).toBe("sfu");
  });

  it("follows the Owner's mode from the roster", async () => {
    const s = setup();
    await s.service.start();
    s.emit({
      roomUid: "r",
      side: "participant",
      event: { kind: "roster", members: [], mode: "sfu" },
    });
    expect(s.service.modeOf("r")).toEqual({ mode: "sfu", capacity: 60 });
  });

  it("stops classroom media when the room connection drops, and asks the Owner again after the reconnect", async () => {
    let grants = 0;
    const s = setup({
      mode: "sfu",
      media: () => {
        grants += 1;
        return grant();
      },
    });
    await s.service.start();
    await s.service.join("r", true, true);
    expect(grants).toBe(1);
    // The room connection drops: no media keeps flowing without the room's authority.
    s.emit({ roomUid: "r", side: "participant", event: { kind: "reset" } });
    expect(s.transports[0]?.closed).toBe(true);
    expect(s.service.state().phase).toBe("reconnecting");
    // A new session: a fresh grant and a new media connection (nothing from the old session is reused).
    await s.service.reconnected("r");
    expect(grants).toBe(2);
    expect(s.transports).toHaveLength(2);
    expect(s.service.state().phase).toBe("joined");
  });

  it("ends the call when the Owner refuses it after the reconnect (rights changed meanwhile)", async () => {
    let calls = 0;
    const s = setup({
      mode: "sfu",
      refuse: (v) =>
        v.joined && ++calls > 2 ? "you may not join voice in this room (voice.join)" : null,
      media: grant,
    });
    await s.service.start();
    await s.service.join("r", true, true);
    s.emit({ roomUid: "r", side: "participant", event: { kind: "reset" } });
    await s.service.reconnected("r");
    expect(s.service.state()).toMatchObject({ phase: "idle", problem: "notAllowed" });
    expect(s.transports).toHaveLength(1);
    expect(s.mic.stop).toHaveBeenCalled();
  });
});
