#[derive(Debug, thiserror::Error)]
pub enum SettingsError {
    #[error("database error")]
    Db(#[from] codeforge_db::DbError),
}
