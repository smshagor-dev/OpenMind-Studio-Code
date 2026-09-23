#[derive(Debug, thiserror::Error)]
pub enum WorkspaceError {
    #[error("database error")]
    Db(#[from] openmind_db::DbError),

    #[error("failed to (de)serialize session state")]
    Session(#[from] serde_json::Error),
}
