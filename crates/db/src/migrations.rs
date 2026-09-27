//! The embedded migrations, and the one repair OpenMind makes to sqlx's own bookkeeping table.

use sha2::{Digest, Sha384};
use sqlx::migrate::Migrator;
use sqlx::{Row, SqlitePool};

/// `migrations/*.sql`, embedded at compile time (`build.rs` makes Cargo rebuild when one changes).
pub static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

/// A migration whose stored checksum was replaced because it differed from this build's only by line endings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChecksumRepair {
    pub version: i64,
    pub old_checksum: String,
    pub new_checksum: String,
}

/// sqlx stores the SHA-384 of every applied migration's bytes and refuses to start when they differ from the
/// embedded ones. Until `.gitattributes` pinned `*.sql` to LF, a checkout could hold the migrations with CRLF
/// endings, so a database created by one build could be refused by another although the SQL is the same.
///
/// For each applied migration whose stored checksum differs from this build's, the stored checksum is replaced
/// only when it is exactly the SHA-384 of this build's SQL with LF or with CRLF line endings — proof that the
/// applied SQL is the same text. Anything else (a real change) is left alone, and sqlx then reports the mismatch.
/// Nothing but that one column of `_sqlx_migrations` is written, and each repair is logged.
pub async fn repair_line_ending_checksums(
    pool: &SqlitePool,
    migrator: &Migrator,
) -> Result<Vec<ChecksumRepair>, sqlx::Error> {
    let has_table = sqlx::query(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
    )
    .fetch_optional(pool)
    .await?
    .is_some();
    if !has_table {
        return Ok(Vec::new());
    }
    let rows = sqlx::query("SELECT version, checksum FROM _sqlx_migrations WHERE success = 1")
        .fetch_all(pool)
        .await?;
    let mut repairs = Vec::new();
    for row in rows {
        let version: i64 = row.try_get(0)?;
        let stored: Vec<u8> = row.try_get(1)?;
        let Some(migration) = migrator
            .iter()
            .find(|m| m.version == version && !m.migration_type.is_down_migration())
        else {
            continue;
        };
        let current: &[u8] = migration.checksum.as_ref();
        if stored == current || !same_sql_other_line_endings(&migration.sql, &stored) {
            continue;
        }
        sqlx::query(
            "UPDATE _sqlx_migrations SET checksum = ?1 WHERE version = ?2 AND checksum = ?3",
        )
        .bind(current)
        .bind(version)
        .bind(&stored)
        .execute(pool)
        .await?;
        let repair = ChecksumRepair {
            version,
            old_checksum: hex(&stored),
            new_checksum: hex(current),
        };
        tracing::warn!(
            version,
            old_checksum = %repair.old_checksum,
            new_checksum = %repair.new_checksum,
            "database migration checksum differed only by line endings (LF/CRLF); stored checksum updated to this build's"
        );
        repairs.push(repair);
    }
    Ok(repairs)
}

/// Whether `stored` is the SHA-384 of `sql` with LF or with CRLF line endings.
fn same_sql_other_line_endings(sql: &str, stored: &[u8]) -> bool {
    let lf = sql.replace("\r\n", "\n");
    let crlf = lf.replace('\n', "\r\n");
    [lf, crlf]
        .iter()
        .any(|variant| Sha384::digest(variant.as_bytes()).as_slice() == stored)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
#[path = "migrations_tests.rs"]
mod tests;
