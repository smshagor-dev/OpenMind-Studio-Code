# Collaboration presence (Milestone 24, phase 7)

Who is in a room, which shared file each member has active, where their cursor and selection are, and whether they
are typing. Presence is **ephemeral**: it lives in memory only, is never written to SQLite, is never part of the
canonical state, and is replaced by the next state. It travels on the `openmind-awareness` DataChannel.

## What a member says about itself

`openmind_collab::presence::PresenceState` (`deny_unknown_fields`):

| Field | Meaning |
| --- | --- |
| `seq` | Rises with every state; an older one that arrives late is dropped. |
| `active` | The shared file it has active: a **file id**, never a path. |
| `cursor` | `{anchor, head}`: Yjs *relative* positions (base64, at most 96 bytes each), so they stay on the right character through concurrent edits. Only with `active`. |
| `typing` | An own change in the last 2 s. |

There is no name, role, peer id, machine identity, key, path, Room Code or database id in it, and a packet that adds
any field is refused whole. Later phases can add fields (voice: `voiceJoined`, `muted`, `speaking`, `handRaised`)
the same way; the panel row (`ParticipantRow`) has room for them.

## Authority stays with the Owner

- A participant sends `Presence { state }`. The Owner relays it only if it came on the member's **current session**,
  the member is **active**, `active` is a **file** (not a folder) of this room the member may read, and `seq` is newer.
  Anything else is dropped without an answer (`FrameOutcome::Dropped`); a valid state is relayed without an
  acknowledgement (`FrameOutcome::Relay`) — presence is latest-value data.
- The relayed copy is `PeerPresence { peer, state }`, where `peer` is the **authenticated** peer of the session. A
  participant can't send `PeerPresence`, `PresenceGone` or `Roster` (refused: server-to-client bodies).
- **Roles and online state** reach members only in the Owner's `Roster` (from membership, `CollabRuntime::roster`),
  sent on admission, on leave and whenever membership or roles change. Presence never carries a role.
- **Flood protection**: per link, a separate token bucket for presence (burst 40, 30 per second); over it, states are
  dropped quietly and the connection stays up. Every frame still passes the session/replay checks and the 120 KB limit.

## This computer's presence

Each window reports what its focused editor shows (or, before any editor took the focus — a file opened from the
Explorer — the editor that shows a file) (`collab_presence_set`): the live collaborative document's file
id and cursor (`PresencePublisher`), or — on the Owner — an ordinary file's local path, which the Owner's backend
resolves to the shared file (`file_at`; never sent anywhere as a path). Only the active editor is advertised, never
every open tab. The backend merges the windows of one computer into **one** presence per room (the most recently
changed window that has a shared file active), so several windows never look like several collaborators, and sends
it at most every 50 ms. A window re-sends its state every 10 s (heartbeat); a participant republishes at once after
joining or reconnecting; a closed window stops counting.

## What is shown

- **Remote cursors and selections** (`editor/remoteCursors.ts`): resolved from the relative positions against the
  current text (UTF-16 offsets in both Yjs and Monaco, so emoji are never split), drawn with one decoration collection
  per editor that is updated in place; labels from one generated stylesheet (`.collab-label-N::after`), rewritten only
  when the set of names changes; on line 1 the label goes below the caret (above it would be clipped). Selections never
  grow when the user types at their edges.
- **Indicators** (badges since phase 8's visual check: the member's initial on its colour — a plain dot was too easy to
  take for the "unsaved" dot): on tabs (an `omcollab:` tab by room and file, an Owner tab by path) and Owner Explorer rows (a
  collapsed folder shows who is inside it): at most three dots, then `+N`; the tooltip names them, "typing…" included.
  They redraw only when *who is where* changes (`subscribeActive`), never for a cursor move.
- **Collaboration panel** (activity bar, `view.collaboration`): each hosted or joined room — name, how it is connected
  (hosting; local network or Internet relay; reconnecting) — and each member: name ("you" for this computer), role,
  online / reconnecting / offline, active file and typing. No fingerprints, Room Codes, paths from another computer,
  moderation or voice controls.
- **Colours**: `--collab-1` … `--collab-8` in every theme; a member's colour comes from a hash of its peer id, so it
  is the same in every window and on every computer.

## Life cycle

| Event | Effect |
| --- | --- |
| Member leaves / disconnects | Owner forgets its state, tells everyone `PresenceGone`, sends a new roster; its cursor and dots disappear at once. |
| Participant's connection ends | Its windows clear everyone (`reset`); after reconnecting it reads the room again and republishes. |
| No state for 30 s | Dropped by the receiver (one timer for the next expiry, no polling). |
| Role change | New roster at once. |
| File renamed or moved | Same file id: presence stays; the Owner's windows get the new path. |
| File deleted or hidden | Everyone in it gets a state without an active file; markers go. |

## Tests

- `crates/collab/src/presence.rs`: sequence ordering, role/peer claims refused, file deletion.
- `src-tauri/.../host/presence_tests.rs`: relayed under the authenticated peer to the others, older/stale-session/
  foreign-file/folder states dropped, roster roles from membership, leave and delete cleanup, the Owner's own presence,
  path resolution (case, outside, folder), rename.
- `crates/collab-net/tests/presence.rs` (real WebRTC): local-network route, Internet-relay route, forged
  `PeerPresence`, foreign file and old sequence, a 400-state flood cut to the rate limit with the connection alive, and
  an Owner with five participants.
- Frontend: `presenceService.test.ts` (ordering, roster roles, active-only listeners, expiry/heartbeat/leave/reset,
  snapshot, Owner paths, rename, colours), `remoteCursors.test.ts` (active file only, selection as relative positions,
  emoji and concurrent edits, typing on/off, leaving a room, heartbeat, decoration reuse and clearing, label escaping,
  malformed positions), `collabPanelModel.test.ts`.

## Limits

- Presence is shown for collaborative text documents; binary previews show who is in them (dots) but no cursor.
- The Owner's own cursor is shared once a participant has the file open (that is when the Owner's editor joins the
  shared document); before that the Owner's active file is shared without a cursor.
- One computer is one member: two windows in different files show the most recently used one.
- Participants have no Explorer for the shared tree yet, so their file indicators are on tabs and in the panel.
