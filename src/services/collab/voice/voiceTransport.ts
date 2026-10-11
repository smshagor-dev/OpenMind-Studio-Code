import type { VoiceIce, VoiceSignal } from "./voiceIpc";
import { selectedPath, type VoicePath } from "./voicePath";

/**
 * How this window's audio reaches the other members of a call and theirs reaches it. The voice service (join, mute,
 * devices, permissions, moderation, speaking) only talks to this interface, so a media-server transport for large
 * classes can replace the peer mesh later without touching the rest.
 */
export interface VoiceTransport {
  /** The members (peer ids, this one excluded) to exchange audio with now; connections follow this set. */
  setPeers: (peers: readonly string[]) => void;
  /** The microphone track to send (`null`: send nothing — listen-only or no microphone). Never renegotiates. */
  setLocalTrack: (track: MediaStreamTrack | null) => void;
  /** A negotiation message from another member (already authorized and named by the Owner). */
  handleSignal: (from: string, signal: VoiceSignal) => void;
  /** Where remote audio plays (an output device id; `""` = system default), when the platform supports choosing. */
  setOutputDevice: (deviceId: string) => void;
  /** Ends every connection and releases every audio resource. */
  close: () => void;
  /** Open connections (for limits and tests). */
  connectionCount: () => number;
  /** Connections whose audio path is up. */
  connectedCount: () => number;
  /** The kind of path each connected member's audio takes (diagnostics; no address). */
  paths: () => Promise<VoicePath[]>;
  /**
   * The member muted or unmuted (the sent track is already disabled/enabled). A transport whose other side tracks mute
   * state itself (a media server) is told; the peer mesh needs nothing more.
   */
  setMuted?: (muted: boolean) => void;
}

/** What the mesh needs from the platform (real WebRTC in the app, fakes in tests). */
export interface MeshHost {
  me: string;
  ice: VoiceIce;
  send: (to: string, signal: VoiceSignal) => void;
  createConnection: (config: RTCConfiguration) => RTCPeerConnection;
  /** A remote member's audio: play it (on `deviceId`, `""` = default); stop it / move it to another output. */
  play: (peer: string, stream: MediaStream, deviceId: string) => RemoteAudio;
  /** A connection failed for good (after a restart attempt). */
  failed: (peer: string) => void;
  /** A connection's state changed (for "audio connected with N of M"). */
  changed?: () => void;
}

/** One remote member's playing audio. */
export interface RemoteAudio {
  stop: () => void;
  output: (deviceId: string) => void;
}

interface PeerLink {
  pc: RTCPeerConnection;
  /** The lower peer id offers; the other only answers (no glare, no renegotiation races). */
  offerer: boolean;
  transceiver: RTCRtpTransceiver | null;
  audio: RemoteAudio | null;
  pendingCandidates: RTCIceCandidateInit[];
  restarted: boolean;
}

/** Peer connections one window may hold at once (a call of six is five; this is a hard ceiling). */
export const MAX_PEER_CONNECTIONS = 8;
/** Negotiation messages kept per not-yet-known sender (an offer and its candidates). */
const EARLY_SIGNALS = 24;

/**
 * Small-room voice: a full mesh of WebRTC audio connections, one per other member, directly between WebViews. Audio
 * never goes through the Owner or the collaboration connection; only negotiation does (through the Owner, which checks
 * both ends are in the call). Muting or switching microphones replaces the sent track — no renegotiation.
 */
export class PeerMeshVoiceTransport implements VoiceTransport {
  private links = new Map<string, PeerLink>();
  /** Negotiation that arrived before the roster named its sender (the two travel separately): replayed then. */
  private early = new Map<string, VoiceSignal[]>();
  private track: MediaStreamTrack | null = null;
  private outputDevice = "";

  constructor(private readonly host: MeshHost) {}

  setPeers(peers: readonly string[]): void {
    const wanted = new Set(peers.filter((p) => p !== this.host.me).slice(0, MAX_PEER_CONNECTIONS));
    for (const peer of [...this.links.keys()]) if (!wanted.has(peer)) this.drop(peer, true);
    for (const peer of wanted) if (!this.links.has(peer)) this.open(peer);
    for (const [peer, signals] of [...this.early]) {
      this.early.delete(peer);
      if (wanted.has(peer)) for (const signal of signals) this.handleSignal(peer, signal);
    }
  }

  setLocalTrack(track: MediaStreamTrack | null): void {
    this.track = track;
    for (const link of this.links.values()) void link.transceiver?.sender.replaceTrack(track);
  }

  handleSignal(from: string, signal: VoiceSignal): void {
    if (signal.kind === "close") {
      this.drop(from, false);
      return;
    }
    const link = this.links.get(from);
    if (!link) {
      // Not (yet) someone this window is in a call with: kept briefly, in case the roster naming it is on its way.
      const kept = this.early.get(from) ?? [];
      if (kept.length < EARLY_SIGNALS && this.early.size < MAX_PEER_CONNECTIONS)
        this.early.set(from, [...kept, signal]);
      return;
    }
    void this.apply(from, link, signal).catch(() => {
      this.drop(from, true);
      this.host.failed(from);
    });
  }

