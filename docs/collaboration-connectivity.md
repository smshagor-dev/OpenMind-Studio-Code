# Collaboration connectivity: TURN, routes and reliability (Milestone 24, phase 10)

TURN as a **fallback** for code collaboration (Rust, `str0m`) and voice (WebView), safe diagnostics of the path a
connection takes, and the reliability work around it. Local-network and direct paths stay first; nothing about rooms,
authority, the protocol or the LAN-first behaviour changed.

## TURN client: library audit

| Option | Long-term credentials, Allocate, Refresh, CreatePermission, ChannelBind, Send/Data | TURN server reached over UDP | TCP | TLS | Fit |
| --- | --- | --- | --- | --- | --- |
| `turn-client-proto` 0.7.3 (sans-IO) | yes; refreshes allocation/permissions/channels itself, stale-nonce retry, Refresh(0) release | yes (`TurnClientUdp`) | yes (`TurnClientTcp`, stream framing) | through any TLS stream wrapped around the TCP client | **chosen** |
| `turn-client-rustls` 0.1.2 | wraps the TCP client in rustls | — | — | yes | not used: `unwrap()`s on its I/O path; our own `tokio-rustls` stream does the same with our verified roots |
| `rtc-turn` 0.21 (webrtc-rs, sans-IO) | yes, but refresh is driven by the caller and the realm must be known up front | yes | its "TCP" is REQUESTED-TRANSPORT (RFC 6062), **not** a TCP connection to the server; no stream framing | no | rejected |
| `turn` 0.17 (webrtc-rs, async) | yes | over a datagram `Conn` | only via a custom framed `Conn` | no | rejected (heavy, own runtime model) |

Transport support was checked in the sources and then **proved against a real Coturn**: UDP, TCP and TLS on 443 each
allocated, installed permissions, bound channels and relayed data, and a whole room ran over each (below).

**Two defects of `turn-client-proto` 0.7.3 found by testing, handled in our adapter (no fork):**
1. ChannelData on a stream (TCP/TLS) must be padded to 4 bytes (RFC 8656 §12.5). The library neither pads what it
   sends nor skips the server's padding, so the stream desynchronized after the first packet whose length wasn't a
   multiple of 4 (most DTLS/SCTP packets). `turn::watch::StreamFramer` splits the stream into whole frames and strips
   the padding before the library sees them; `pad_for_stream` pads outgoing ChannelData.
2. A 401 to the *authenticated* Allocate (wrong password) isn't final for the library — it waited out its 10 s timeout —,
   and an allocation whose refreshes keep failing is dropped without an event. The adapter reads the server's error
   codes (`ServerWatch`: a 401 to a second transaction, 441, 403, 486, 508, 437 … end the attempt at once) and
   reports a relay whose allocation disappeared as `refreshFailed`.

## Architecture

```text
str0m ICE (peer::driver)                     crates/collab-net/src/turn
 ├─ host candidate      ── UDP socket         ├─ session.rs   turn-client-proto, permissions, channels, release
 ├─ STUN srflx          ── same socket        ├─ io.rs        UDP | TCP | TLS (tokio-rustls, verified)
 └─ relayed candidate   ── RelayLink ────────►├─ watch.rs     stream framing, server error codes
                                               ├─ failure.rs   categories, fixed secret-free messages
                                               └─ credentials.rs  TurnCredentialSource, TurnLogin
                     relay.rs: TurnRelay (RelayProvider) — order, racing, release
```

- `str0m` gives a relayed candidate the relayed address as its base, so every packet whose source is that address is
  handed to the relay (`RelayLink::send`), and data the relay receives is fed back as arriving *at* that address. No
  other module knows TURN exists; the room authority never sees it.
- **Order**: host → STUN → TURN UDP → TURN TCP → TURN TLS. All configured servers are tried at once; the best protocol
  that succeeds is used, waiting at most 1.5 s for a better one; unused allocations are released. ICE pair priority
  keeps direct pairs ahead of the relay (`str0m` re-nominates the best succeeded pair).
- **Never slower on a LAN**: with `IcePolicy::All` the allocation runs *beside* the connection and its candidate is
  trickled in when ready; a direct join doesn't wait for TURN (measured: 118 ms with a dead TURN server vs 118 ms
  without). Local-network routes never use STUN or TURN at all (`lan_options`, `lan_config` also force `All`).
