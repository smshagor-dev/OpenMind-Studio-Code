import { t } from "../../../i18n";
import type { CollabNetIpc } from "../collabNetIpc";
import type { NetRooms } from "../presenceWiring";
import { tauriVoiceIpc, type VoiceIpc } from "./voiceIpc";
import { rms, type MediaApi } from "./voiceMedia";
import { VoiceService, type LevelMeter } from "./voiceService";
import { openLiveKitRoom } from "./livekitRoom";
import { LiveKitSfuVoiceTransport } from "./sfuTransport";
import { PeerMeshVoiceTransport, type RemoteAudio } from "./voiceTransport";

/** The WebView's media devices (nothing is asked until Join Voice calls `getUserMedia`). */
function browserMedia(): MediaApi {
  // Absent in an insecure context or a test environment, although the type says otherwise.
  const devices: MediaDevices | undefined =
    "mediaDevices" in navigator ? navigator.mediaDevices : undefined;
  const noMedia = () => Promise.reject(new DOMException("no media devices", "NotFoundError"));
  if (!devices)
    return {
      getUserMedia: noMedia,
      enumerateDevices: () => Promise.resolve([]),
      onDeviceChange: () => () => undefined,
    };
  return {
    getUserMedia: (constraints) => devices.getUserMedia(constraints),
    enumerateDevices: () => devices.enumerateDevices(),
    onDeviceChange: (listener) => {
      devices.addEventListener("devicechange", listener);
      return () => {
        devices.removeEventListener("devicechange", listener);
      };
    },
  };
}

type SinkAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };

/** Plays one remote member's audio through an element that is never in the page (no controls, nothing visible). */
function play(stream: MediaStream, deviceId: string): RemoteAudio {
  const audio = new Audio() as SinkAudio;
  audio.autoplay = true;
  audio.srcObject = stream;
  const output = (id: string) => {
    if (typeof audio.setSinkId === "function") void audio.setSinkId(id).catch(() => undefined);
  };
  if (deviceId) output(deviceId);
  void audio.play().catch(() => undefined);
  return {
    stop: () => {
      audio.pause();
      audio.srcObject = null;
    },
    output,
  };
}

/** The microphone's level, computed in this window with Web Audio (never sent anywhere). */
function meter(stream: MediaStream): LevelMeter {
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  return {
    level: () => {
      analyser.getByteTimeDomainData(samples);
      return rms(samples);
    },
    stop: () => {
      source.disconnect();
      void context.close().catch(() => undefined);
    },
  };
}

/** Whether remote audio can be sent to a chosen output device here (`setSinkId`). */
export function outputSelectable(): boolean {
  return typeof (HTMLMediaElement.prototype as SinkAudio).setSinkId === "function";
}

export function wireVoice(deps: {
  netIpc: CollabNetIpc;
  rooms: NetRooms;
  notice: (message: string) => void;
  ipc?: VoiceIpc;
}): { voice: VoiceService; start: () => Promise<() => void> } {
  const ipc = deps.ipc ?? tauriVoiceIpc;
  // `voice` is read only by callbacks that run after it exists.
  const voice: VoiceService = new VoiceService({
    ipc,
    media: browserMedia(),
    createTransport: (roomUid, me, media) =>
      media.kind === "sfu"
        ? new LiveKitSfuVoiceTransport({
            url: media.url,
            token: media.token,
            openRoom: openLiveKitRoom,
            play: (_peer, stream, deviceId) => play(stream, deviceId),
            lost: () => {
              voice.transportLost();
            },
            changed: () => {
              voice.transportChanged();
            },
          })
        : new PeerMeshVoiceTransport({
            me,
            ice: media,
            send: (to, signal) => void ipc.signal(roomUid, to, signal).catch(() => undefined),
            createConnection: (config) => new RTCPeerConnection(config),
            play: (_peer, stream, deviceId) => play(stream, deviceId),
            failed: () => {
              deps.notice(t("voice.notice.peerFailed"));
            },
            changed: () => {
              voice.transportChanged();
            },
          }),
    meter,
    notice: (key) => {
      deps.notice(t(key));
    },
    every: (run, ms) => {
      const timer = setInterval(run, ms);
      return () => {
        clearInterval(timer);
      };
    },
  });
  const loaded = new Set<string>();
  const start = async (): Promise<() => void> => {
    const stops = [
      await voice.start(),
      deps.rooms.subscribe(() => {
        const { hosting, joined } = deps.rooms.status;
        const active = voice.state().roomUid;
        if (active !== null && !hosting.includes(active) && !joined.includes(active))
          voice.roomGone(active);
        for (const room of loaded)
          if (!hosting.includes(room) && !joined.includes(room)) loaded.delete(room);
        for (const room of [...hosting, ...joined]) {
          if (loaded.has(room)) continue;
          loaded.add(room);
          void voice.load(room).catch(() => loaded.delete(room));
        }
      }),
      await deps.netIpc.onNet((payload) => {
        // A fresh session to a joined room: its call is negotiated again.
        if (payload.side === "participant" && payload.event.kind === "route") {
          loaded.delete(payload.roomUid);
          void voice.reconnected(payload.roomUid);
        }
      }),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  };
  return { voice, start };
}
