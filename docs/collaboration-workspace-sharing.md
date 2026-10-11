# Collaboration: remote workspace sharing (Milestone 24, phase 5)

How a participant browses the Owner's folder and opens files from it. Rooms, identities, authorization and the
WebRTC transport (phases 1–4) are described in the module documentation of `openmind-collab` and `openmind-collab-net`.
Real-time editing (CRDT), presence, voice and TURN are **not** part of this phase.

## Flow

```text
Participant admitted ──ManifestRequest──▶ Owner: authorize(file.read) ─▶ manifest (ids, names, sizes; no bodies)
                     ◀──ManifestPage × N──
Participant opens a file ──FileRequest{file_id, transfer_id}──▶ Owner: session ─ authorize ─ id lookup ─ privacy ─
                                                                 path safety (no link/junction) ─ consistent snapshot
                     ◀──FileMeta{size, sha256, chunks}── FileChunk × N ── FileComplete
Participant verifies every index/length and the SHA-256, then opens omcollab://<room id>/<file id> (read-only)
Owner's existing watcher ─ fs:changed batch ─ refresh_share ─▶ TreeDelta (or TreeReset) to every participant
```

Nothing is downloaded at join time: the participant receives the tree only.

## Manifest

Entries (`openmind_collab::manifest::ManifestEntry`): `id`, `parent`, `name`, `path` (workspace-relative, `/`
separators), `kind` (`file` | `folder`), `size`, `modifiedMs`, `binaryHint` (from the extension). The root is a display
name only — the Owner's absolute folder never appears in a message, an event or a document identity. A content hash is
not part of the manifest (it would mean reading every file); the hash travels with each transfer instead.

What is listed: the search index's crawl (`.gitignore`, `.openmindignore`, the always-excluded folders, links never
followed, hidden files included) filtered by the privacy floor in `openmind_collab::privacy` (`.git`, `node_modules`,
build output; `.env`, `.env.*` — including `.env.example` —, private keys, credentials …). A folder is listed when it
holds at least one shared file. Pages are at most 96 KB encoded / 4 096 entries, so any tree fits the data channel.

## File ids (`collab_files`)

- A file keeps its id while it stays at its path, and across a rename or move the watcher reported (a folder rename
  moves every id inside it; all moved rows are persisted, so ids survive an app restart).
- A path that disappears — deleted, now ignored, now sensitive — loses its id for good; requests for it answer
  *unavailable*.
- A path that appears — created, recreated after a delete, moved in from an ignored place, no longer ignored — gets a
  new random id. A recreated file is a new collaboration file.
- A rename the watcher could not pair (an overflowed burst) is a delete plus a create: new id.
- Paths are unique ignoring case (Windows); of two case-only twins the first wins.
- Ids are random 128-bit hex values per room; an id from another room, a guessed id, a deleted id, a hidden file and a
  path that now crosses a link or junction all answer the same *unavailable*.

## Transfers

| | Value | Why |
| --- | --- | --- |
| Data channel message limit | 120 KB (`MAX_CHANNEL_MESSAGE`) | the transport's existing limit; not raised |
| Chunk | 64 KB (~88 KB base64 in a frame) | fits the limit with room for the frame |
| Largest shared file | 16 MB | held whole in memory on both sides (that is what makes the hash exact) and must fit a Monaco model; source files are far smaller |
| Transfers per participant | 4 | |
| Transfers per room | 32 | |
| Snapshot bytes in flight (Owner) | 128 MB | |
| Bytes being received (participant) | 64 MB | |
| File requests per participant | burst 40, 20/s | |
| Manifest requests | 1 per second | |
| Requests for missing ids | 256, then disconnected | |
| Stall timeout | 60 s without progress | |

**Integrity.** `FileMeta` carries the SHA-256 of the exact bytes being sent. The receiver checks every chunk index and
length, refuses duplicates and indexes past the end, and hands the content out only after all chunks arrived *and* the
hash matched; otherwise the buffer is dropped and the file can be requested again.

**Consistent snapshots.** The Owner reads the file whole, then reads it again and must find the same bytes (and the same
size and modification time); otherwise it retries, three times at most, then answers *changed*. Size and time alone are
not enough on Windows (a path's metadata can lag behind a writer's handle). The hash always describes the bytes sent.

**Backpressure.** Each chunk waits until the files channel has less than 1 MB buffered (queued + SCTP), so a fast Owner
can't flood a slow participant; transfers run in their own tasks and never stall the network loop.

**Cancellation.** Closing the tab, cancelling, leaving the room, the Owner stopping, a disconnect or the file being
deleted mid-transfer end the transfer at once on both sides and free its buffers. While a file is loading, another
open or refresh of it is ignored (one transfer per file at a time). A failed transfer is simply requested again after
reconnecting (no byte-range resume).

## Remote documents (`omcollab:`)

A fetched text file (decoded like local files: BOM-sniffed UTF-8/UTF-16, else Windows-1252) opens through the read-only
custom-scheme tab extensions' file-system providers use, as `omcollab://<room id>/<file id>` — one Monaco model per
identity, reused when it is opened again. It is a **snapshot**: when a tree delta reports a new size or time for its
file the tab shows *changed by the Owner* with Refresh; when the file leaves the tree or the room disconnects it shows
*no longer available*. No content is pushed into an open document — phase 6 replaces snapshots with CRDT documents.
Binary files are never decoded ("remote preview of binary files is not supported yet"). Git, terminals, Run Code,
tasks and language servers never act on these documents. The `omcollab://` address is internal: tabs, their tooltips, breadcrumbs and Open Editors
show "shared folder / path inside it" instead (`src/components/remoteTabPath.ts`, stabilization phase; before, the
breadcrumbs showed the room and file ids).

## Live tree updates

The Owner's existing project watcher (`commands::watch`) also calls `commands::collab::net_share::files_changed`. For
each room this folder hosts on the network, the batch's renames are queued and the share is re-read
(`CollabRuntime::refresh_share`); the delta goes out with `OwnerNetwork::tree_changed`. At most one re-read runs per
room with one pending (renames merged), so a large checkout costs one or two crawls. A delta larger than one message is
sent as a reset and participants fetch the manifest again. No second watcher, no polling.

## Not done / limits

- TURN landed in phase 10 (`collaboration-connectivity.md`); cross-network validation is still pending.
- Automated tests run on loopback WebRTC only; no two-machine or NAT test was performed.
- No collaboration panel yet: the participant tree is a service (`RemoteWorkspaceService`) with typed IPC, not a view.
- Files over 16 MB are reported as too large, not streamed.
