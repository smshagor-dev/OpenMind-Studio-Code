# Collaboration: real-time editing (Milestone 24, phase 6)

Several people edit the same text file at once. One CRDT document per shared text file, identified by its stable
collaboration file id; the Owner's computer holds the canonical document. The same protocol runs over the local-network
route and the Internet relay route — there is no route-specific editing code. Cursors/presence (phase 7), voice and
TURN are not part of this phase.

## Pieces

| Where | What |
| --- | --- |
| `openmind_collab::crdt::CollabDoc` | a `yrs` document (Yjs-compatible), text type `content`, UTF-16 offsets like JavaScript |
| `openmind_collab::docs::DocHost` | the Owner's documents of a room: open (state-vector sync), authorized changes, resend detection, deletes, snapshots, unloading. Decisions only, no I/O |
| `openmind_collab::sync_chunk` | bounded chunking of large `openmind-sync` messages |
| `src-tauri/.../host/docs.rs` | loading/recovery, storage before acknowledgement, the Owner's own edits, disk baseline |
| `src-tauri/.../net_docs.rs`, `docs_commands.rs` | `collab:doc` events, participant outbox, IPC commands |
| `src/services/collab/collabBinding.ts` | `y-monaco` binding to an existing model, local-only undo, batched sending |
| `src/services/collab/collabDocService.ts` | participant and Owner document lifecycles in a window |

## Flow

```text
participant Monaco ─ y-monaco ─ Y.Doc ─(40 ms batch)─ collab_doc_send ─ outbox ─ YjsUpdate{file, id, update}
   ─ openmind-sync (chunked if large) ─ Owner: gate (session, replay) ─ authorize(file.write) via fsauth
   ─ DocHost (subscribed? applies cleanly? new?) ─ SQLite collab_crdt_updates (unique id) ─ Ack
   ─ YjsUpdate to the other subscribers ─ collab:doc "update" to the Owner's editor (y-monaco ─ its model, dirty)
```

Opening: the participant sends `YjsStateRequest{file, stateVector}` (needs `file.read`, a shared text file of at most
1 M UTF-16 units); the Owner answers `DocSync{stateVector, update}` with only what is missing, and the participant sends
back what the Owner lacks (after an offline stretch). Then live `YjsUpdate`s both ways. The tab's model is the Phase 5
`omcollab://<room>/<file id>` model — one model per document, shared by the tab and the binding.

## Messages (`openmind-sync`, versioned frames)

