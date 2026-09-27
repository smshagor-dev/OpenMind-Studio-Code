use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("failed to create database directory at {path}")]
    CreateDataDir {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("failed to connect to the database")]
    Connect(#[source] sqlx::Error),

    #[error("failed to run database migrations")]
    Migrate(#[source] sqlx::migrate::MigrateError),

    #[error("database query failed")]
    Query(#[source] sqlx::Error),
}

/// Why the database couldn't be opened, in terms a start-up error screen can explain. Derived from the error only:
/// nothing is read from the database to find it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum FailureKind {
    /// An applied migration's stored checksum differs from this build's (and not only by line endings).
    ChecksumMismatch {
        version: i64,
    },
    /// The database has a migration this build doesn't know: a newer build created it.
    UnknownMigration {
        version: i64,
    },
    /// A migration started earlier and never finished.
    PartialMigration {
        version: i64,
    },
    /// Running a migration failed.
    MigrationFailed {
        version: Option<i64>,
    },
    /// Another program holds the database.
    Locked,
    /// The file isn't a SQLite database or is damaged.
    Corrupt,
    /// The file or its folder can't be written.
    ReadOnly,
    /// The file can't be opened at all (missing rights, a folder in its place ...).
    CannotOpen,
    /// The disk is full.
    DiskFull,
    /// The data folder couldn't be created.
    CreateFolder,
    Other,
}

impl DbError {
    pub fn kind(&self) -> FailureKind {
        use sqlx::migrate::MigrateError as M;
        match self {
            DbError::CreateDataDir { .. } => FailureKind::CreateFolder,
            DbError::Connect(err) | DbError::Query(err) => sqlx_kind(err),
            DbError::Migrate(err) => match err {
                M::VersionMismatch(version) => FailureKind::ChecksumMismatch { version: *version },
                M::VersionMissing(version) => FailureKind::UnknownMigration { version: *version },
                M::Dirty(version) => FailureKind::PartialMigration { version: *version },
                M::Execute(inner) => match sqlx_kind(inner) {
                    FailureKind::Other => FailureKind::MigrationFailed { version: None },
                    kind => kind,
                },
                M::ExecuteMigration(inner, version) => match sqlx_kind(inner) {
                    FailureKind::Other => FailureKind::MigrationFailed {
                        version: Some(*version),
                    },
                    kind => kind,
                },
                _ => FailureKind::MigrationFailed { version: None },
            },
        }
    }
}

/// SQLite's primary result codes (the low byte of an extended code) for the failures worth naming.
fn sqlx_kind(err: &sqlx::Error) -> FailureKind {
    match err {
        sqlx::Error::Database(db) => {
            let primary = db
                .code()
                .and_then(|code| code.parse::<i64>().ok())
                .map(|code| code & 0xff);
            match primary {
                Some(5 | 6) => FailureKind::Locked,
                Some(11 | 26) => FailureKind::Corrupt,
                Some(8) => FailureKind::ReadOnly,
                Some(3 | 14 | 23) => FailureKind::CannotOpen,
                Some(13) => FailureKind::DiskFull,
                _ => FailureKind::Other,
            }
        }
        sqlx::Error::Io(_) => FailureKind::CannotOpen,
        _ => FailureKind::Other,
    }
}
