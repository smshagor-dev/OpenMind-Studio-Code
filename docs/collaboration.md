# Collaboration in OpenMind Studio (Milestone 24) — start here

Rooms let people work on one project together: the **Owner** shares a folder from their computer, **members** join
with a Room Code, edit files together in real time, see each other's cursors, and talk. Everything is peer to peer
with the Owner as the authority; there is no OpenMind account or cloud service.

## Validation status (read this first)

| Area | Status |
| --- | --- |
| Code (all phases 1-11 plus stabilization): automated tests, one-computer runs with several app copies | **Done** |
| Two physical PCs on an offline LAN (editing, files, presence, management) | **Pending** |
| Peer-to-peer voice between two physical PCs (real microphones and audio) | **Pending** |
| Classroom voice server with several physical clients | **Pending** |
| Two different networks through TURN (UDP, TCP) | **Pending** |
| TURN over TLS on port 443 with a publicly trusted certificate, from the real app | **Pending** |
| Wi-Fi with client isolation; a LAN with multicast blocked (voice) | **Pending** |
| Windows Firewall on a second physical PC (allowed / blocked, Public profile) | **Pending** |

"Pending" means not verified on real hardware or networks. Nothing below is a guarantee for those situations.

## How it fits together

```text
Owner's computer                                    Member's computer
 OpenMindStudio.exe (Rust)                           OpenMindStudio.exe (Rust)
  ├─ room authority: members, roles, permissions,     ├─ joins with the Room Code (Ed25519 identity, pinned Owner key)
  │  moderation, the signed audit chain (SQLite)      ├─ shared files, CRDT document, presence, voice signalling
  ├─ shared folder (never leaves except files asked)  │   — all over one authenticated connection to the Owner
  ├─ CRDT documents: stored before acknowledged       └─ WebView: editor (y-monaco), voice (WebRTC)
  └─ voice authority; optional classroom media server
        ▲ local network (mDNS/broadcast discovery, direct)  ▲ or the Internet (signaling relay, STUN/TURN)
```

- **Rooms, identity and security**: `collaboration-management.md` (roles, permissions, moderation, audit) and the
  security summary below.
- **Offline LAN**: `collaboration-local-network.md` (discovery, routes, diagnostics, firewall).
- **Internet / TURN**: `collaboration-connectivity.md` (signaling relay, STUN, TURN incl. `turns:`, relay-only test mode).
- **Workspace sharing**: `collaboration-workspace-sharing.md` (what is shared, sensitive files, transfers).
- **Collaborative editing**: `collaboration-editing.md` (CRDT, storage, recovery, the Owner's editor, data-loss rules).
- **Presence**: `collaboration-presence.md` (cursors, selections, active files, typing).
- **Voice, peer to peer (≤ 6)**: `collaboration-voice.md`.
- **Classroom voice (≤ 60, media server)**: `collaboration-classroom.md`.
- **IT deployment (labs)**: `collaboration-it-deployment.md`.

## Security model in brief

- **Room Code**: shown only to the Owner (hidden until revealed), rotatable; stored DPAPI-encrypted; never logged, never
  sent to a media server, never in history. A join proves knowledge of the code against a per-connection challenge
  (no replay); later reconnects use the member's Ed25519 key and the Owner key pinned at the first join.
- **Authority**: every remote command, file request, document change and voice action is checked by the Owner against
  the member's *current* session, role, permission overrides, moderation and rank rules. Paths are room-relative and
  checked against traversal and sensitive-file rules; the Owner's absolute paths are never sent (breadcrumbs, tabs and
  Open Editors show "shared folder / path", never internal room or file ids).
- **Secrets**: TURN passwords and the classroom server's API secret are DPAPI-encrypted on the computer that uses them
  and never returned to a page; media tokens are short-lived (2 minutes) and scoped to one opaque room and identity.
- **Extensions** run in a separate Node process without the app's IPC; they can't reach rooms, codes or tokens.
- **Not a sandbox against the Owner**: the Owner's computer sees what members type into shared files (it stores the
  document); members see only what the Owner shares.

## Recovery promises

- Accepted edits are stored before they are acknowledged; after any crash (Owner or member), they come back. When the
  Owner's app restarts and hosting resumes, recovered unsaved changes go straight back into the Owner's editor.
- Nothing typed is lost when the Owner's editor joins a shared document: edits are merged, or kept in a separate tab
  when they overlap.
- A lost connection never writes an old snapshot over a live document. Disk files change only through Save / Save All /
  Auto Save on the Owner's computer.
- Voice ends with the room session (no grace period of its own); a reloaded window starts with no call.

## Limitations

- Physical and cross-network validation is pending (table above).
- One Owner per room; no host migration; an Owner restart ends every member's session (they click Rejoin).
- Text a member typed in the last ~40 ms before its app crashed (never acknowledged) is lost, like unsaved typing.
- Classroom voice server: Windows x64 only; fixed ports TCP 7880 / UDP 7882; LiveKit tokens appear in Chromium's own
  console error lines and LiveKit refreshes tokens it can't revoke (mitigated; see `collaboration-classroom.md`).
- Technical debt: `src/services/workspaceService.ts` was over the 700-line limit before Milestone 24 and stays so;
  collaboration code was kept out of it (new display helpers live in `src/components/remoteTabPath.ts`).
