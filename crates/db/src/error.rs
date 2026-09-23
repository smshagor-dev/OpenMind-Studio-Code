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
