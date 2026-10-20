# Collaboration on a local network (Milestone 24, phase 5.1)

Rooms work between computers on the same reachable LAN with **no Internet**: no hosted signaling relay, no public STUN,
no TURN. Nothing about a room changes — same room record, Room Code, authority, roles, permissions, protocol, workspace
sharing and file transfer. Only how the two sides find each other and exchange WebRTC offers differs. A route is not a
kind of room: the same room is reachable over the LAN and through the Internet relay at once.

Setting: **Settings > Collaboration > Local Network** (`collaboration.localNetwork`, **off by default** since the
Room Code-only change). Hosting with it on listens for other computers (TCP 47732, UDP 47731, mDNS), which makes Windows
Firewall ask for permission — an administrator's password on managed PCs, and Cancel creates Block rules. Turn it on
only for networks with no Internet. With it off, rooms meet through the Internet signaling route (below) and the WebRTC
connection is still direct when both computers are on the same network (ICE host candidates).

## Room Code only: the built-in public brokers

With no **Signaling Server** set, both sides use the public MQTT brokers in
`openmind_collab_net::signaling::mqtt::PUBLIC_BROKERS` (EMQX, HiveMQ, Mosquitto — MQTT over `wss://`, ports 8084/8884/8081):
the Owner registers on all of them at once and a participant takes the first Owner that answers (no answer for 12 s on a
broker: `NoHost` → "room not found"). Both computers only connect out — nothing listens, so Windows Firewall has nothing to
ask about for signaling. The MQTT topic is a one-way hash of the signaling topic and every envelope is sealed with
ChaCha20-Poly1305 under a key derived from it (`signaling/mqtt/room.rs`): the broker sees neither the Room Code nor SDP or
addresses. Authentication is unchanged (Owner proof bound to DTLS). STUN defaults to Google and Cloudflare when none is
set (`ice::DEFAULT_STUN`). The join form asks only for the Room Code. Limits: free public services with no uptime promise;
networks that allow only port 443 need a configured `wss://` signaling server; two computers behind strict NATs need a
TURN server. Real-broker tests: `cargo test -p openmind-collab-net --test mqtt -- --ignored`.

## Order of routes (participant)

```text
Room Code ─▶ typed-in Owner address (if any) ─▶ address that worked last time ─▶ discovery (mDNS + broadcast)
          ─▶ each found address tried directly ─▶ none worked ─▶ Internet signaling relay (if configured)
```

`openmind_collab_net::route::connect` returns the session and its `ConnectionRoute` (`localLan` / `internetRelay`); the
app reports it in `collab_join`'s answer, `collab_net_status().routes` and a `collab:net` `{kind: "route"}` event, so a
page can say "Connected directly over the local network" without knowing about mDNS or ICE.

| Situation | Result |
| --- | --- |
| Same LAN, Internet available | local route (preferred) |
| Same LAN, no Internet | local route |
| Different networks, Internet relay configured | Internet route (unchanged) |
| Different networks, no Internet | can't connect — there is no network path |

## Owner side

Hosting a room (`collab_host_start`) starts `lan::host::LanHost` next to the Internet route:

- **Rendezvous**: the ordinary signaling relay (`openmind_collab_signal::Relay`) embedded in the app, listening on all
  IPv4 interfaces on port 47732 (any free port if taken). It holds only this room's topic, and only connections from
  this computer may host on it (`RelayConfig::loopback_hosts_only`); others may only join. Same signaling messages as
  the Internet relay — no second handshake format.
- **Signaling**: `signaling::multi::MultiSignaling` makes [local rendezvous, Internet relay] one link for the Owner loop.
  A participant's signals go back on the route they came from; an unreachable route (no Internet) is retried in the
  background and doesn't stop the other.
- **Per participant**: one who arrived over the rendezvous gets a peer bound to the local address that routes to them,
  host candidates only — no STUN request, no TURN allocation (`owner::lan_options`).
- **Announcements**: mDNS service `_omcollab._tcp` and a broadcast responder on UDP 47731. Re-announced when the
  usable addresses change (checked every 15 s), withdrawn at once when hosting stops (mDNS goodbye; the responder and
  rendezvous close).
- `collab_net_status().lanEndpoints` lists `ip:port` addresses to give participants when discovery is blocked.

## What is announced

