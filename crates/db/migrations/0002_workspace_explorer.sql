-- Milestone 3 (Workspace Explorer): explorer tree UI state, plus a
-- monotonic touch counter on opened_projects. This is a new migration, not
-- an edit to 0001_init.sql — that file is already applied by real installs,
-- and editing it would change its checksum and break them (see CLAUDE.md's
-- Persistence section).

CREATE TABLE explorer_state (
    project_id INTEGER PRIMARY KEY REFERENCES opened_projects (id) ON DELETE CASCADE,
    expanded_paths TEXT NOT NULL DEFAULT '[]',
    selected_path TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- `datetime('now')` has one-second resolution, so ordering
-- `opened_projects` by `last_opened_at` alone ties when a project is
-- touched more than once within the same second. Unlike `recent_files`,
-- `opened_projects.id` must stay stable across touches (it's referenced by
-- foreign key from `session_restore.active_project_id` and
-- `explorer_state.project_id`), so re-touching can't delete+reinsert the
-- way `recent_files` does. A separate monotonic counter, bumped on every
-- touch, gives an exact ordering independent of both clock resolution and
-- row id.
ALTER TABLE opened_projects ADD COLUMN touch_seq INTEGER NOT NULL DEFAULT 0;
