import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// Mirrors crates/collab/src/voice.rs and src-tauri/src/commands/collab/net_voice.rs (Milestone 24, phase 9). Only the
// call's state and WebRTC negotiation cross here; audio never does (it flows between the WebViews' own connections).

/** What this member says about its own voice. */
export interface VoiceSelf {
  joined: boolean;
  muted: boolean;
  speaking: boolean;
  handRaised: boolean;
}

/** A member of the call as the Owner tells the room (moderation and permissions from the room). */
export interface VoiceMember {
  peer: string;
  muted: boolean;
  speaking: boolean;
  handRaised: boolean;
  forceMuted: boolean;
  canSpeak: boolean;
}

export type VoiceSignal =
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | { kind: "candidate"; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  | { kind: "close" };

/** How a room's call carries media: peer to peer (small calls) or classroom (through a media server). */
export type VoiceMode = "p2p" | "sfu";

/** The most people a call takes in each mode (mirrors `MAX_VOICE_MEMBERS` / `MAX_SFU_VOICE_MEMBERS` in Rust). */
export const VOICE_CAPACITY: Record<VoiceMode, number> = { p2p: 6, sfu: 60 };

export type VoiceNotice =
  | { kind: "roster"; members: VoiceMember[]; mode: VoiceMode }
  | { kind: "signal"; from: string; signal: VoiceSignal }
  | { kind: "reset" };

export interface VoiceEventPayload {
  roomUid: string;
  side: "host" | "participant";
  event: VoiceNotice;
}

export interface VoiceSnapshot {
  me: string;
  members: VoiceMember[];
  /** The most people the call takes in its mode. */
  capacity: number;
  mode: VoiceMode;
}

/**
 * How this window's peer-to-peer call builds its connections (`collab_voice_media`, only to the window holding the call):
 * no server on the local network; the STUN and TURN servers otherwise, TURN with its login. Kept only inside the
 * connections — never stored in view state or logged.
 */
export interface VoiceIce {
  iceServers: RTCIceServer[];
  /** `relay` only in debug builds' relay-only test mode. */
  iceTransportPolicy: RTCIceTransportPolicy;
}

/**
 * How this window's call carries media (`collab_voice_media`, answered only to the window holding the call): peer to
 * peer with the ICE configuration, or classroom with the media server's address and a token for this member only
 * (minted by the room's Owner, valid two minutes). Kept only inside the transport — never in view state or a log.
 */
export type VoiceMedia =
  ({ kind: "p2p" } & VoiceIce) | { kind: "sfu"; url: string; token: string; expiresMs: number };

export interface VoiceIpc {
  /** Join, leave, mute, speaking, hand — the Owner decides (a refusal rejects with its reason). */
  setState: (roomUid: string, voice: VoiceSelf) => Promise<void>;
  signal: (roomUid: string, to: string, signal: VoiceSignal) => Promise<void>;
  snapshot: (roomUid: string) => Promise<VoiceSnapshot>;
  media: (roomUid: string) => Promise<VoiceMedia>;
  onVoice: (listener: (payload: VoiceEventPayload) => void) => Promise<UnlistenFn>;
}

export const VOICE_EVENT = "collab:voice";

export const tauriVoiceIpc: VoiceIpc = {
  setState: (roomUid, voice) => invoke("collab_voice_state", { roomUid, voice }),
  signal: (roomUid, to, signal) => invoke("collab_voice_signal", { roomUid, to, signal }),
  snapshot: (roomUid) => invoke("collab_voice_snapshot", { roomUid }),
  media: (roomUid) => invoke("collab_voice_media", { roomUid }),
  onVoice: (listener) =>
    listen<VoiceEventPayload>(VOICE_EVENT, (event) => {
      listener(event.payload);
    }),
};
