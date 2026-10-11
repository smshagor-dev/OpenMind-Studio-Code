# Room management (Milestone 24, phase 8)

The Collaboration panel (activity bar) is where rooms are created, joined and run. Every action goes to the room's
authoritative Rust backend; the panel never decides whether something is allowed and never changes its own state first —
it shows what the backend says afterwards (the canonical `collaboration` domain on the hosting computer, the Owner's
**room view** on a participant's).

## Panel

- **Toolbar**: Create Room, Join Room, Diagnostics.
- **Per room**: name; status chips (Hosting / Connected / Reconnecting / Offline / Closed, Local network / Internet relay,
  Locked); controls the member's permissions allow (Lock/Unlock, "Approve new members", Close Room, Leave Room); on the
  hosting computer the **Room Code** block; **Join requests**; members grouped Owner / Admins / Editors / Viewers with
  role, online / reconnecting / offline, active file and typing (phase 7), and a **⋯ menu** only where the member may act;
  **Banned** members with Unban; for a joined room the **Shared Files** (the Owner's tree; a file opens as the
  collaborative document).
- **Your rooms**: rooms created or joined earlier that aren't on the network now, with **Host** (the room's folder must be
  open in this window) or **Rejoin**. History is never deleted by leaving or closing.

Nothing secret is shown: no key, fingerprint, ICE/STUN/DTLS detail, machine identity or path from another computer.

## Who may do what

The backend's `authorize` decides (permission + rank rules: nobody acts on themselves, only on lower ranks, a role is
given only below one's own rank and never Owner, a grant never exceeds what the giver holds, Owner-only permissions can't be
granted). The panel only hides entries the backend would certainly refuse — no permission, oneself, an equal or higher rank
(`memberActions`, `assignableRoles`, `approvalRoles` in `collabPanelModel.ts`); whatever is shown can still be refused
(stale state, a concurrent change), and the refusal is shown as the Owner's reason.

- **Hosting computer**: `collab_room_command` runs the command as the hosting user.
- **Participant** (an Admin, or the new Owner after a transfer): `collab_remote_command` sends the same `Command` to the
  Owner and waits up to 15 s for its `Ack`/`Reject` (`net_manage::CommandWaits`).
- **Room view** (`openmind_collab::roomview::RoomView`): built by the Owner for each connected member from the
  authoritative room state, **filtered by that member's own permissions** — everyone: room settings, active members with
  role and connection, its own role and effective permissions; `member.approve`: waiting members; `member.ban`/`unban`:
  banned members; `member.managePermissions`: overrides and effective permissions. Sent with the roster after every join,
  leave, waiting member and room/membership change. A participant keeps it in memory and stores the room's name, its own
  role and the settings (locked, closed …) in its joined-room record.
- **Permission model** (`collab_permission_model`): the backend's permission list with groups, each role's defaults and the
  Owner-only set — the UI has no permission list of its own.

## Actions

| Action | Who (defaults) | Notes |
| --- | --- | --- |
| Create Room | anyone with a folder open | name; shares the window's folder; hosted at once; the code is shown once |
| Join Room | — | Room Code; optional Owner `ip:port` (advanced, validated; no scanning); progress: searching → connecting → waiting for approval → connected |
| Room Code: Reveal / Hide / Copy | hosting computer | fetched only on request, held in memory while shown, never logged or put in an event |
| Rotate Code | `room.rotateInvite` (Owner, Admin) | confirmation; members stay connected; the old code stops at once; LAN and signaling re-register under the new topic (phase 5.2) |
| Lock / Unlock | `room.lock` (Owner, Admin) | connected members stay; joins are refused while locked |
| Approve new members | `room.manage` (Owner) | joins wait for approval |
| Approve as Viewer / Editor / Admin, Reject | `member.approve` (Owner, Admin) | another role than the default is set first (`changeRole` while waiting), then `approve`; Reject tells the waiting peer it was **denied** (`Refusal::Denied`) |
| Make Admin / Editor / Viewer | `member.changeRole` (Owner; Admins only by grant) | live: roster, presence and the editor's read-only state follow without reconnecting |
| Permissions… | `member.managePermissions` (Owner) | per permission: role default, override (role default / allow / deny), effective value from the Owner; allow is offered only for permissions the editor holds |
| Kick / Remove / Ban | `member.kick` (Owner, Admin) / `member.remove` / `member.ban` | confirmation dialog; a waiting peer that is removed or banned is told so |
| Unban | `member.unban` | back to "removed": joins again with the current code |
| Transfer Ownership | Owner only | the member's name must be typed; **hosting stays on the original computer** (its user becomes an Admin); no host migration |
| Close Room | Owner only | confirmation; members are told (a last room view saying closed), disconnected, the room leaves LAN and signaling, history stays |
| Leave Room | participants | confirmation; the connection closes, presence and documents clean up, history stays |

Every accepted action is in the room's signed audit history (`room.locked/unlocked`, `room.inviteRotated`,
`room.closed`, `room.ownershipTransferred`, `member.joinApproved/joinDenied`, `member.roleChanged`,
`member.permissionsChanged`, `member.kicked/removed/banned/unbanned`); there is no separate frontend audit store.

## Join errors

`collab_join` / `collab_rejoin` return a category (`net_manage::JoinError`) the panel turns into a sentence (raw text only
under Details): invalidCode, notFound (also the relay's "no host": a wrong or old code, or the Owner isn't hosting),
blocked (found but unreachable: firewall, policy, client isolation), locked, banned, closed, denied, full, notMember,
approvalTimeout, relayUnavailable, version, connectionLost, notConfigured, noDisplayName, invalidAddress, alreadyJoined.
A rejoin refused as *closed* marks the joined room closed locally.

A member who was **not connected** when the code was rotated finds the room again only with the **new** code (the room
is found by its code-derived topic); members connected during a rotation stay connected.

## Diagnostics

The Diagnostics button shows: Local Network on/off, Internet relay on/off, TURN status and connection paths (phase 10), the
network interface rooms use, the local rendezvous port of hosted rooms, Windows Firewall's verdict (read-only, checked when
hosting on the local network) with the phase 5.2 guidance, and the last join's outcome. Nothing is changed.

## Development: two copies on one computer

Debug builds read `OPENMIND_DEV_COLLAB_BIND=127.0.0.1` to keep WebRTC on loopback, so several portable copies on one
machine can be tested together through a local `openmind-collab-signal --listen 127.0.0.1:<port>` without listening on a
network interface (no firewall prompt). Release builds ignore it.

## Limits

- A participant manages only what the Owner's view shows it; the Room Code is visible only on the hosting computer (a
  remote Owner or Admin can rotate it but not read it).
- Ownership moves; hosting does not (no host migration). If the hosting computer stops, the room is offline for everyone.
- Voice permissions are listed (group "Voice (later)") but voice landed in phase 9 and TURN in phase 10.
