# OpenMind Studio collaboration — deployment guide for IT (offline labs and classrooms)

For university and school IT staff preparing computer labs. It covers what OpenMind Studio's collaboration needs from the
network and Windows Firewall. OpenMind Studio never changes firewall rules, the Registry's network settings or any
Windows service by itself; whatever is described here is configured by IT.

**Validation status.** The rules below come from the implementation and from tests on one computer. Two-PC and classroom
tests on real lab networks are still pending (see "Not yet validated" at the end); please report what you observe.

## What runs where

| Part | Program | Network |
| --- | --- | --- |
| Rooms, shared files, collaborative editing, presence, room management | `OpenMindStudio.exe` | The room's Owner (host) **receives** connections; members connect out |
| Peer-to-peer voice (up to 6 people) | WebView2's helper processes (`msedgewebview2.exe`, Microsoft Edge WebView2 Runtime) | WebRTC (UDP), between members |
| Classroom voice (optional, up to 60 people) | `livekit-server.exe` (LiveKit 1.13.7), only on the teacher's computer when started | Receives TCP 7880 and UDP 7882 |

No Internet connection is needed for collaboration on a local network: no account, signaling server, STUN or TURN server.

## 1. Collaboration on the local network (peer to peer)

**Recommended: one program rule** on the computers that will **host** rooms (teacher or student computers):

```powershell
New-NetFirewallRule -DisplayName "OpenMind Studio (local collaboration)" -Direction Inbound -Action Allow `
  -Program "<install folder>\OpenMindStudio.exe" -Profile Domain,Private,Public -RemoteAddress LocalSubnet
```

- **Profiles: Domain, Private and Public.** University networks are often classified *Public* on student computers; a
  rule for Private only would silently not apply there.
- **Scope: LocalSubnet.** The rule then only admits the lab's own network.
- A **program** rule is needed because the WebRTC connection uses a random (ephemeral) UDP port that a port rule can't
  name. Ports, if a port list is required as well: TCP **47732** (room rendezvous; another free port is chosen if it is
  taken, which a port rule would miss), UDP **47731** (discovery broadcast), UDP **5353** (mDNS discovery).
- The portable edition runs from wherever it was unpacked; the rule must name that path. Each copy at a new path is a
  new program for Windows Firewall.
- Members (who only join rooms) connect out and need no inbound rule.

**Voice (peer to peer)** runs inside `msedgewebview2.exe`. Its connections are set up from both sides at once (ICE), so
Windows Firewall's stateful filtering normally lets them through without an inbound rule. If a lab policy blocks
outbound UDP between lab computers, peer-to-peer voice will not connect (code collaboration is not affected).

When a member can't reach the Owner, OpenMind Studio says so within a few seconds and names the likely cause (the Owner's
firewall, or a network that keeps computers apart). The Owner's collaboration panel also shows Windows Firewall's verdict
for the app (read-only).

## 2. Classroom voice server (optional)

For classes larger than 6, a teacher can run a classroom voice server on their computer:

- Installed from **Terminal > Manage Runtimes** (Runtime Manager, "Classroom voice server"), into the app's own
  folder: `<app folder>\runtimes\livekit\versions\1.13.7\livekit-server.exe`. A 19 MB download, checked against a
  pinned SHA-256. **No administrator rights, no Windows service, nothing added to PATH, no Redis.** It is not part of
  the installer.
- Started and stopped from the room panel; it runs only while the teacher's OpenMind Studio runs (it ends with the app,
  also after a crash).
- It listens on **one address** the teacher chooses (the lab network interface) on **TCP 7880** (connections from
  members' apps) and **UDP 7882** (all audio, one port). Nothing else; LiveKit's optional TCP media port (7881) is off.
- Inbound rule for the teacher's computer:

  ```powershell
  New-NetFirewallRule -DisplayName "OpenMind Studio classroom voice" -Direction Inbound -Action Allow `
    -Program "<app folder>\runtimes\livekit\versions\1.13.7\livekit-server.exe" -Profile Domain,Private,Public `
    -RemoteAddress LocalSubnet -Protocol Any
  ```

  or, by port: TCP 7880 and UDP 7882 from LocalSubnet. If either port is already used by another program, the server
  doesn't start and the panel says which port; code collaboration continues.
- A server the institution runs instead: set its `wss://` address and API key in Settings > Collaboration; the API
  secret is typed once on the teacher's computer and stored encrypted for that Windows user (never sent to students).
  A certificate Windows trusts is required. Plain `ws://` is accepted only for addresses on the local network.

The classroom voice server is available for **Windows x64** only. On other computers OpenMind Studio offers peer-to-peer
voice or a configured institution server, and says so.

## 3. Network requirements

- Lab computers must be able to reach each other directly: **no Wi-Fi client (AP) isolation**, no host firewall policy
  that drops inbound traffic from the lab subnet.
- Multicast and broadcast help discovery (mDNS on UDP 5353, broadcast on UDP 47731). Where they are blocked, members can
  type the Owner's address (shown in the Owner's Diagnostics) together with the Room Code.
- No Internet access is required for local collaboration and classroom voice. Rooms across the Internet need a
  signaling server (and a TURN server for restrictive networks), which an institution would run; see
  `collaboration-connectivity.md`.

Please don't disable Windows Firewall globally: the program rules above are enough.

## Not yet validated

- Two physical PCs on an offline lab network (editing, files, presence, management, voice).
- A classroom with several physical computers using the classroom voice server.
- Wi-Fi with client isolation, and a LAN where multicast is blocked (voice between first-time speakers).
- Windows Firewall behaviour on a second physical PC (allowed vs. blocked, Public profile).
- Collaboration across two different networks through TURN, including TURN over TLS on port 443.

These were designed for and tested on one computer only; treat them as not guaranteed until confirmed in your lab.
