-- Milestone 24 (collaboration rooms). A new migration: 0001-0003 are applied by real installs and must not change.
-- These tables live in the same per-machine database as everything else (data/machines/<profile>/ or data/): there is
-- no separate or central collaboration database. Every machine keeps its own history of the rooms it created or
-- joined. Times are Unix milliseconds. Nothing here holds a Room Code in clear (the Owner's copy is DPAPI-protected)
-- or a private key (the collaboration identity lives DPAPI-protected in editor_settings).

CREATE TABLE collab_rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- The permanent room identity (never the shareable code).
    room_uid TEXT NOT NULL UNIQUE,
    -- 'created' (this machine hosts it) or 'joined'.
    relation TEXT NOT NULL CHECK (relation IN ('created', 'joined')),
    name TEXT NOT NULL,
    local_role TEXT NOT NULL,
    owner_peer TEXT NOT NULL,
    owner_public_key TEXT NOT NULL,
    -- Owner only: the current invite's hash and the code itself, protected (`dpapi1:`); NULL on a joined room.
    invite_hash TEXT,
    invite_secret TEXT,
    invite_generation INTEGER NOT NULL DEFAULT 0,
    locked INTEGER NOT NULL DEFAULT 0,
    approval_required INTEGER NOT NULL DEFAULT 0,
    default_role TEXT NOT NULL DEFAULT 'viewer',
    closed INTEGER NOT NULL DEFAULT 0,
    -- Owner only: the shared folder on this machine (never sent to anyone) and its display name.
    workspace_path TEXT,
    workspace_name TEXT,
    -- The audit chain's end, so a restarted Owner continues it.
    chain_next_seq INTEGER NOT NULL DEFAULT 1,
    chain_last_hash TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
    created_at INTEGER NOT NULL,
    first_joined_at INTEGER,
    last_joined_at INTEGER,
    last_seen_at INTEGER,
    archived INTEGER NOT NULL DEFAULT 0
);

-- One authenticated connection of one peer (on the Owner: each participant's; on a participant: its own).
CREATE TABLE collab_sessions (
    session_id TEXT PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES collab_rooms (id) ON DELETE CASCADE,
    peer TEXT NOT NULL,
    role TEXT NOT NULL,
    epoch INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    connected_at INTEGER,
    ended_at INTEGER,
    end_reason TEXT,
    last_event_seq INTEGER NOT NULL DEFAULT 0,
    manifest_version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX collab_sessions_by_room ON collab_sessions (room_id, started_at);

CREATE TABLE collab_members (
    room_id INTEGER NOT NULL REFERENCES collab_rooms (id) ON DELETE CASCADE,
    peer TEXT NOT NULL,
    public_key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'kicked', 'removed', 'banned')),
    force_muted INTEGER NOT NULL DEFAULT 0,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, peer)
);

-- Per-member permission overrides (lists of permission names as JSON arrays, so a renumbered enum can't change them).
CREATE TABLE collab_permissions (
    room_id INTEGER NOT NULL REFERENCES collab_rooms (id) ON DELETE CASCADE,
    peer TEXT NOT NULL,
    grant_list TEXT NOT NULL DEFAULT '[]',
    deny_list TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, peer)
);

-- The Owner's file id <-> relative path map (relative paths only; ids stay stable across restarts and renames).
CREATE TABLE collab_files (
    room_id INTEGER NOT NULL REFERENCES collab_rooms (id) ON DELETE CASCADE,
    file_id TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    path_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
    PRIMARY KEY (room_id, file_id),
    UNIQUE (room_id, path_key)
);

-- Human-readable, hash-chained room history. Never holds CRDT binaries (those are in collab_crdt_updates).
CREATE TABLE collab_action_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES collab_rooms (id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    event_id TEXT NOT NULL UNIQUE,
    session_id TEXT,
    actor_peer TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    kind TEXT NOT NULL,
    file_id TEXT,
    rel_path TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    at_ms INTEGER NOT NULL,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL,
    signature TEXT,
    UNIQUE (room_id, seq)
);

-- Exact accepted CRDT updates, in the order the Owner accepted them. `message_id` makes a resend idempotent.
CREATE TABLE collab_crdt_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES collab_rooms (id) ON DELETE CASCADE,
    file_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    origin_peer TEXT NOT NULL,
    update_data BLOB NOT NULL,
    received_at INTEGER NOT NULL,
    UNIQUE (room_id, message_id)
);
CREATE INDEX collab_crdt_updates_by_file ON collab_crdt_updates (room_id, file_id, id);

-- A document's full state up to and including update `covers_update_id`; recovery = latest snapshot + later updates.
CREATE TABLE collab_document_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES collab_rooms (id) ON DELETE CASCADE,
    file_id TEXT NOT NULL,
    state_data BLOB NOT NULL,
    state_vector BLOB NOT NULL,
    covers_update_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX collab_document_snapshots_by_file ON collab_document_snapshots (room_id, file_id, id);

-- Messages this machine sent and must keep until the Owner acknowledges them (resent after a crash or reconnect).
CREATE TABLE collab_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES collab_rooms (id) ON DELETE CASCADE,
    message_id TEXT NOT NULL UNIQUE,
    channel TEXT NOT NULL,
    payload BLOB NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'acked', 'rejected')),
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_attempt_at INTEGER,
    settled_at INTEGER,
    reject_reason TEXT
);
CREATE INDEX collab_outbox_pending ON collab_outbox (room_id, state, id);
