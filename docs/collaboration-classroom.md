# Classroom voice (Milestone 24, phase 11)

Voice for classes and large rooms: one connection per member to a media server (an SFU, LiveKit) instead of a
peer-to-peer mesh. Peer-to-peer voice (phase 9, up to 6 people) stays the default and stays first-class; classroom mode
is chosen by the room's Owner, per room, while nobody is in the call. Audio only: no video, screen sharing, recording or
transcription.

## Architecture

```text
Owner's computer (Rust)                         Each member's window (WebView)
 ├─ the room: membership, roles, permissions     ├─ Join Voice → asks the Owner for a media grant
 ├─ the call (VoiceBoard): who, muted, hand      │    (VoiceMediaRequest over the room's control channel)
 ├─ media grants: short-lived tokens, signed     ├─ LiveKitSfuVoiceTransport → one WebRTC connection
 │   here with the media server's API secret     │    to the media server; publishes the microphone once
 └─ enforcement on the media server (Twirp):     └─ plays each remote audio track once
     publish permission, removal
                    ▲                                   ▲
                    └────────── media server ───────────┘
                     (on the Owner's computer, or one the school runs)
```

- **The OpenMind room stays the authority.** The media server never decides who may join or speak: the Owner checks the
  member's current session, membership, `voice.join`, that the Owner already accepted it into the call, and
  `voice.speak` / force mute, then signs a token for exactly that. When anything changes (role, permission, force mute,
  kick, ban, leaving, room closed, hosting stopped) the Owner corrects the media server through its management API (Twirp)
  the moment the call changes — no timer, no polling. Only differences are sent; it runs one correction at a time.
- **Tokens** (`openmind_collab::sfu`): HS256, signed in Rust by the Owner, **2 minutes**, one room, one identity, `roomJoin`,
  subscribe, and `canPublishSources: ["microphone"]` only when the member may speak (no data, no camera, no screen, no
  admin rights). A member receives its token only in the editor window that holds the call (`collab_voice_media`). The
  API secret never leaves the Owner's Rust process (frontend, members, logs and errors never see it).
- **Opaque names.** The media server sees `om-<24 hex>` for the room (SHA-256 of the room id) and `p-<24 hex>` per member
  (SHA-256 of room id + peer id). No Room Code, display name, machine identity, profile id or key is sent to it.
