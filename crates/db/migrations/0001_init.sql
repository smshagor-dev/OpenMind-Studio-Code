-- Openmind Studio base schema.
-- Everything persistent lives here (WAL mode, see openmind_db::Db::connect)
-- except project/workspace source files themselves.
--
-- Only `window_state` is read/written by application logic in Milestone 1.
-- The remaining tables are real schema for modules landing in later
-- milestones, created up front so migrations don't churn as each module
-- is implemented; no module reads/writes another module's table.

CREATE TABLE editor_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE opened_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    name TEXT,
    is_workspace_file INTEGER NOT NULL DEFAULT 0,
    last_opened_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_opened_projects_last_opened_at ON opened_projects (last_opened_at DESC);

CREATE TABLE workspace_settings (
    project_id INTEGER NOT NULL REFERENCES opened_projects (id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, key)
);

CREATE TABLE recent_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES opened_projects (id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    opened_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (project_id, path)
);
CREATE INDEX idx_recent_files_opened_at ON recent_files (opened_at DESC);

CREATE TABLE pinned_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    label TEXT,
    pinned_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE terminal_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES opened_projects (id) ON DELETE CASCADE,
    shell TEXT,
    command TEXT NOT NULL,
    executed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_terminal_history_executed_at ON terminal_history (executed_at DESC);

CREATE TABLE search_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL,
    is_regex INTEGER NOT NULL DEFAULT 0,
    searched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_search_history_searched_at ON search_history (searched_at DESC);

CREATE TABLE extensions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    publisher TEXT,
    version TEXT NOT NULL,
    source_path TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    installed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE installed_runtimes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    version TEXT NOT NULL,
    install_path TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 0,
    installed_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (kind, version)
);

CREATE TABLE ai_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE theme (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    theme_name TEXT NOT NULL DEFAULT 'dark',
    icon_theme_name TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE window_state (
    window_label TEXT PRIMARY KEY,
    width REAL NOT NULL,
    height REAL NOT NULL,
    x REAL,
    y REAL,
    maximized INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE keybindings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    command TEXT NOT NULL,
    key_combo TEXT NOT NULL,
    when_clause TEXT,
    source TEXT NOT NULL DEFAULT 'user',
    UNIQUE (command, key_combo, when_clause)
);

CREATE TABLE bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES opened_projects (id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    line INTEGER NOT NULL,
    label TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE breakpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES opened_projects (id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    line INTEGER NOT NULL,
    condition TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE git_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE session_restore (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    open_tabs TEXT NOT NULL DEFAULT '[]',
    active_project_id INTEGER REFERENCES opened_projects (id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE plugin_registry (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    manifest_path TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    registered_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE download_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    file_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    downloaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
