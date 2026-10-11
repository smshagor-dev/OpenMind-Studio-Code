import { errorText } from "../roomIpc";
import type {
  VoiceEventPayload,
  VoiceIpc,
  VoiceMedia,
  VoiceMember,
  VoiceMode,
  VoiceSelf,
} from "./voiceIpc";
import { VOICE_CAPACITY } from "./voiceIpc";
import {
  listDevices,
  micProblem,
  openMicrophone,
  SpeakingDetector,
  type AudioDevice,
  type MediaApi,
  type MicProblem,
} from "./voiceMedia";
import type { VoicePath } from "./voicePath";
import type { VoiceTransport } from "./voiceTransport";

/** How often the local microphone level is sampled (in this window only; levels never leave it). */
export const LEVEL_EVERY_MS = 100;
/** Speaking changes are told to the room at most this often. */
export const SPEAKING_EVERY_MS = 300;

export type VoicePhase = "idle" | "joining" | "joined" | "reconnecting";

/** Why voice can't do what was asked (the UI explains it; raw text only as `detail`). */
export type VoiceProblem =
  | MicProblem
  | "notAllowed"
  /** Taken out of the call by the room (moderation, a lost permission, hosting stopped). */
  | "removed"
  | "full"
  | "elsewhere"
  | "refused"
  /** Classroom mode: no media server is running or configured on the Owner's computer. */
  | "classroomUnavailable"
  /** Classroom mode: the connection to the media server was lost (the room itself is fine). */
  | "classroomLost";

export interface VoiceView {
  roomUid: string | null;
  phase: VoicePhase;
  muted: boolean;
  handRaised: boolean;
  speaking: boolean;
  /** "ok": a microphone is open; "none": listen-only (no permission to speak yet); else why it couldn't open. */
  mic: "ok" | "none" | MicProblem;
  problem: VoiceProblem | null;
  detail: string | null;
  inputs: AudioDevice[];
  outputs: AudioDevice[];
  inputId: string;
  outputId: string;
  /** Members this window should exchange audio with, and those whose audio path is up. */
  audioPeers: number;
  audioConnected: number;
}

export interface LevelMeter {
  level: () => number;
  stop: () => void;
}

export interface VoiceHost {
  ipc: VoiceIpc;
  media: MediaApi;
  createTransport: (roomUid: string, me: string, media: VoiceMedia) => VoiceTransport;
  meter: (stream: MediaStream) => LevelMeter;
  notice: (key: string) => void;
  every: (run: () => void, ms: number) => () => void;
}

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

function problemOf(reason: string): VoiceProblem {
  if (reason.includes("media server")) return "classroomUnavailable";
  if (reason.includes("full")) return "full";
  if (reason.includes("voice.join")) return "notAllowed";
  if (reason.includes("another window")) return "elsewhere";
  return "refused";
}

/**
 * This window's voice (Milestone 24, phase 9): at most one call at a time. The microphone opens only after Join Voice
 * and only for a member allowed to speak; the room's Owner decides every join, unmute and leave (a refusal changes
 * nothing here). Audio goes through a {@link VoiceTransport}; mute only disables the sent track. What the Owner says
 * about this member wins: removed from the call, muted by a moderator or by a lost permission — the track stops at once.
 * Calls in every room are shown from the Owner's rosters (`roster`), whichever window holds them.
 */
export class VoiceService {
  private view: VoiceView = IDLE;
  private rosters = new Map<string, VoiceMember[]>();
  /** Each room's voice mode and capacity, as its Owner last said. */
  private modes = new Map<string, { mode: VoiceMode; capacity: number }>();
  /** Roster events per room: a snapshot read that started before a newer event must not overwrite it. */
  private rosterEvents = new Map<string, number>();
  private me: string | null = null;
  private transport: VoiceTransport | null = null;
  private stream: MediaStream | null = null;
  private meter: LevelMeter | null = null;
  private stopSampling: (() => void) | null = null;
  private detector = new SpeakingDetector();
  /** A roster has listed this member since it (re)joined: from then on, missing from one means removed. */
  private confirmed = false;
  private lastSpeakingSent = 0;
  private listeners = new Set<() => void>();
  private version = 0;
  private stopDevices: (() => void) | null = null;

  constructor(private readonly host: VoiceHost) {}