- **Relay-only (diagnostics/tests only)**: `IcePolicy::RelayOnly` offers only the relayed candidate, so every packet
  provably crosses the TURN server. Debug builds: `OPENMIND_DEV_COLLAB_ICE=relay` (Internet routes only; release builds
  ignore it).
- **Life cycle**: the allocation belongs to its peer connection's driver; when the driver ends (leave, close, kick,
  ban, network failure, failed negotiation, window or app close) the `RelayLink` is dropped and the session sends
  Refresh(lifetime 0) and closes its socket/stream — no refresh task outlives its connection.

## TLS on 443

`turns:host:443?transport=tcp`: rustls (ring) with the webpki roots plus Windows' certificate store, **certificate and
host-name verification always on**, safe protocol versions, a 6 s handshake limit, no downgrade (a failed handshake is
a failure, never plain TCP). There is no option that disables verification; a private deployment's own CA can be
added by trusted local code only (`TurnRelay::with_tls_roots`, used by the tests). Failure categories distinguish an
untrusted certificate, a wrong host name, a timeout and other TLS errors.

## Credentials

- The TURN password is stored DPAPI-protected (`collab.turn.credential`) as before. It is now read **only when an
  allocation starts** (`turn_login::StoredTurnLogin`, a `TurnCredentialSource`) — previously it was decrypted when a
  room started and kept for the room's life. It is never in canonical state, room state, logs, the audit or
  diagnostics; `TurnLogin`'s `Debug` prints `****`; errors are fixed categories.
- **Short-lived credentials** fit without a networking change: `TurnLogin { username, password, expires_at, urls }`
  from any `TurnCredentialSource`; an expired one is refused before anything is sent. No account system was built.
- **Voice**: `collab_voice_media` (phase 11; was `collab_voice_ice`) gives the ICE configuration (STUN, TURN with user name and password) only to the editor
  window that holds the room's call, only on an Internet route, read at that moment; the roster snapshot no longer
  carries ICE servers. Extension pages are sandboxed frames without the app's IPC and the extension host is a separate
  process — neither can call it.

## Voice over TURN

`PeerMeshVoiceTransport` builds each `RTCPeerConnection` with the given `RTCIceServer` list (`stun:`, `turn:`,
`turns:`, any `?transport=`) and `iceTransportPolicy` (`relay` only in the debug relay-only mode). The selected path is
read from WebRTC statistics (`voicePath.ts`): `host` / `srflx` / `prflx` / `relayUdp` / `relayTcp` / `relayTls` — no
address. The WebView trusts only certificates Windows trusts, so `turns:` for voice needs a server certificate from a
public or company CA.

## Diagnostics

Collaboration Diagnostics shows: TURN (not configured / no login / ready over UDP, TCP, TLS; the relay-only test mode
when on), each joined room's connection path (direct, through NAT (STUN), TURN relay over UDP/TCP/TLS), members' paths
for hosted rooms (counts only), and the voice path. Never a TURN host, user name, password, candidate, address list or
Room Code.

## Test infrastructure

`crates/collab-net/tests/turn.rs` runs against a real TURN server and is ignored by default
(`OPENMIND_TEST_TURN_HOST/USER/PASSWORD/CA`, plus `OPENMIND_TEST_TURN_SLOW=1` for the refresh test). It was run against
Coturn 4.6.1 in WSL (its own network namespace) with a throwaway CA, a server certificate for its address on 443, a
second listener whose certificate names another host, and a random password kept outside the repository. Nothing about
it is committed.

## Results (one computer: Windows peers, Coturn 4.6.1 in WSL at its own address)

