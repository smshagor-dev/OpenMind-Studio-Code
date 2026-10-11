import { PresenceService } from "../services/collab/presenceService";
import { VoiceService } from "../services/collab/voice/voiceService";

/** A voice service with no call and no media (nothing is ever asked of a microphone). */
export function voiceStub(): VoiceService {
  return new VoiceService({
    ipc: {
      setState: () => Promise.resolve(),
      signal: () => Promise.resolve(),
      snapshot: () => Promise.resolve({ me: "me", members: [], capacity: 6, mode: "p2p" }),
      media: () => Promise.resolve({ kind: "p2p", iceServers: [], iceTransportPolicy: "all" }),
      onVoice: () => Promise.resolve(() => undefined),
    },
    media: {
      getUserMedia: () => Promise.reject(new DOMException("no media", "NotFoundError")),
      enumerateDevices: () => Promise.resolve([]),
      onDeviceChange: () => () => undefined,
    },
    createTransport: () => ({
      setPeers: () => undefined,
      setLocalTrack: () => undefined,
      handleSignal: () => undefined,
      setOutputDevice: () => undefined,
      close: () => undefined,
      connectionCount: () => 0,
      connectedCount: () => 0,
      paths: () => Promise.resolve([]),
    }),
    meter: () => ({ level: () => 0, stop: () => undefined }),
    notice: () => undefined,
    every: () => () => undefined,
  });
}

/** An empty collaboration side for component tests that mock the container (nobody else is in any file). */
export function collabStub(): { presence: PresenceService; voice: VoiceService } {
  return {
    presence: new PresenceService({
      set: () => Promise.resolve(),
      snapshot: () => Promise.reject(new Error("no room")),
      onPresence: () => Promise.resolve(() => undefined),
    }),
    voice: voiceStub(),
  };
}
