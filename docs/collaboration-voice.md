# Voice in collaboration rooms (Milestone 24, phase 9)

Small-room voice for meetings, pair coding and small groups: Join / Leave Voice, mute, microphone and speaker choice,
speaking and active-speaker indication, raised hands, moderator force mute, live voice permissions. Code collaboration
never depends on it: a voice problem can't block edits, file sync or room control.

## Architecture

```text
WebView (each member)                          Rust (each computer)
 ├─ getUserMedia (after Join Voice only)        ├─ membership, roles, permissions (Owner authority)
 ├─ RTCPeerConnection per other member  ◄──────┤─ voice state + negotiation, authorized and relayed by the Owner
 └─ remote audio playback                       └─ audit (joined / left / force mute)
        ▲
        └── media flows directly between WebViews (never through Rust, the Owner, Yjs, SQLite or the file channel)
```

- **Media**: WebView WebRTC (`getUserMedia`, `RTCPeerConnection`, Opus). No audio is captured, buffered, recorded or
  transcribed in Rust; nothing is uploaded anywhere.
- **Signaling**: the room's existing authenticated control channel. `VoiceState` (join, leave, mute, speaking, hand) and
  `VoiceSignal` (offer, answer, ICE candidate, close) go to the Owner; the Owner checks the sender's **current session**,
  that it is an **active member**, its **permissions** (`voice.join`, `voice.speak`, not force-muted), that **both ends are
  in the call**, the **sizes** (SDP ≤ 32 KB, candidate ≤ 1 KB) and a **per-connection voice budget** (burst 80, 20/s,
  separate from code and presence traffic), then relays negotiation as `VoicePeerSignal { from }` naming the authenticated
  sender, and the call as `VoiceRoster`. A member can't reach anyone outside the room or the call.
- **State** (`openmind_collab::voice::VoiceBoard`, Owner memory only): who is in the call, muted, speaking, hand raised.
  Moderation (`force_muted`) and permissions come from the authoritative room state, never from what a member reports;
  `enforce` mutes or removes members the moment a permission, role or moderation changes.
- **Separate stacks on purpose**: the collaboration transport (`str0m` data channels) and voice media (WebView WebRTC)
  share only the room identity, membership and the control channel; they don't share congestion queues.

## Topology and limits

- **Full mesh**: one `RTCPeerConnection` per pair, directly between WebViews. The lower peer id offers, the other only
  answers (no glare); mute and microphone changes replace the sent track (no renegotiation). Negotiation that arrives
  before the roster naming its sender is kept briefly and replayed.
- **At most 6 people in a call** (`MAX_VOICE_MEMBERS`); a 7th join is refused with "The voice call is full" while code
  collaboration continues. A window never holds more than 8 peer connections.
- **One call per window, one voice window per room** on a computer (a second window is told voice is open elsewhere).
- Measured on this PC (3 copies, synthetic microphones): a sending member +~15 % of one core, a listen-only one +~7 %,
  +5-8 MB of memory; collaborative typing latency unchanged (median 77 ms with the call vs 76 ms without); a shared file
  opened in 45 ms during the call.

## Routes

- **Local network** (the room was reached over the LAN): `RTCPeerConnection` gets **no ICE servers** — host candidates
  only, no Internet, signaling server, STUN or TURN. Automated signaling tests run on the LAN route with none of them.
- **Internet**: the configured STUN and TURN servers (Settings > Collaboration, empty by default) are offered — TURN
  with its login, only to the window holding the call (`collab_voice_media`, phases 10-11; see `collaboration-connectivity.md`).
  `turns:` needs a certificate Windows trusts.
