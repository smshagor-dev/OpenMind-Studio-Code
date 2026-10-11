import { invoke } from "@tauri-apps/api/core";

import type { VoiceMode } from "./voiceIpc";

// Mirrors src-tauri/src/commands/collab/sfu (Milestone 24, phase 11): classroom voice on the room Owner's computer.

/** The classroom media server as the Owner's computer sees it (no key, secret or token). */
export interface ClassroomStatus {
  /** A classroom voice server can run on this computer (Windows x64 today); elsewhere only a configured one. */
  localSupported: boolean;
  /** The Runtime Manager has the classroom voice server installed. */
  installed: boolean;
  local: {
    running: boolean;
    bind: string | null;
    /** The address members connect to. */
    url: string | null;
    httpPort: number;
    udpPort: number;
  };
  /** A media server configured in Settings > Collaboration (address only). */
  externalUrl: string | null;
  externalHasSecret: boolean;
  /** This computer's addresses its own server can run on (LAN interfaces first, then loopback). */
  addresses: string[];
}

/** The media server's own view of a hosted room's call (no identities). */
export interface MediaRoomView {
  connected: number;
  mayPublish: number;
  publishingAudio: number;
}

export interface ClassroomIpc {
  status: () => Promise<ClassroomStatus>;
  startLocal: (bind: string | null) => Promise<void>;
  stopLocal: () => Promise<void>;
  setMode: (roomUid: string, mode: VoiceMode) => Promise<void>;
  /** Saves the configured media server's secret (encrypted on this computer; never read back). */
  setSecret: (secret: string) => Promise<void>;
  clearSecret: () => Promise<void>;
  mediaRoom: (roomUid: string) => Promise<MediaRoomView>;
}

export const tauriClassroomIpc: ClassroomIpc = {
  status: () => invoke("collab_classroom_status"),
  startLocal: (bind) => invoke("collab_classroom_local_start", { bind }),
  stopLocal: () => invoke("collab_classroom_local_stop"),
  setMode: (roomUid, mode) => invoke("collab_voice_mode_set", { roomUid, mode }),
  setSecret: (secret) => invoke("collab_classroom_secret_set", { secret }),
  clearSecret: () => invoke("collab_classroom_secret_clear"),
  mediaRoom: (roomUid) => invoke("collab_classroom_media_room", { roomUid }),
};
