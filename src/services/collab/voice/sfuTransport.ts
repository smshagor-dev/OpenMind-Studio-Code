import type { VoicePath } from "./voicePath";
import type { RemoteAudio, VoiceTransport } from "./voiceTransport";

/**
 * The part of a media-server room this transport uses (LiveKit's `Room`, adapted in `livekitRoom.ts`; a fake in tests).
 * Audio only: no camera, screen, data or video of any kind is published or subscribed.
 */
export interface SfuRoom {
  connect: (url: string, token: string) => Promise<void>;
  /** Leaves the media room; the microphone track stays the voice service's to stop. */
  disconnect: () => Promise<void>;
  /** Publishes the microphone (source "microphone"); resolves to a handle for mute and track replacement. */
  publishMicrophone: (track: MediaStreamTrack) => Promise<SfuPublication>;
  unpublish: (track: MediaStreamTrack) => Promise<void>;
  /** Members in the media room other than this one. */
  remoteCount: () => number;
  /** A remote audio track subscribed (`sid`: the track's id on the server), as a stream ready to play. */
  onTrack: (listener: (sid: string, stream: MediaStream) => void) => void;
  onTrackGone: (listener: (sid: string) => void) => void;
  /** The media server ended this connection (not this side's `disconnect`): server gone, removed, network lost. */
  onDisconnected: (listener: (reason: string) => void) => void;
  onMembersChanged: (listener: () => void) => void;
  /** The connection to the media server dropped and is being resumed (`true`), or is back (`false`). */
  onReconnecting: (listener: (reconnecting: boolean) => void) => void;
  /**
   * The server took this member's microphone away (moderation or a revoked permission: `gone`), or this member's
   * publishing permission changed (`gone` false). Either way, what is published must be checked again.
   */
  onPublishingChanged: (listener: (gone: boolean) => void) => void;
}

export interface SfuPublication {
  mute: () => Promise<void>;
  unmute: () => Promise<void>;
  replace: (track: MediaStreamTrack) => Promise<void>;
}

export interface SfuHost {
  url: string;
  token: string;
  openRoom: () => Promise<SfuRoom>;
  play: (peer: string, stream: MediaStream, deviceId: string) => RemoteAudio;
  /** The media server connection is gone for good (the call can't go on through it). */
  lost: (reason: string) => void;
  changed?: () => void;
}

/**
 * Classroom voice (Milestone 24, phase 11): this window's audio through a media server instead of a peer mesh. The
 * voice service (join, mute, devices, permissions, moderation, speaking, hands) is the same; only this changes. The
 * microphone is published at most once — a device change replaces the published track, mute mutes it, listen-only
 * publishes nothing —, every remote audio track gets exactly one playback sink (a re-subscription replaces it, never
 * adds one), and closing leaves the media room and stops every sink.
 */
export class LiveKitSfuVoiceTransport implements VoiceTransport {
  private room: SfuRoom | null = null;
  private connected = false;
  private closed = false;
  private wanted: MediaStreamTrack | null = null;
  private published: { track: MediaStreamTrack; handle: SfuPublication } | null = null;
  private muted = false;
  private outputDevice = "";
  private readonly audio = new Map<string, RemoteAudio>();
  /** Publishing/unpublishing runs one step at a time (no double publish). */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly host: SfuHost) {
    void this.start();
  }

  private async start(): Promise<void> {
    try {
      const room = await this.host.openRoom();
      if (this.closed) return;
      this.room = room;
      room.onTrack((sid, stream) => {
        this.audio.get(sid)?.stop();
        this.audio.set(sid, this.host.play(sid, stream, this.outputDevice));
        this.host.changed?.();
      });
      room.onTrackGone((sid) => {
        this.audio.get(sid)?.stop();
        this.audio.delete(sid);
        this.host.changed?.();
      });
      room.onMembersChanged(() => this.host.changed?.());
      room.onReconnecting((reconnecting) => {
        if (this.closed) return;
        // Not connected while resuming: the voice bar says it is connecting instead of claiming audio flows.
        this.connected = !reconnecting;
        this.host.changed?.();
        if (!reconnecting) this.sync();
      });
      room.onPublishingChanged((gone) => {
        // The server unpublished the microphone: that publication is dead (muting it again sends nothing). Publish
        // anew once allowed — refused while the permission is missing, retried when it comes back.
        if (gone) this.published = null;
        this.sync();
      });
      room.onDisconnected((reason) => {
        if (this.closed) return;
        this.connected = false;
        this.stopAudio();
        this.host.lost(reason);
      });
      await room.connect(this.host.url, this.host.token);
      if (this.isClosed()) {
        await room.disconnect();
        return;
      }
      this.connected = true;
      this.host.changed?.();
      this.sync();
    } catch (err) {
      if (!this.closed) this.host.lost(err instanceof Error ? err.message : String(err));
    }
  }

  setPeers(): void {
    // The media server decides who is in its room (the Owner removes anyone who leaves the call).
  }

  handleSignal(): void {
    // No peer-to-peer negotiation in classroom mode.
  }

  setLocalTrack(track: MediaStreamTrack | null): void {
    this.wanted = track;
    this.sync();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.queue = this.queue
      .then(async () => {
        if (!this.published) return;
        await (muted ? this.published.handle.mute() : this.published.handle.unmute());
      })
      .catch(() => undefined);
  }

  /** Brings what is published in line with the wanted microphone track. */
  private sync(): void {
    this.queue = this.queue
      .then(async () => {
        const room = this.room;
        if (!room || !this.connected || this.closed) return;
        const wanted = this.wanted;
        if (wanted === null && this.published) {
          await room.unpublish(this.published.track);
          this.published = null;
        } else if (wanted && this.published && this.published.track !== wanted) {
          await this.published.handle.replace(wanted);
          this.published = { track: wanted, handle: this.published.handle };
        } else if (wanted && !this.published) {
          const handle = await room.publishMicrophone(wanted);
          this.published = { track: wanted, handle };
          if (this.muted) await handle.mute();
        }
      })
      .catch(() => undefined);
  }

  setOutputDevice(deviceId: string): void {
    this.outputDevice = deviceId;
    for (const audio of this.audio.values()) audio.output(deviceId);
  }

  /** Read after an await (closing can happen meanwhile; a plain read is narrowed away by TypeScript). */
  private isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
    this.connected = false;
    this.stopAudio();
    const room = this.room;
    this.room = null;
    this.published = null;
    if (room) void room.disconnect().catch(() => undefined);
  }

  private stopAudio(): void {
    for (const audio of this.audio.values()) audio.stop();
    this.audio.clear();
  }

  /** One connection: to the media server. */
  connectionCount(): number {
    return this.closed ? 0 : 1;
  }

  connectedCount(): number {
    return this.connected ? 1 : 0;
  }

  /** Remote audio tracks playing now (tests and diagnostics). */
  playing(): number {
    return this.audio.size;
  }

  paths(): Promise<VoicePath[]> {
    return Promise.resolve([]);
  }
}
