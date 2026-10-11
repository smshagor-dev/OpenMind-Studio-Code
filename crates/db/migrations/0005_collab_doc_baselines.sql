-- Milestone 24, phase 6: for each collaborative document, the SHA-256 of the file's bytes on disk the last time the
-- document's text and the file were known to be equal (after loading, after the Owner saved). When the document is
-- loaded again, an unchanged file means the stored document wins (it may hold accepted changes nobody saved yet); a
-- changed file means it was edited outside the room, and the difference becomes one Owner change.
CREATE TABLE collab_doc_baselines (
    room_id INTEGER NOT NULL REFERENCES collab_rooms (id) ON DELETE CASCADE,
    file_id TEXT NOT NULL,
    disk_sha256 TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, file_id)
);
