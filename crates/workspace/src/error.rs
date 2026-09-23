#[derive(Debug, thiserror::Error)]
pub enum WorkspaceError {
    #[error("database error")]
    Db(#[from] openmind_db::DbError),

    #[error("failed to (de)serialize workspace state")]
    Json(#[from] serde_json::Error),
}