`YjsStateRequest`, `DocSync`, `YjsUpdate{file, id, update}` (the change's own id: a resend is stored and forwarded once),
`DocUnsubscribe`, `DocClosed{reason: deleted | unavailable | notEditable}`, `SyncChunk{id, index, count, sha256, data}`;
on `openmind-control`: `Access{write}`. Limits: an update ≤ 2 MB, an initial sync ≤ 8 MB, a chunk ≤ 48 KB (≈ 64 KB in a
frame, within the 120 KB data-channel limit), ≤ 4 messages in pieces per sender, the whole verified by SHA-256 before it
is decoded; broken pieces are dropped, pieces of a closed connection go with it.

## Authority and security

Every change is authorized by the Owner with the existing `authorize` (through the filesystem authority: membership,
current session, `file.write`, the id belongs to this room's table, privacy floor, path safety) — role assumptions are
never made in transport code. A role change applies to the next change; the participant's editor also turns read-only at
once (`Access`). Refused safely, with the canonical document untouched: a Viewer's update, a demoted Editor's next one,
an unknown/forged/other-room id, a hidden file (looks unknown), a deleted file, a stale session, a non-member, a
malformed update, an update depending on changes the Owner doesn't have, a malformed state vector, oversized updates or
documents. `yrs` is called behind `catch_unwind`; a document left inconsistent is dropped from memory and rebuilt from
storage.

## Storage and recovery

Each accepted change is stored in `collab_crdt_updates` (unique per room by change id) **before** it is acknowledged or
forwarded; a full snapshot goes to `collab_document_snapshots` every 500 changes and when a document unloads. Recovery =
latest snapshot + later updates. Nothing writes the file: the Owner's editor holds the text and saves it with the usual
Save / Save All / Auto Save (a document participants edit is held open on the Owner's side even without a tab).

Migration `0005_collab_doc_baselines` keeps, per document, the SHA-256 of the file on disk when the document and the
file last matched. Loading a document again: file unchanged since → the stored document wins (it can hold accepted
changes nobody saved yet); file changed meanwhile (edited outside the room) → the difference becomes one Owner change.
A participant's own changes wait in `collab_outbox` until acknowledged and are sent again after a reconnect. During a
short outage (the connection recovers within its grace period) typing goes on; once the session has ended the document
is read-only until the rejoin and **keeps the shared text**. Phase 10 fixed a data-loss bug here: the read-only view
wrote the open-time snapshot back into the still-bound model, the binding turned that into deletions, and the rejoin
sent them — erasing everyone's unsaved edits on the Owner too. A model that has followed the live document now never
takes a snapshot again (`collabModels.markLive`/`wasLive`, set by `CollabBinding`; regression test
`virtualTextPreview.test.tsx`).

**After the Owner's app crashes or restarts** (stabilization phase, found by a hard-kill test): when hosting resumes,
every document whose stored state holds accepted changes the file on disk doesn't have (the file still matches its
baseline) is loaded at once and handed to the Owner's editor (`docs_recover`), so the Owner sees the recovered text as
unsaved changes and saves it — instead of editing the older text from disk (which, saved first, would count as an outside
edit and drop the accepted changes). Text a participant typed in the last ~40 ms before its own app was killed (still
in the editor's send batch, never acknowledged) is lost like any unsaved typing at a crash; anything acknowledged is not.
High-priority regression tests: `collabDocService.test.ts` ("DATA-LOSS REGRESSION", the Owner crash cases),
`ownerMerge.test.ts`, `virtualTextPreview.test.tsx`, `host/docs_tests.rs`
(`unsaved_accepted_changes_survive_a_restart…`, `resuming_hosting_hands_unsaved_accepted_changes_back…`).

## The Owner's editor

When a participant opens a file (or hosting resumes with recovered changes), the Owner's editor document for it is held
and bound to the same CRDT. **Nothing typed is lost** (`ownerMerge.ts`, from the editor's saved text, its current text and
the shared text): the editor's unsaved edits become one Owner change when the shared document still equals the saved
text; the shared text wins when the editor has no edits of its own (the document becomes dirty); edits in different
places are both kept; overlapping edits keep the shared text in the editor and the Owner's text in a new unsaved tab,
with a notice. (Before this phase the editor's unsaved text simply replaced the shared document, which after an Owner
crash erased accepted changes.) The Owner's typing is sent
like anyone's; others' edits arrive through `y-monaco` into the same model (dirty state as usual). Files changing on
disk while bound go through the editor's existing file sync (a clean buffer reloads → that is the Owner's change); while
not bound, the Owner applies the file's new text as an Owner change itself. A save writes the same text the document
has, so the watcher sees no difference — no loop.

## Undo, rename, delete

Undo/redo of a collaborative model use a Yjs `UndoManager` that tracks only this window's own binding: another
member's edits never enter your undo history (the model's `undo`/`redo`, which every editor undo command calls, are
routed there while bound). A rename keeps the document (same file id); the participant's tab shows the new name. A
delete closes the document for everyone (`DocClosed deleted`), late changes are refused, the history stays stored, and
nothing recreates the file.

## Measured (one Windows PC, real WebRTC on loopback, debug build)

| | |
| --- | --- |
| join + first document sync on the local route | ~1.0 s (mostly the 2.5 s-bounded discovery answering) |
| typing: send → stored → acknowledged | 1.9 ms per keystroke (100 in a row) |
| 200 KB paste (several chunks) | 81 ms to stored, then forwarded |
| reopen after an Owner restart (snapshot + updates) | ~1.0 s including rejoin |

## Limits

- Text files only, up to 1 M UTF-16 units; larger or binary files stay read-only snapshots.
- Remote cursors, selections and presence: phase 7 (Awareness isn't wired).
- After a file changes outside the room while unsaved remote edits exist, the file's version wins (the history keeps
  both).
- Physical two-computer LAN validation is still pending (see `collaboration-local-network.md`); TURN landed in phase 10.
