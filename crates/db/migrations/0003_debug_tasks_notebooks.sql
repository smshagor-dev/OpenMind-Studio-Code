-- Milestone 19 (debug, tasks, notebooks). A new migration: 0001/0002 are applied by real installs and must not change.

-- Breakpoints gain a hit count condition and a log message (a logpoint); `condition` already exists in 0001.
ALTER TABLE breakpoints ADD COLUMN hit_condition TEXT;
ALTER TABLE breakpoints ADD COLUMN log_message TEXT;

-- A notebook is trusted for exactly the content the user trusted (its SHA-256); a changed file is untrusted again.
CREATE TABLE notebook_trust (
    path TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL,
    trusted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Local history of cells the user ran (no code or output is stored: the file itself holds those).
CREATE TABLE notebook_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    cell_index INTEGER NOT NULL,
    status TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    interpreter TEXT NOT NULL,
    ran_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX notebook_runs_by_path ON notebook_runs (path, id);
