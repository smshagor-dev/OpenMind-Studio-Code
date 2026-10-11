import { describe, expect, it, vi } from "vitest";

import { LiveKitSfuVoiceTransport, type SfuPublication, type SfuRoom } from "./sfuTransport";

function track(id: string): MediaStreamTrack {
  return { id, kind: "audio", enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack;
}

class FakeRoom implements SfuRoom {
  connected: [string, string] | null = null;
  published: MediaStreamTrack[] = [];
  replaced: MediaStreamTrack[] = [];
  unpublished: MediaStreamTrack[] = [];
  mutes: boolean[] = [];
  left = false;
  members = 0;
  private trackListener: (sid: string, s: MediaStream) => void = () => undefined;
  private goneListener: (sid: string) => void = () => undefined;
  private lostListener: (reason: string) => void = () => undefined;
  private publishingListener: (gone: boolean) => void = () => undefined;
  denied = false;
  constructor(private readonly failConnect = false) {}
  connect = (url: string, token: string) => {
    if (this.failConnect) return Promise.reject(new Error("could not establish signal connection"));
    this.connected = [url, token];
    return Promise.resolve();
  };
  disconnect = () => {
    this.left = true;
    return Promise.resolve();
  };
  publishMicrophone = (t: MediaStreamTrack): Promise<SfuPublication> => {
    if (this.denied) return Promise.reject(new Error("insufficient permissions"));
    this.published.push(t);
    return Promise.resolve({
      mute: () => {
        this.mutes.push(true);
        return Promise.resolve();
      },
      unmute: () => {
        this.mutes.push(false);
        return Promise.resolve();
      },
      replace: (next) => {
        this.replaced.push(next);
        return Promise.resolve();
      },
    });
  };
  unpublish = (t: MediaStreamTrack) => {
    this.unpublished.push(t);
    return Promise.resolve();
  };
  remoteCount = () => this.members;
  onTrack = (l: (sid: string, s: MediaStream) => void) => {
    this.trackListener = l;
  };
  onTrackGone = (l: (sid: string) => void) => {
    this.goneListener = l;
  };
  onDisconnected = (l: (reason: string) => void) => {
    this.lostListener = l;
  };
  onMembersChanged = () => undefined;
  private reconnectListener: (r: boolean) => void = () => undefined;
  onReconnecting = (l: (r: boolean) => void) => {
    this.reconnectListener = l;
  };
  resuming(r: boolean) {
    this.reconnectListener(r);
  }
  onPublishingChanged = (l: (gone: boolean) => void) => {
    this.publishingListener = l;
  };
  /** Moderation on the server: the microphone is unpublished and publishing is refused until allowed again. */
  revoke() {
    this.denied = true;
    this.publishingListener(true);
  }
  allow() {
    this.denied = false;
    this.publishingListener(false);
  }
  remoteTrack(sid: string) {
    this.trackListener(sid, { id: `stream-${sid}` } as unknown as MediaStream);
  }
  remoteGone(sid: string) {
    this.goneListener(sid);
  }
  serverDrops() {
    this.lostListener("SERVER_SHUTDOWN");
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(room = new FakeRoom()) {
  const sinks: { stop: ReturnType<typeof vi.fn>; output: ReturnType<typeof vi.fn> }[] = [];
  const lost = vi.fn();
  const t = new LiveKitSfuVoiceTransport({
    url: "ws://192.168.1.20:7880",
    token: "member-token",
    openRoom: () => Promise.resolve(room),
    play: vi.fn(() => {
      const sink = { stop: vi.fn(), output: vi.fn() };
      sinks.push(sink);
      return sink;
    }),
    lost,
  });
  return { t, room, sinks, lost };
}

describe("the classroom voice transport", () => {
  it("connects with the Owner's grant and publishes the microphone once, replacing it on a device change", async () => {
    const { t, room } = setup();
    const mic = track("mic-1");
    t.setLocalTrack(mic);
    t.setLocalTrack(mic);
    await flush();
    await flush();
    expect(room.connected).toEqual(["ws://192.168.1.20:7880", "member-token"]);
    expect(room.published).toEqual([mic]);
    expect(t.connectedCount()).toBe(1);
    // Another microphone: the published track is replaced, never published a second time.
    const usb = track("mic-2");
    t.setLocalTrack(usb);
    await flush();
    expect(room.published).toHaveLength(1);
    expect(room.replaced).toEqual([usb]);
    // Losing the microphone (or leaving speaking) unpublishes it.
    t.setLocalTrack(null);
    await flush();
    expect(room.unpublished).toEqual([usb]);
  });

  it("mutes the publication itself and publishes nothing for a listener", async () => {
    const { t, room } = setup();
    await flush();
    expect(room.published).toEqual([]); // listen-only: no track was ever given
    t.setLocalTrack(track("mic"));
    await flush();
    t.setMuted(true);
    t.setMuted(false);
    await flush();
    expect(room.mutes).toEqual([true, false]);
  });

  it("plays one sink per remote audio track, never two for the same track", async () => {
    const { t, room, sinks } = setup();
    await flush();
    room.remoteTrack("TR_a");
    room.remoteTrack("TR_b");
    expect(t.playing()).toBe(2);
    // The same track subscribed again (after a reconnect): the old sink stops, one remains.
    room.remoteTrack("TR_a");
    expect(sinks[0]?.stop).toHaveBeenCalled();
    expect(t.playing()).toBe(2);
    room.remoteGone("TR_b");
    expect(t.playing()).toBe(1);
    t.setOutputDevice("speakers-2");
    expect(sinks[2]?.output).toHaveBeenCalledWith("speakers-2");
  });

  it("reports a lost media server and stops every sink; leaving is not a loss", async () => {
    const { t, room, sinks, lost } = setup();
    await flush();
    room.remoteTrack("TR_a");
    room.serverDrops();
    expect(lost).toHaveBeenCalledWith("SERVER_SHUTDOWN");
    expect(sinks[0]?.stop).toHaveBeenCalled();
    expect(t.connectedCount()).toBe(0);

    const other = setup();
    await flush();
    other.t.close();
    other.room.serverDrops();
    expect(other.lost).not.toHaveBeenCalled();
    expect(other.room.left).toBe(true);
    expect(other.t.connectionCount()).toBe(0);
  });

  it("a server that can't be reached ends the call with a voice problem, and a close before connecting still leaves", async () => {
    const failing = setup(new FakeRoom(true));
    await flush();
    expect(failing.lost).toHaveBeenCalled();
    let resolveOpen: (room: SfuRoom) => void = () => undefined;
    const room = new FakeRoom();
    const t = new LiveKitSfuVoiceTransport({
      url: "ws://x",
      token: "t",
      openRoom: () =>
        new Promise((r) => {
          resolveOpen = r;
        }),
      play: vi.fn(),
      lost: vi.fn(),
    });
    t.close();
    resolveOpen(room);
    await flush();
    expect(room.connected).toBeNull();
  });

  it("publishes again after the server took the microphone away and allowed it back", async () => {
    const { t, room } = setup();
    const mic = track("mic");
    t.setLocalTrack(mic);
    await flush();
    await flush();
    expect(room.published).toEqual([mic]);
    // A moderator mutes: the server unpublishes; a retry while refused publishes nothing.
    room.revoke();
    await flush();
    expect(room.published).toEqual([mic]);
    // Allowed again: the same microphone is published anew (not the dead publication un-muted).
    room.allow();
    await flush();
    await flush();
    expect(room.published).toEqual([mic, mic]);
    expect(room.mutes).toEqual([]);
  });

  it("is not connected while the media server connection is being resumed", async () => {
    const { t, room, lost } = setup();
    await flush();
    expect(t.connectedCount()).toBe(1);
    room.resuming(true);
    expect(t.connectedCount()).toBe(0);
    room.resuming(false);
    expect(t.connectedCount()).toBe(1);
    expect(lost).not.toHaveBeenCalled();
  });
});