Only: protocol version, a **discovery tag**, the rendezvous port, a random per-run instance id, a TTL, and (broadcast
answers) the asker's nonce echoed back. The tag is the first 16 bytes of
`SHA-256("openmind-collab-lan-v1\n" + signaling topic)`: one-way, with its own label, so neither the Room Code nor the
signaling topic is ever on the LAN. Never announced: the Room Code, room id or name, workspace name or path, member
names, machine name (mDNS host name is `om-<random>.local.`), keys, history. Tests capture real packets and check for
the code (with and without dashes), topic, invite hash, room id and names.

## Discovery

- **mDNS** (primary; `mdns-sd`, pure Rust, no Bonjour, no admin), only on the selected interfaces.
- **UDP broadcast** (fallback): one small query to the limited broadcast and each interface's subnet broadcast, three
  times within 2.5 s, then stop. An Owner answers only its own tag, only to the asker, at most 20 answers/s. The address
  used is the answer's source address, never one written in the packet; an answer with a nonce the participant isn't
  waiting for (replay) is ignored. Packets: ≤ 512 bytes, exact JSON fields, known marker and version.
- **No scanning** of addresses or subnets, ever.
- **Typed-in address** (`collab_join(code, name, lanAddress)` / `collab_rejoin(room, name, lanAddress)`): for networks
  that block multicast and broadcast but allow direct traffic. The Room Code is still required.

One process answers broadcasts for all the rooms it hosts on one socket (a unicast datagram to a shared port reaches
only one socket on Windows); other app copies on the same computer share the port with `SO_REUSEADDR`.

## Interface selection (`lan::netif`)

Decided from what the system reports, never from adapter names:

- excluded: not up, loopback, no usable address, and a virtual adapter (Hyper-V, VMware, VirtualBox, Parallels, Xen,
  QEMU, Docker vendor prefixes) **without a gateway** — host-only switches such as Hyper-V "Default Switch", WSL and
  Docker Desktop;
- ranked: Ethernet/Wi-Fi with a gateway, then Ethernet/Wi-Fi without one (a lab switch with no router), then anything
  else that is up (VPN, bridged virtual adapter); a 169.254.x.x address only when an interface has nothing else.

The rendezvous listens on IPv4, so IPv4 addresses are announced; IPv6 is not used for the local route yet. On the
development PC the result was: Ethernet first, the VPN tunnel ranked lower, both Hyper-V switches and loopback left out
(`cargo run -p openmind-collab-net --example lan_interfaces` prints it).

## Security

The LAN is untrusted. Discovery only proposes addresses; every connection still runs the unchanged handshake (DTLS
fingerprint binding, the Owner's Room Code proof on a first join or pinned key on a reconnect, the participant's proof,
admission by the authority, replay protection, `authorize`). A machine announcing a room it doesn't own — even one
that knows the topic — fails the Owner proof; the participant tries the next address. A refusal from an endpoint
doesn't stop the search (anyone can send one), but is the reason reported when nothing worked. Tested: forged
advertiser, wrong code, guessed tag, replayed/foreign/garbage/oversized answers, changed Owner key, banned member.

## Reconnect

A rejoin tries the address that worked last (kept in memory for the app session, not stored with the room), then
discovery, then the Internet relay — always a new authenticated session. An Owner that moved from Ethernet to Wi-Fi is
re-announced within 15 s.


## Diagnostics

`collab_net_diagnostics` (no Room Code, key, identity or path): Local Network on/off, whether a signaling server is set,
the TURN status (phase 10), the interfaces used (rank + addresses), each hosted room's rendezvous port, typed-in addresses
and whether mDNS / broadcast are announcing, the joined rooms' routes, the latest join's **route report** (what
discovery found — mDNS or broadcast —, each address tried with its outcome and time, and the failure category
`notFound` / `blocked` / `refused`), and **Windows Firewall's verdict** for this app (below). The frontend turns
categories into localized text (`src/services/collab/lanStatus.ts`).