  async start(): Promise<() => void> {
    const stop = await this.host.ipc.onVoice((payload) => {
      this.onEvent(payload);
    });
    this.stopDevices = this.host.media.onDeviceChange(() => void this.devicesChanged());
    return () => {
      stop();
      this.stopDevices?.();
      this.teardown();
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getVersion(): number {
    return this.version;
  }

  state(): VoiceView {
    return this.view;
  }

  /** The transport's connections changed. */
  transportChanged(): void {
    const t = this.transport;
    this.set({ audioPeers: t?.connectionCount() ?? 0, audioConnected: t?.connectedCount() ?? 0 });
  }

  /** How `roomUid`'s call carries media and how many it takes (peer to peer, 6, until the Owner says otherwise). */
  modeOf(roomUid: string): { mode: VoiceMode; capacity: number } {
    return this.modes.get(roomUid) ?? { mode: "p2p", capacity: VOICE_CAPACITY.p2p };
  }

  /**
   * The classroom media server connection was lost (the media server stopped, the network to it failed): the call ends
   * here and the microphone is released; the room connection and code collaboration are untouched.
   */
  transportLost(): void {
    const room = this.view.roomUid;
    if (room === null || this.view.phase === "idle") return;
    this.teardown();
    this.set({
      ...IDLE,
      problem: "classroomLost",
      inputId: this.view.inputId,
      outputId: this.view.outputId,
    });
    void this.host.ipc.setState(room, IDLE_SELF).catch(() => undefined);
  }

  /** Who is in `roomUid`'s call, as its Owner last said. */
  roster(roomUid: string): VoiceMember[] {
    return this.rosters.get(roomUid) ?? [];
  }

  /** Reads a room's call (a window that opens while one is going on). */
  async load(roomUid: string): Promise<void> {
    const seen = this.rosterEvents.get(roomUid) ?? 0;
    const snapshot = await this.host.ipc.snapshot(roomUid);
    this.me = snapshot.me;
    if ((this.rosterEvents.get(roomUid) ?? 0) === seen) {
      this.rosters.set(roomUid, snapshot.members);
      this.modes.set(roomUid, { mode: snapshot.mode, capacity: snapshot.capacity });
    }
    this.changed();
  }

  /**
   * Join Voice. `canJoin`/`canSpeak` are this member's permissions as the backend reported them; without `voice.join`
   * nothing happens (no microphone prompt). Listen-only members join without opening the microphone.
   */
  async join(roomUid: string, canJoin: boolean, canSpeak: boolean): Promise<void> {
    if (!canJoin) {
      this.set({ problem: "notAllowed", detail: null });
      return;
    }
    if (this.view.roomUid !== null && this.view.roomUid !== roomUid) await this.leave();
    this.set({
      ...IDLE,
      roomUid,
      phase: "joining",
      inputId: this.view.inputId,
      outputId: this.view.outputId,
    });
    let accepted = false;
    try {
      const snapshot = await this.host.ipc.snapshot(roomUid);
      this.me = snapshot.me;
      this.modes.set(roomUid, { mode: snapshot.mode, capacity: snapshot.capacity });
      this.confirmed = false;
      await this.host.ipc.setState(roomUid, this.self({ muted: true }));
      accepted = true;
      // Asked only now: how to carry media (peer-to-peer ICE with any TURN login, or a classroom media token) is given
      // to the window that holds the call, after the Owner accepted the join.
      const media = await this.host.ipc.media(roomUid);
      this.transport = this.host.createTransport(roomUid, snapshot.me, media);
      this.set({ phase: "joined" });
      this.applyRoster(this.rosters.get(roomUid) ?? snapshot.members);
      if (canSpeak) await this.unmute();
      await this.refreshDevices();
    } catch (err) {
      const detail = errorText(err);
      this.teardown();
      // In the call already (the media server couldn't be used): leave it, so the roster doesn't keep a silent member.
      if (accepted) void this.host.ipc.setState(roomUid, IDLE_SELF).catch(() => undefined);
      this.set({
        ...IDLE,
        problem: problemOf(detail),
        detail,
        inputId: this.view.inputId,
        outputId: this.view.outputId,
      });
    }
  }

  /** The kinds of path the call's audio takes now (diagnostics; no address). */
  paths(): Promise<VoicePath[]> {
    return this.transport?.paths() ?? Promise.resolve([]);
  }

  /** Leave Voice: the room connection stays; only the call ends. */
  async leave(): Promise<void> {
    const room = this.view.roomUid;
    this.teardown();
    this.set({ ...IDLE, inputId: this.view.inputId, outputId: this.view.outputId });
    if (room !== null) await this.host.ipc.setState(room, IDLE_SELF).catch(() => undefined);
  }

  async toggleMute(): Promise<void> {
    if (this.view.phase !== "joined") return;
    if (this.view.muted) await this.unmute();
    else await this.mute();
  }

  async setHand(raised: boolean): Promise<void> {
    const room = this.view.roomUid;
    if (room === null || this.view.phase !== "joined") return;
    try {
      await this.host.ipc.setState(room, this.self({ handRaised: raised }));
      this.set({ handRaised: raised });
    } catch (err) {
      this.refused(err);
    }
  }

  /** Another microphone: the sent track is replaced (no renegotiation); a vanished device falls back to the default. */
  async selectInput(deviceId: string): Promise<void> {
    this.set({ inputId: deviceId });
    if (!this.stream) return;
    await this.openMic(deviceId);
  }

  selectOutput(deviceId: string): void {
    this.set({ outputId: deviceId });
    this.transport?.setOutputDevice(deviceId);
  }

  /**
   * The room isn't on the network for this computer any more (closed, left, kicked, hosting stopped): the call ends here
   * and the microphone is released (a later Join Voice starts afresh).
   */
  roomGone(roomUid: string): void {
    this.rosters.delete(roomUid);
    if (this.view.roomUid !== roomUid) {
      this.changed();
      return;
    }
    this.teardown();
    this.set({ ...IDLE, inputId: this.view.inputId, outputId: this.view.outputId });
  }

  /** The room is reachable again on a new session: the call is negotiated afresh (nothing stale is reused). */
  async reconnected(roomUid: string): Promise<void> {
    if (this.view.roomUid !== roomUid || this.view.phase !== "reconnecting") return;
    const room = roomUid;
    let accepted = false;
    try {
      const snapshot = await this.host.ipc.snapshot(room);
      this.confirmed = false;
      await this.host.ipc.setState(room, this.self({}));
      accepted = true;
      const media = await this.host.ipc.media(room);
      this.transport = this.host.createTransport(room, snapshot.me, media);
      this.transport.setLocalTrack(this.track());
      this.set({ phase: "joined" });
      this.applyRoster(this.rosters.get(room) ?? snapshot.members);
    } catch (err) {
      // Refused on the new session (a right removed meanwhile, the call full, no media server): the call is over here,
      // and the microphone kept open for the reconnect is released — never left waiting in "reconnecting".
      const detail = errorText(err);
      this.teardown();
      if (accepted) void this.host.ipc.setState(room, IDLE_SELF).catch(() => undefined);
      this.set({
        ...IDLE,
        problem: problemOf(detail),
        detail,
        inputId: this.view.inputId,
        outputId: this.view.outputId,
      });
    }
  }

  private async unmute(): Promise<void> {
    const room = this.view.roomUid;
    if (room === null) return;
    if (!this.stream && !(await this.openMic(this.view.inputId))) return;
    try {
      // The Owner allows it first; only then does audio leave this computer.
      await this.host.ipc.setState(room, this.self({ muted: false }));
      const track = this.track();
      if (track) track.enabled = true;
      this.transport?.setMuted?.(false);
      this.set({ muted: false, problem: null, detail: null });
    } catch (err) {
      this.refused(err);
    }
  }

  private async mute(): Promise<void> {
    const room = this.view.roomUid;
    this.silence();
    if (room !== null)
      await this.host.ipc
        .setState(room, this.self({ muted: true, speaking: false }))
        .catch(() => undefined);
  }

  /** Stops sending at once (local mute, a moderator's mute, a lost permission). */
  private silence(): void {
    const track = this.track();
    if (track) track.enabled = false;
    this.transport?.setMuted?.(true);
    this.detector.reset();
    this.set({ muted: true, speaking: false });
  }

  /** Opens (or reopens) the microphone; on failure the member stays in the call, listen-only, and is told why. */
  private async openMic(deviceId: string): Promise<boolean> {
    try {
      const { stream, fellBack } = await openMicrophone(this.host.media, deviceId);
      const track = stream.getAudioTracks()[0] ?? null;
      if (track) track.enabled = !this.view.muted;
      this.releaseMic();
      this.stream = stream;
      this.transport?.setLocalTrack(track);
      this.startSampling(stream);
      if (fellBack) this.host.notice("voice.notice.deviceFallback");
      this.set({ mic: "ok", inputId: fellBack ? "" : deviceId });
      await this.refreshDevices();
      return true;
    } catch (err) {
      this.set({ mic: micProblem(err), problem: micProblem(err), detail: errorText(err) });
      return false;
    }
  }

  private startSampling(stream: MediaStream): void {
    this.stopSampling?.();
    this.meter?.stop();
    this.meter = this.host.meter(stream);
    this.stopSampling = this.host.every(() => {
      this.sample();
    }, LEVEL_EVERY_MS);
  }

  private sample(): void {
    if (!this.meter || this.view.muted || this.view.phase !== "joined") return;
    const change = this.detector.push(this.meter.level());
    if (change === null) return;
    this.set({ speaking: change });
    const now = Date.now();
    if (now - this.lastSpeakingSent < SPEAKING_EVERY_MS && change) return;
    this.lastSpeakingSent = now;
    const room = this.view.roomUid;
    if (room !== null)
      void this.host.ipc.setState(room, this.self({ speaking: change })).catch(() => undefined);
  }

  private onEvent({ roomUid, event }: VoiceEventPayload): void {
    if (event.kind === "roster") {
      this.rosterEvents.set(roomUid, (this.rosterEvents.get(roomUid) ?? 0) + 1);
      this.rosters.set(roomUid, event.members);
      this.modes.set(roomUid, { mode: event.mode, capacity: VOICE_CAPACITY[event.mode] });
      if (roomUid === this.view.roomUid) this.applyRoster(event.members);
      this.changed();
    } else if (event.kind === "signal") {
      if (roomUid === this.view.roomUid) this.transport?.handleSignal(event.from, event.signal);
    } else {
      this.rosters.delete(roomUid);
      if (roomUid === this.view.roomUid && this.view.phase !== "idle") {
        // The room connection dropped: the media connections go with it; a new session renegotiates.
        this.transport?.close();
        this.transport = null;
        this.set({ phase: "reconnecting", speaking: false });
      }
      this.changed();
    }
  }

  /** The Owner's word on this member wins: out of the call, muted by a moderator or a lost permission. */
  private applyRoster(members: VoiceMember[]): void {
    if (this.view.phase !== "joined") return;
    const mine = members.find((m) => m.peer === this.me);
    if (!mine && !this.confirmed) {
      // Not listed yet (the roster naming this member is still on its way): connect to the others meanwhile.
      this.transport?.setPeers(members.map((m) => m.peer));
      return;
    }
    if (!mine) {
      this.teardown();
      this.set({
        ...IDLE,
        inputId: this.view.inputId,
        outputId: this.view.outputId,
        problem: "removed",
      });
      this.host.notice("voice.notice.removed");
      return;
    }
    this.confirmed = true;
    if (mine.muted && !this.view.muted) {
      this.silence();
      this.host.notice(mine.forceMuted ? "voice.notice.forceMuted" : "voice.notice.speakRevoked");
    }
    this.set({ handRaised: mine.handRaised });
    this.transport?.setPeers(members.map((m) => m.peer));
    this.transportChanged();
  }

  private async devicesChanged(): Promise<void> {
    const before = this.view.inputId;
    await this.refreshDevices();
    if (before && !this.view.inputs.some((d) => d.id === before)) {
      this.host.notice("voice.notice.deviceGone");
      this.set({ inputId: "" });
      if (this.stream) await this.openMic("");
    }
  }

  private async refreshDevices(): Promise<void> {
    const { inputs, outputs } = await listDevices(this.host.media);
    this.set({ inputs, outputs });
  }

  private self(change: Partial<VoiceSelf>): VoiceSelf {
    return {
      joined: true,
      muted: this.view.muted,
      speaking: this.view.speaking,
      handRaised: this.view.handRaised,
      ...change,
    };
  }

  private refused(err: unknown): void {
    const detail = errorText(err);
    this.set({ problem: problemOf(detail), detail });
  }

  private track(): MediaStreamTrack | null {
    return this.stream?.getAudioTracks()[0] ?? null;
  }

  private releaseMic(): void {
    this.stopSampling?.();
    this.stopSampling = null;
    this.meter?.stop();
    this.meter = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
  }

  /** Ends everything this window holds for the call: connections, audio sinks, the microphone. */
  private teardown(): void {
    this.transport?.close();
    this.transport = null;
    this.releaseMic();
    this.detector.reset();
  }

  private set(change: Partial<VoiceView>): void {
    this.view = { ...this.view, ...change };
    this.changed();
  }

  private changed(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }
}

const IDLE_SELF: VoiceSelf = { joined: false, muted: true, speaking: false, handRaised: false };
