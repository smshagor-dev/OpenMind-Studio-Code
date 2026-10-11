import { describe, expect, it, vi } from "vitest";

import type { VoiceIce, VoiceSignal } from "./voiceIpc";
import { MAX_PEER_CONNECTIONS, PeerMeshVoiceTransport, type MeshHost } from "./voiceTransport";

/** Just enough of RTCPeerConnection for the mesh's negotiation logic. */
class FakePc {
  static all: FakePc[] = [];
  onicecandidate: ((e: { candidate: RTCIceCandidate | null }) => void) | null = null;
  ontrack: ((e: { streams: MediaStream[]; track: MediaStreamTrack }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState = "new";
  signalingState = "stable";
  localDescription: { sdp: string } | null = null;
  remoteDescription: { sdp: string } | null = null;
  closed = false;
  candidates: RTCIceCandidateInit[] = [];
  sender = { replaceTrack: vi.fn(() => Promise.resolve()) };
  transceivers: { sender: FakePc["sender"]; direction: string }[] = [];
  constructor(public config: RTCConfiguration) {
    FakePc.all.push(this);
  }
  addTransceiver() {
    const t = { sender: this.sender, direction: "sendrecv" };
    this.transceivers.push(t);
    return t;
  }
  getTransceivers() {
    if (this.transceivers.length === 0) this.addTransceiver();
    return this.transceivers;
  }
  createOffer() {
    return Promise.resolve({ type: "offer", sdp: "offer-sdp" });
  }
  createAnswer() {
    return Promise.resolve({ type: "answer", sdp: "answer-sdp" });
  }
  setLocalDescription(d: { type: string; sdp: string }) {
    this.localDescription = d;
    if (d.type === "offer") this.signalingState = "have-local-offer";
    return Promise.resolve();
  }
  setRemoteDescription(d: { sdp: string }) {
    this.remoteDescription = d;
    this.signalingState = "stable";
    return Promise.resolve();
  }
  addIceCandidate(c: RTCIceCandidateInit) {
    this.candidates.push(c);
    return Promise.resolve();
  }
  close() {
    this.closed = true;
  }
}

function mesh(me: string, ice: VoiceIce = { iceServers: [], iceTransportPolicy: "all" }) {
  FakePc.all = [];
  const sent: [string, VoiceSignal][] = [];
  const audio = { stop: vi.fn(), output: vi.fn() };
  const host: MeshHost = {
    me,
    ice,
    send: (to, s) => sent.push([to, s]),
    createConnection: (config) => new FakePc(config) as unknown as RTCPeerConnection,
    play: vi.fn(() => audio),
    failed: vi.fn(),
  };
  return { t: new PeerMeshVoiceTransport(host), sent, host, audio };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the peer-mesh voice transport", () => {
  it("connects once per member, the lower id offering, with no ICE server on the local network", async () => {
    const { t, sent } = mesh("b");
    t.setPeers(["a", "c", "b"]);
    t.setPeers(["a", "c"]);
    await flush();
    expect(t.connectionCount()).toBe(2);
    expect(FakePc.all.map((pc) => pc.config.iceServers)).toEqual([[], []]);
    // b < c: b offers to c; a < b: b waits for a's offer (no glare).
    expect(sent).toEqual([["c", { kind: "offer", sdp: "offer-sdp" }]]);
  });

  it("answers an offer, applies candidates only after the description, and ignores an offer it should send", async () => {
    const { t, sent } = mesh("b");
    t.setPeers(["a", "c"]);
    t.handleSignal("a", { kind: "candidate", candidate: "c1", sdpMid: "0", sdpMLineIndex: 0 });
    t.handleSignal("a", { kind: "offer", sdp: "remote-offer" });
    await flush();
    await flush();
    const toA = FakePc.all[0] as FakePc;
    expect(toA.remoteDescription?.sdp).toBe("remote-offer");
    expect(toA.candidates.map((c) => c.candidate)).toEqual(["c1"]);
    expect(sent).toContainEqual(["a", { kind: "answer", sdp: "answer-sdp" }]);
    const toC = FakePc.all[1] as FakePc;
    t.handleSignal("c", { kind: "offer", sdp: "glare" });
    await flush();
    expect(toC.remoteDescription).toBeNull();
    t.handleSignal("c", { kind: "answer", sdp: "c-answer" });
    await flush();
    expect(toC.remoteDescription?.sdp).toBe("c-answer");
  });

  it("keeps an offer that arrives before the roster and replays it then", async () => {
    const { t, sent } = mesh("b");
    t.handleSignal("a", { kind: "offer", sdp: "early" });
    expect(t.connectionCount()).toBe(0);
    t.setPeers(["a"]);
    await flush();
    await flush();
    expect(sent).toContainEqual(["a", { kind: "answer", sdp: "answer-sdp" }]);
  });

  it("plays each member once, switches the output, replaces the track without renegotiating, and cleans up", async () => {
    const { t, host, audio, sent } = mesh("a");
    t.setPeers(["b"]);
    await flush();
    const pc = FakePc.all[0] as FakePc;
    const track = { kind: "audio" } as MediaStreamTrack;
    const stream = {} as MediaStream;
    pc.ontrack?.({ streams: [stream], track });
    pc.ontrack?.({ streams: [stream], track });
    expect(host.play).toHaveBeenCalledTimes(2);
    expect(audio.stop).toHaveBeenCalledTimes(1);
    t.setOutputDevice("speaker-2");
    expect(audio.output).toHaveBeenCalledWith("speaker-2");
    const offers = sent.filter(([, s]) => s.kind === "offer").length;
    t.setLocalTrack(track);
    expect(pc.sender.replaceTrack).toHaveBeenLastCalledWith(track);
    expect(sent.filter(([, s]) => s.kind === "offer").length).toBe(offers);
    t.setPeers([]);
    expect(pc.closed).toBe(true);
    expect(audio.stop).toHaveBeenCalledTimes(2);
    expect(sent.at(-1)).toEqual(["b", { kind: "close" }]);
    expect(t.connectionCount()).toBe(0);
  });

  it("restarts ICE once after a failure, then gives up; never holds more than its limit", async () => {
    const { t, host, sent } = mesh("a");
    t.setPeers(["b"]);
    await flush();
    const pc = FakePc.all[0] as FakePc;
    pc.connectionState = "failed";
    pc.onconnectionstatechange?.();
    await flush();
    expect(sent.filter(([, s]) => s.kind === "offer").length).toBe(2);
    pc.onconnectionstatechange?.();
    expect(host.failed).toHaveBeenCalledWith("b");
    expect(t.connectionCount()).toBe(0);
    const many = Array.from({ length: 20 }, (_, i) => `z${String(i).padStart(2, "0")}`);
    t.setPeers(many);
    expect(t.connectionCount()).toBe(MAX_PEER_CONNECTIONS);
    t.close();
    expect(t.connectionCount()).toBe(0);
  });

  it("builds connections with exactly the servers and policy the room gave", async () => {
    const turn = {
      urls: [
        "turn:turn.example.org:3478?transport=udp",
        "turns:turn.example.org:443?transport=tcp",
      ],
      username: "u",
      credential: "p",
    };
    mesh("a", {
      iceServers: [{ urls: ["stun:stun.example.org:3478"] }, turn],
      iceTransportPolicy: "relay",
    }).t.setPeers(["b"]);
    await flush();
    expect(FakePc.all[0]?.config.iceServers).toEqual([
      { urls: ["stun:stun.example.org:3478"] },
      turn,
    ]);
    expect(FakePc.all[0]?.config.iceTransportPolicy).toBe("relay");
  });
});
