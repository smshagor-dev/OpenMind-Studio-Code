import type { SfuPublication, SfuRoom } from "./sfuTransport";

/**
 * A LiveKit room as an {@link SfuRoom}. The client library is loaded only when a classroom call starts (its own chunk of
 * the app's bundle — nothing is fetched from the network), and only audio is used: no video features (adaptive stream,
 * dynacast), no data, no camera or screen. Remote audio is played by the voice service's own sinks, never by elements
 * the library would create; the microphone track belongs to the voice service (LiveKit never stops it).
 */
/**
 * How long a lost media server connection is retried before the call ends with a voice problem. Measured: LiveKit's
 * default gave up after 10 attempts and 88 s, and six attempts still took 40 s (each waits on its own timeouts) — far
 * too long for someone talking to nobody. Retries stop once 12 s have passed; one attempt waits at most 5 s.
 */
export const RETRY_DELAYS_MS = [0, 300, 1200, 2700, 4800, 6000];
const RETRY_FOR_MS = 12_000;
const WEBSOCKET_TIMEOUT_MS = 5_000;

type LiveKit = typeof import("livekit-client");

/** Publishes the microphone (Opus with DTX and redundancy) and hands back mute/unmute/replace for it. */
async function publishMicrophone(
  lk: LiveKit,
  room: InstanceType<LiveKit["Room"]>,
  track: MediaStreamTrack,
): Promise<SfuPublication> {
  const publication = await room.localParticipant.publishTrack(track, {
    source: lk.Track.Source.Microphone,
    name: "microphone",
    dtx: true,
    red: true,
  });
  const local = publication.track;
  return {
    mute: async () => {
      await local?.mute();
    },
    unmute: async () => {
      await local?.unmute();
    },
    replace: async (next) => {
      await local?.replaceTrack(next, true);
    },
  };
}

export async function openLiveKitRoom(): Promise<SfuRoom> {
  const lk = await import("livekit-client");
  const { Room, RoomEvent, Track } = lk;
  const room = new Room({
    adaptiveStream: false,
    dynacast: false,
    stopLocalTrackOnUnpublish: false,
    disconnectOnPageLeave: true,
    reconnectPolicy: {
      nextRetryDelayInMs: (context) =>
        context.elapsedMs > RETRY_FOR_MS ? null : (RETRY_DELAYS_MS[context.retryCount] ?? null),
    },
  });
  let leaving = false;
  return {
    connect: (url, token) =>
      room.connect(url, token, { autoSubscribe: true, websocketTimeout: WEBSOCKET_TIMEOUT_MS }),
    disconnect: async () => {
      leaving = true;
      await room.disconnect(false);
    },
    publishMicrophone: (track) => publishMicrophone(lk, room, track),
    unpublish: async (track) => {
      await room.localParticipant.unpublishTrack(track, false);
    },
    remoteCount: () => room.remoteParticipants.size,
    onTrack: (listener) => {
      room.on(RoomEvent.TrackSubscribed, (track, publication) => {
        if (track.kind === Track.Kind.Audio)
          listener(publication.trackSid, new MediaStream([track.mediaStreamTrack]));
        else publication.setSubscribed(false); // never anything but audio
      });
    },
    onTrackGone: (listener) => {
      room.on(RoomEvent.TrackUnsubscribed, (_track, publication) => {
        listener(publication.trackSid);
      });
    },
    onDisconnected: (listener) => {
      room.on(RoomEvent.Disconnected, (reason) => {
        if (!leaving) listener(String(reason ?? "disconnected"));
      });
    },
    onMembersChanged: (listener) => {
      room.on(RoomEvent.ParticipantConnected, listener);
      room.on(RoomEvent.ParticipantDisconnected, listener);
    },
    onReconnecting: (listener) => {
      room.on(RoomEvent.Reconnecting, () => {
        listener(true);
      });
      room.on(RoomEvent.Reconnected, () => {
        listener(false);
      });
    },
    onPublishingChanged: (listener) => {
      room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
        if (!leaving && publication.source === Track.Source.Microphone) listener(true);
      });
      room.on(RoomEvent.ParticipantPermissionsChanged, (_previous, participant) => {
        if (!leaving && participant === room.localParticipant) listener(false);
      });
    },
  };
}