  setOutputDevice(deviceId: string): void {
    this.outputDevice = deviceId;
    for (const link of this.links.values()) link.audio?.output(deviceId);
  }

  close(): void {
    for (const peer of [...this.links.keys()]) this.drop(peer, true);
    this.early.clear();
  }

  connectionCount(): number {
    return this.links.size;
  }

  connectedCount(): number {
    return [...this.links.values()].filter((l) => l.pc.connectionState === "connected").length;
  }

  async paths(): Promise<VoicePath[]> {
    const connected = [...this.links.values()].filter((l) => l.pc.connectionState === "connected");
    const found = await Promise.all(
      connected.map((l) =>
        l.pc
          .getStats()
          .then(selectedPath)
          .catch(() => null),
      ),
    );
    return found.filter((p): p is VoicePath => p !== null);
  }

  private open(peer: string): void {
    const pc = this.host.createConnection({
      iceServers: this.host.ice.iceServers.map((server) => ({ ...server })),
      iceTransportPolicy: this.host.ice.iceTransportPolicy,
      bundlePolicy: "max-bundle",
    });
    const link: PeerLink = {
      pc,
      offerer: this.host.me < peer,
      transceiver: null,
      audio: null,
      pendingCandidates: [],
      restarted: false,
    };
    this.links.set(peer, link);
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const { candidate, sdpMid, sdpMLineIndex } = event.candidate;
      this.host.send(peer, {
        kind: "candidate",
        candidate,
        sdpMid: sdpMid ?? null,
        sdpMLineIndex: sdpMLineIndex ?? null,
      });
    };
    pc.ontrack = (event) => {
      link.audio?.stop(); // a renegotiated track replaces the old sink: never two of one member
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      link.audio = this.host.play(peer, stream, this.outputDevice);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") this.recover(peer, link);
      this.host.changed?.();
    };
    if (link.offerer) {
      link.transceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
      void link.transceiver.sender.replaceTrack(this.track);
      void this.offer(peer, link, false);
    }
  }

  private async offer(peer: string, link: PeerLink, iceRestart: boolean): Promise<void> {
    const offer = await link.pc.createOffer({ iceRestart });
    await link.pc.setLocalDescription(offer);
    this.host.send(peer, { kind: "offer", sdp: link.pc.localDescription?.sdp ?? offer.sdp ?? "" });
  }

  private async apply(peer: string, link: PeerLink, signal: VoiceSignal): Promise<void> {
    const { pc } = link;
    if (signal.kind === "offer") {
      if (link.offerer) return; // the other side must answer, not offer (it would be glare)
      await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
      link.transceiver ??= pc.getTransceivers()[0] ?? null;
      if (link.transceiver) {
        link.transceiver.direction = "sendrecv";
        await link.transceiver.sender.replaceTrack(this.track);
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.host.send(peer, { kind: "answer", sdp: pc.localDescription?.sdp ?? answer.sdp ?? "" });
      await this.flushCandidates(link);
    } else if (signal.kind === "answer") {
      if (!link.offerer || pc.signalingState !== "have-local-offer") return;
      await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
      await this.flushCandidates(link);
    } else if (signal.kind === "candidate") {
      const candidate = {
        candidate: signal.candidate,
        sdpMid: signal.sdpMid,
        sdpMLineIndex: signal.sdpMLineIndex,
      };
      if (!pc.remoteDescription) link.pendingCandidates.push(candidate);
      else await pc.addIceCandidate(candidate);
    }
  }

  private async flushCandidates(link: PeerLink): Promise<void> {
    const pending = link.pendingCandidates.splice(0);
    for (const candidate of pending)
      await link.pc.addIceCandidate(candidate).catch(() => undefined);
  }

  /** A failed connection: the offerer restarts ICE once (a changed network gets new candidates); then it gives up. */
  private recover(peer: string, link: PeerLink): void {
    if (link.offerer && !link.restarted) {
      link.restarted = true;
      void this.offer(peer, link, true).catch(() => {
        this.drop(peer, true);
        this.host.failed(peer);
      });
      return;
    }
    this.drop(peer, true);
    this.host.failed(peer);
  }

  private drop(peer: string, tell: boolean): void {
    const link = this.links.get(peer);
    if (!link) return;
    this.links.delete(peer);
    link.audio?.stop();
    link.pc.onicecandidate = null;
    link.pc.ontrack = null;
    link.pc.onconnectionstatechange = null;
    link.pc.close();
    if (tell) this.host.send(peer, { kind: "close" });
    this.host.changed?.();
  }
}
