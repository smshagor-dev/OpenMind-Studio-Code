#[derive(Debug, thiserror::Error)]
pub enum SettingsError {
    #[error("database error")]
    Db(#[from] openmind_db::DbError),
}