- **Same voice service.** Join/Leave, mute (the publication itself is muted), listen-only (nothing is published, no
  microphone prompt), devices, speaking (OpenMind's own analyser and roster — LiveKit's speaker events are not used, so
  the two can't disagree), raised hands and the member panel's controls are those of phase 9. The panel says
  **Voice: Classroom** or **Voice: P2P**.
- **Failure isolation.** A media-server problem is a voice problem only: the code room, edits, files and room control
  carry on. If the server can't be reached at Join, or the connection is lost and can't be resumed (about **14 s**
  measured, see below), the call ends with a message and the microphone is released. There is **no automatic fall back
  to peer-to-peer** (a 30-person mesh would overload every computer).
- **The client library** (`livekit-client` 2.22.3, pinned) is bundled by the frontend build into its own chunk
  and loaded only when a classroom call starts (about 0.55 MB, 145 KB compressed). Nothing is fetched from a CDN; no
  Node.js runs.

## Deployment modes

Decided after measuring (below): **A — an optional local server**, plus **B/C — a server the school runs**.

| Mode | What | Who installs it |
| --- | --- | --- |
| Local (offline LAN classroom) | LiveKit server 1.13.7 on the Owner's computer, started from the room panel | Runtime Manager → *Classroom voice server* (19 MB download, checksum-checked; **not** in the installer) |
| Configured server | Any LiveKit server: Settings › Collaboration › *Classroom voice server address* (`wss://…`) and *API key*; the API secret is typed in the room panel and stored **encrypted with Windows DPAPI** on the Owner's computer | The school's IT |

No LiveKit Cloud address is built in. A local server, when running, is used before a configured one.

### The local server

- Runs as an ordinary child process in a Job Object (dies with the app or when stopped from the panel); **no Windows
  service, no administrator rights, no Redis**, nothing on PATH.
- A **fresh API key and secret for every start** (random, kept in memory, passed through the environment, never written
  or logged). The configuration file in `temp/classroom-voice/` contains none and is removed when the server stops.
- Binds **one chosen address** (the Owner picks it: LAN interfaces first, then 127.0.0.1). Ports: **TCP 7880**
  (signalling/WebSocket) and **UDP 7882** (media, one port for everyone). LiveKit's TCP media fallback (7881) is turned
  off, because it would listen on every interface (measured: `bind_addresses` covers only the HTTP port). At most 60
  participants per room.
- Plain `ws://` is accepted only for this computer, private (RFC 1918) or link-local addresses; anything else needs
  `wss://` with a certificate Windows trusts. Certificate checks are never turned off.
- Logs (`logs/classroom-voice.log`) are LiveKit's warnings; tokens are not in them.

## For IT (firewall)

See `collaboration-it-deployment.md` (program rules, ports, profiles, what not to change).

## Where the API secret lives (and the token-endpoint seam)

- **Local classroom server**: the secret is generated per run inside the teacher's OpenMind process and handed to its own
  child; it is never stored or shown.
- **Institution server**: the API secret exists only on the computer that hosts rooms with it (typed once in the room
  panel, stored DPAPI-encrypted for that Windows user). It is read only by the Owner's Rust code that signs member grants
  and calls the server's management API (`sfu::server`, `sfu::grant`, `sfu::enforce`). Members never receive it: what
  reaches a member is `{ url, token, expiry }` over the room's control channel, and only for the window holding the call.
  A computer that only joins rooms never reads a secret, even if one is stored there.
- **Seam for a trusted token endpoint**: the grant is produced in one place (`sfu::grant`, after the OpenMind room has
  authorized the member). An institution that does not want any teacher computer to hold the secret can replace that
  call with a request to its own token service; the protocol to members (`VoiceMedia { url, token }`) and every client
  stay the same. Moderation on the server (`sfu::enforce`) would then also go through that service. Not built in this
  milestone (no cloud service).

## Tokens: what is exposed and what is not

- **Exact SDK path (livekit-client 2.22.3)**: the token is sent as the `access_token` **query parameter** of the
  signalling WebSocket (`/rtc/v1?access_token=…`) and of the `/rtc/v1/validate` request made after a failed connect
  (`createConnectionParams`, `createJoinRequestConnectionParams`). Browsers can't put headers on a WebSocket, and this
  version offers no other way (its own logger redacts the token as `<redacted>`).
- **Where it shows up**: Chromium's own network-error lines in the WebView console (e.g. a refused connection) print the
  full address, token included. They stay in the WebView's DevTools console: not in OpenMind's logs, SQLite, settings,
  canonical state or the WebView profile (scanned: no token in any file of the test copies). Release builds don't
  include DevTools; only a user who sets WebView2 debugging arguments in their own environment can see that console.
  Not stripped by any hack.
- **Limits of a token**: 2 minutes, one media room (opaque name), one identity (opaque), subscribe, and publishing only
  the microphone when the member may speak; no data, video, screen, admin or room-creation rights.
- **Refreshed tokens (measured in LiveKit 1.13.7's source)**: the server sends every connected client a new token every
  5 minutes, valid 10 minutes, with its *current* grants, and again whenever its grants change; tokens can't be revoked.
  So a client that is removed but deliberately keeps one could reconnect on its own. OpenMind's client never does (it
  connects only with a fresh grant from the Owner), and the Owner limits a modified client: before removing a member
  it takes away the member's listen and speak rights, so the last token the server sends it grants nothing; and for 10
  minutes after a removal, whenever the call changes, the Owner checks the media room (at most every 3 s) and removes
  that identity again if it came back. Residual: during a completely quiet call, a removed, modified client holding an
  older refreshed token could listen until the next call change or the 10 minutes pass.

## Measured (this computer, Windows 11, one machine)

Server: the same LiveKit binary and configuration as the local mode, on the LAN address; simulated members from LiveKit's
own load tester (`lk load-test`, v2.18.8) on the same computer (it competes for the CPU, so these are upper bounds).
"CPU" is % of one core.

| Members | Speakers | Server CPU avg / max | Server memory | Tracks received | Packet loss |
| --- | --- | --- | --- | --- | --- |
| 10 | 1 | 5.8 % / 8.6 % | 88 MB | 9/9 | 0 |
| 20 | 1 | 7.8 % / 12.5 % | 112 MB | 19/19 | 0 |
| 30 | 1 | 21.2 % / 32 % | 136 MB | 29/29 | 0 |
| 30 | 4 | 30.5 % / 39.8 % | 161 MB | 104/104 | 0 |
| 30 | 10 | 23.9 % / 32 % | 167 MB | 120/200 ¹ | 0 |
| 60 | 2 | 32.1 % / 39.8 % | 226 MB | 116/116 | 0 |

¹ the load tester's listeners subscribe selectively ("speaker" layout); the app subscribes to every speaker.

Three real app copies (Owner speaking, an Editor speaking, a Viewer listening), synthetic microphones:

| | No call | Peer to peer | Classroom |
| --- | --- | --- | --- |
| Owner CPU / upload | 2.5 % | 19.5 % / 70 kbps (2 connections) | 13.8 % / 60 kbps (1 connection) |
| Editor CPU / upload | 0.4 % | 14.8 % / 77 kbps | 13.4 % / 72 kbps |
| Viewer (listen-only) CPU / upload / download | 0.1 % | 7.3 % / 11 kbps / 64 kbps | 5.5 % / 0 / 107 kbps |

- A speaker's upload in classroom mode is one stream regardless of class size (Opus with RED redundancy, ~60–70 kbps); in
  peer-to-peer it grows with every member. A listener downloads one stream per speaker.
- **Code collaboration is independent**: typing latency between two members was 91 ms (median, classroom call), 92 ms
  while 30 simulated members loaded the same server, 89 ms in a peer-to-peer call.
- **Loss detection**: LiveKit's default gave up after 10 attempts / 88 s; OpenMind retries at most ~12 s (one attempt waits
  ≤ 5 s): measured 13.7 s from the server stopping to "connection lost".