- **Host candidates in WebView2 (measured, phase 10)**: with microphone permission granted, literal IPv4/IPv6 host
  candidates (UDP and TCP); without it (listen-only, blocked, or not asked yet), one mDNS `*.local` UDP candidate. A
  speaker↔listener pair still connects where multicast is blocked (the listener reaches the speaker's literal address);
  two listen-only members depend on mDNS but carry no audio; a first-ever join gathers before the prompt is answered,
  and the one ICE restart after a failure gathers again with the permission. A multicast-blocked LAN wasn't available.

## Microphone permission (observed in this build, Windows, WebView2)

- `getUserMedia` works in the Tauri WebView. Nothing asks for the microphone until **Join Voice**, and a member who may
  not speak (listen-only) joins without asking at all.
- WebView2 shows **its own prompt** ("http://tauri.localhost wants to Use your microphones" — Block / Allow). wry handles
  only clipboard permissions, so the microphone request falls through to WebView2's default; **no host-side handler was
  added** and nothing is auto-granted. (Tauri IPC capabilities have nothing to do with it.)
- **Block** → the member stays in the call, listen-only, with "Microphone access was denied …"; clicking Unmute again does
  not re-prompt; the decision **persists across restarts** (it lives in the app's WebView2 profile, `data/webview`).
- **Windows privacy** blocking desktop apps: Chromium reports "Permission denied by system"; the panel explains the
  Windows setting (not opened or changed automatically). Not reproduced here: changing the OS setting wasn't done.
- No device / device busy / chosen device gone: explained; a vanished microphone falls back to the default.

## Controls

- **Join / Leave Voice** (Leave keeps the room connection), **Mute / Unmute** (the Owner allows an unmute before audio is
  sent; mute disables the track), **Raise / Lower Hand**, **Microphone** and **Speaker** (`setSinkId`, available in
  WebView2) selection.
- **Speaking**: Web Audio analyser in the WebView, sampled every 100 ms; on after two loud frames, off after eight quiet
  ones; published at most every 300 ms. Levels never leave the window. Shown as a green microphone and a ring on the
  member's dot (active speaker), with words for screen readers.
- **Moderation**: **Force Mute / Allow Speaking** (`voice.forceMute`, Owner by default, Admins too) — the target's sending
  stops at once and an unmute is refused until a moderator allows it. It does not touch Windows' microphone settings.
- **Permissions**: `voice.join`, `voice.speak`, `voice.muteSelf`, `voice.manageMembers`, `voice.forceMute` (existing
  taxonomy). Viewers join listen-only by default; granting `voice.speak` lets them unmute without reconnecting; revoking it
  mutes a speaker at once; denying `voice.join` removes a member from the call.

## Life cycle

- Leave / kick / ban / remove / room close / disconnect: the member is out of the call, its connections and audio sinks
  are released, the microphone is stopped. When the room leaves this computer's network for any reason, the call ends
  here and the microphone is released.
- A new session (rejoin) negotiates afresh; nothing from the old session is reused.
- Audit: `voice.joined`, `voice.left`, `voice.forceMuted`, `voice.forceUnmuted` and permission changes. Mutes, speaking
  and hands are not recorded; audio, levels and SDP never are.

## Classes (SFU, phase 11)

`VoiceTransport` is the only part that knows how media travels. In classroom mode `LiveKitSfuVoiceTransport` replaces
`PeerMeshVoiceTransport`: one connection per member to a media server instead of a mesh, up to 60 people. The panel,
permissions, roster, voice state, moderation, devices, speaking detection and the Owner's authorization are the same. The
Owner picks the mode per room while the call is empty. See `collaboration-classroom.md`.

## Release gates still open

1. Physical two-PC offline LAN validation (voice included).
2. TURN for restrictive Internet networks — implemented in phase 10; verified on one computer only (cross-network
   pending).
3. Classroom voice in a real classroom (several computers, a real LAN, real microphones) — built and measured on one
   computer in phase 11; the physical classroom test is pending.

## Development

`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream [--use-file-for-fake-audio-capture=<wav>]
--mute-audio` in `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` gives test copies synthetic microphones and silent output (no
acoustic feedback when several copies run on one computer), with `OPENMIND_DEV_COLLAB_BIND=127.0.0.1` (debug builds).