| Check | Result |
| --- | --- |
| Allocate, CreatePermission, ChannelBind, Send/Data | passed over UDP, TCP and TLS on 443 (50-packet bursts) |
| A whole room relay-only (Owner and members): handshake, control, CRDT edit, 300 KB file, presence | passed over UDP, TCP and TLS/443; both sides report the TURN path |
| Past the allocation lifetime (server capped at 600 s) | 34 pings over 660 s relay-only; the server logged allocation refreshes (`lifetime updated: 600`) and permission refreshes (300 s) |
| Refresh failure (server silenced after allocation) | the relay ends with `refreshFailed`; the server logged `allocation timeout` |
| Server gone after allocation (TCP cut) | `lost` within 5 s; the relay task ends (no refresh keeps running) |
| Wrong password (UDP, TCP, TLS) | `unauthorized` in under 5 s; no password in any message |
| Untrusted certificate / wrong host name | `certificate` / `hostnameMismatch` |
| Unreachable server (UDP / TCP) | `timeout` within 11 s / `unreachable` |
| Expired short-lived credential | refused before anything is sent |
| Relay-only join with a bad login | fails with `unauthorized` in under 10 s; the room is untouched |
| Direct path available + TURN available | direct chosen, no switch to the relay |
| Dead TURN server, direct path available | join 120 ms vs 118 ms without TURN |
| Real app, relay-only over UDP and over TCP | room and voice on TURN; audio connected; speaking indicator; mute/unmute; force mute/allow; edit latency median 79 ms (UDP) / 78 ms (TCP) with voice running |
| Real app, TURN configured, relay-only off | room and voice both direct |
| Release | leave, kick and app close each released the allocations at once (`lifetime=0`, sessions closed in the same second) |

**Transient reconnect (real app, relay-only, the TURN server frozen with SIGSTOP)**: 8 s and 35 s outages were absorbed
in place (same session; ICE noticed after ~24 s, recovered within the 20 s grace); voice came back by itself, an edit
made during the outage arrived. A 75 s outage ended B's session (`session.ended`); the room's voice call ended there and
the microphone was released; Rejoin made a fresh authenticated session (`member.reconnected`, a second
`session.started`) on TURN; edits from the outage caught up; presence republished; one Join Voice re-created exactly
one connection (audio 1 of 1 on both sides). This run found and fixed the data-loss bug described in
`collaboration-editing.md` (a participant's rejoin erased the Owner's unsaved edits).

**Not verified here**: TURN/TLS from the app and from the WebView (needs a certificate Windows trusts; the TLS path was
verified at the library level with a test CA), a TURN server on another network, a restrictive NAT, a physical
two-computer LAN.

## Reliability work in this phase

- **Formerly intermittent LAN test** (`a_dropped_connection_comes_back_over_the_known_address_with_a_fresh_session`):
  not reproduced in about 210 runs (alone, 6 copies at once, beside the whole suite, sequential like `cargo test`, 50 + 50
  stress, workspace runs). Measured and excluded: ephemeral-port collisions (Windows hands out UDP ports cyclically and
  skips ports in use, with or without `SO_REUSEADDR`), time-dependent topics/tags (deterministic), load. The original
  report showed only the stale address's "refused": discovery found nothing, and **a discovery query that couldn't search
  (no socket, no nonce, nothing sent) returned an empty list silently**. That is now an error (`broadcast::query` returns
  `Result`), logged, and listed in `RouteReport.discoveryProblems`; the test prints the whole route report if it fails.
- **Signaling relay alive but not listening** (Phase 8): the relay ran in its own hidden console, so Ctrl+C from the test
  shell couldn't reach it, and tokio's `ctrl_c` only reacts to that event. No code path stops its listener without a stop
  request; a stress of 500 connections (valid, malformed, floods, abrupt) and topic expiry didn't reproduce it. Fixed
  what made it invisible: the accepting task's end is now observable (`Relay::ended`/`is_running`, a guard that also fires
  on a panic or cancellation), the relay binary exits with status 1 when it stops accepting unexpectedly, a failing
  `accept` backs off 50 ms instead of spinning, and the Owner's embedded rendezvous reports `listening` in diagnostics.
  Harness: start test relays with their output redirected to a file.
- **Pre-existing test-environment errors** fixed (Vitest exited 1 despite all tests passing): `TabBar`/`FileTree` tests
  rendered `CollabDots`, which booted the whole app container without Tauri; `NetRooms` accepted an empty status; the
  index-status listener rejected without a runtime.

## Remaining gates

1. Physical two-computer offline LAN (room, workspace, editing, presence, management, voice, reconnect, firewall).
2. TURN across two real networks (one side behind a phone hotspot or another ISP), TURN/TLS on 443 with a real
   certificate, a restrictive (university/company) network.
3. Client-isolation Wi-Fi.
4. Offline-LAN voice where multicast is blocked (two first-time speakers rely on the post-permission ICE restart).
5. Classroom voice with several physical computers (`collaboration-classroom.md`); Windows Firewall on a second physical
   PC (`collaboration-it-deployment.md`). Overall status: `collaboration.md`.