Not claimed: any number of students beyond what is measured above, or behaviour on a real classroom network, Wi-Fi with
client isolation or a multicast-blocked LAN — those need the physical classroom test.

## Life cycle

- **Leave / kick / ban / revoked `voice.join`**: the member leaves the media room (the Owner removes it there, rights
  first); it stays in the code room unless kicked/banned. **Force mute / revoked `voice.speak`**: the media server itself
  withdraws the member's microphone track; an unmute is refused until allowed, and the member publishes afresh then
  (fixed in the stabilization phase: it used to un-mute the dead publication and send nothing).
- **Room closed / hosting stopped**: the call ends for everyone (nobody stays listed in it, also after hosting resumes)
  and everyone leaves the media room.
- **Window reload**: the reloaded page starts with no call; the backend treats the page load like a closed window for
  voice (the member leaves the call, so the Owner drops it from the media room) and stays in the code room.
- **Room connection lost (code room only)**: no grace for voice. The member's own window ends its media at once; on the
  Owner's side the member is out of the call (and the media room) when its session ends — after the connection's
  detection plus its 20 s reconnect grace, measured ~47 s for a killed member. A reconnect is a new session: the call is
  joined again with a fresh grant, through all the room's checks; a permission removed meanwhile applies (listen-only,
  or no call), a ban or a closed room keeps it out (deterministic tests: `host/outage_tests.rs`, `voiceService.test.ts`).
- **Media server lost**: resumed when it comes back within ~12 s, otherwise "connection lost", Join again. A restarted
  local server has new keys: members join again.
- **App close or crash**: closing (or a crash of) the teacher's app ends a local server with it.
- **Audit**: joined/left, force mute, permission changes and `voice.modeChanged`. Tokens, SDP, ICE, audio, levels and
  speaking are never recorded.

## Limits

- The local server exists for **Windows x64** only (the Runtime Manager manifest). Elsewhere the panel says a classroom
  server can't run on this computer and offers a configured server or peer-to-peer voice; it never offers an install.
- One local server per computer; fixed ports (TCP 7880, UDP 7882), checked before starting on the chosen address *and*
  on all addresses (a program holding a port is named; code collaboration is unaffected). Dynamic ports were not adopted:
  members get the address in their grant, but the fixed pair is what IT can write a rule for.
- A crash of the teacher's app leaves the server's configuration file (no credentials) in `temp/classroom-voice/`
  until the next start or stop.
- Token exposure in the WebView console and refreshed tokens: see above.
- Measured on one computer; **not yet validated in a physical classroom**.