A try's outcome: `unreachable` (no TCP answer within 3 s: firewall, isolation, Owner gone), `noRoom` (reached, but no
room for this code there), `notOwner` (the Owner proof failed), `refused`, `noDirectPath` (signaling worked, the direct
UDP connection didn't), `connected`.

## Windows Firewall (observed on a Windows 11 PC)

- Windows shows "Windows Defender Firewall has blocked some features" the first time a program **path** listens on
  the network. Each build or portable copy at a new path asks again.
- **Dismissing or cancelling that prompt creates inbound *Block* rules** for the program. Nothing tells the user later.
- The prompt preselects *Private* networks. A computer on a network Windows calls **Public** (this PC's Ethernet;
  common for lab, guest and university networks) stays blocked if only Private is allowed.
- Connections from a computer to its own address are not filtered — a one-computer test passes even with Block rules.
- Allowing a program needs administrator rights.

OpenMind never adds, changes or removes firewall rules. When hosting starts it **reads** Windows Firewall's answer for
its own executable on the connected networks (one PowerShell query, no admin; `lan::firewall`): `allowed`, `blocked`
(an enabled Block rule), `noRule` (Windows will ask; a managed PC may block silently) or `unknown`. It can't see rules
that match by port, or central policies. Participants of a blocked Owner get, within ~3 s per address, category
`blocked`: "...the Owner's computer may be blocking inbound local-network traffic: check Windows Firewall or your
university's network policy. Some Wi-Fi networks also keep computers from reaching each other (client isolation)."

## Installer and firewall rules (decision: no change in this phase)

| Edition | Can it add a firewall rule? |
| --- | --- |
| NSIS per-user setup (`installMode: currentUser`, no elevation) | No. Adding a Windows Firewall rule needs administrator rights; a per-user installer has none. |
| MSI (per-machine, elevated) | Technically yes (WiX firewall extension or an elevated custom action), but it would change a security setting on every install. Not done. |
| Portable ZIP | No. Nothing is installed; Windows asks on first use, and standard users usually can't approve. |

Students without admin rights therefore depend on IT. Recommended for university / lab deployment:

1. **Program rule (preferred)**, pushed by Group Policy or Intune, for the exact installed path:
   `New-NetFirewallRule -DisplayName "OpenMind Studio (local collaboration)" -Direction Inbound -Action Allow -Program "<install folder>\OpenMindStudio.exe" -Profile Domain,Private,Public -RemoteAddress LocalSubnet`
   — covers the rendezvous (TCP), discovery (UDP 47731, mDNS UDP 5353) and the WebRTC connection (an ephemeral UDP
   port, which a port-only rule can't name). `-RemoteAddress LocalSubnet` keeps it to the lab network.
2. If IT insists on ports: TCP **47732** (rendezvous; if it is taken OpenMind picks another port and a port-only rule
   then fails), UDP **47731**, UDP **5353** — and the WebRTC UDP connection still needs the program rule.
3. Lab networks must let computers reach each other: no Wi-Fi client/AP isolation, multicast/broadcast allowed for
   automatic discovery (otherwise participants type the Owner's address shown in diagnostics).
4. Only the computer that **hosts** needs inbound access. Participants only connect out.

## Two-computer check (`lan_check`)

The app has no room panel yet, so the physical test uses `crates/collab-net/examples/lan_check` (one `.exe`, nothing
to install): the real stack — `LanHost`, mDNS/broadcast, the rendezvous, `str0m`, the Room Code handshake, manifest,
verified chunked transfers, live deltas from the real file watcher — with **no Internet route configured on either
side**, so any session it makes is `localLan`. The room is in memory (database and audit chain are covered by the app's
own tests: `commands/collab/net_lan_tests.rs`).

```text
cargo build --release -p openmind-collab-net --example lan_check
   -> <target>\release\examples\lan_check.exe   (copy to both PCs)
PC A:  lan_check host "C:\path\to\a\project"     shows the Room Code (screen only), addresses, firewall verdict
          commands: status | rotate | ban | quit
PC B:  lan_check join <ROOM-CODE>                 automatic discovery
       lan_check join <ROOM-CODE> --addr <A's ip:47732>    typed-in address
          commands: ls | open <path> | big | reconnect | quit   (tree changes print as they arrive)
both:  lan_check interfaces
```

Runbook: disconnect the WAN uplink (or unplug the router's Internet side) so both PCs have LAN only, then on PC B:
`join` with the code only → route report shows the discovery source, `route":"localLan"`; `open <small file>`, `big`
(the largest file, several 64 KB chunks: SHA-256 printed and verified); on PC A create / rename / delete a file and
rename a folder (renames keep their ids on PC B); unplug PC B's cable, plug it back, `reconnect` (fresh session, the
remembered address first); `join` with a wrong code and `--addr` (refused); `rotate` on PC A, then `join` with the old
code (not found); `ban` on PC A, then `reconnect` (refused). Then repeat with PC A's firewall rule for `lan_check.exe`
set to Block (Case B: PC B reports `blocked` within seconds) and on a Wi-Fi with client isolation if one is available.

## Limits

- No two-computer test has been run yet (only one physical PC was available); see the runbook above.
- Client/AP isolation (common on university Wi-Fi) makes local collaboration impossible on that network.
- IPv6 is not used for the local route yet.
- Multicast/broadcast filtered: use a typed-in address.
