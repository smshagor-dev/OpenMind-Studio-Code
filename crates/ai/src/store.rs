//! Conversations, kept on this machine in one SQLite file (`data/ai/conversations.sqlite`). Nothing here is ever
//! sent anywhere; the app only writes to it while "save conversation history" is on, and Clear deletes it all.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::error::AiError;

const MAX_MESSAGES: usize = 2000;
const MAX_CONTENT: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub provider_id: String,
    pub model: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub messages: Vec<StoredMessage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub provider_id: String,
    pub model: String,
    pub updated_at: i64,
    pub message_count: i64,
}

pub struct ConversationStore {
    connection: Mutex<Connection>,
}

impl ConversationStore {
    pub fn open(path: &Path) -> Result<Self, AiError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                model TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                error TEXT,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (conversation_id, position)
            );",
        )?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    fn conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, AiError> {
        self.connection
            .lock()
            .map_err(|_| AiError::Storage("The AI history is busy.".to_string()))
    }

    /// Stores the conversation, replacing what was saved under its id.
    pub fn save(&self, conversation: &Conversation) -> Result<(), AiError> {
        if conversation.id.is_empty() || conversation.id.len() > 80 {
            return Err(AiError::Storage("The conversation id is not valid.".into()));
        }
        if conversation.messages.len() > MAX_MESSAGES
            || conversation
                .messages
                .iter()
                .any(|m| m.content.len() > MAX_CONTENT)
        {
            return Err(AiError::Storage(
                "The conversation is too large to save.".into(),
            ));
        }
        let title: String = conversation.title.trim().chars().take(120).collect();
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO conversations (id, title, provider_id, model, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET title = ?2, provider_id = ?3, model = ?4, updated_at = ?6",
            params![
                conversation.id,
                title,
                conversation.provider_id,
                conversation.model,
                conversation.created_at,
                conversation.updated_at
            ],
        )?;
        tx.execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            params![conversation.id],
        )?;
        for (position, message) in conversation.messages.iter().enumerate() {
            tx.execute(
                "INSERT INTO messages (conversation_id, position, role, content, error, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    conversation.id,
                    i64::try_from(position).unwrap_or(i64::MAX),
                    message.role,
                    message.content,
                    message.error,
                    message.created_at
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Newest first.
    pub fn list(&self, limit: u32) -> Result<Vec<ConversationSummary>, AiError> {
        let conn = self.conn()?;
        let mut statement = conn.prepare(
            "SELECT c.id, c.title, c.provider_id, c.model, c.updated_at,
                    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id)
             FROM conversations c ORDER BY c.updated_at DESC LIMIT ?1",
        )?;
        let rows = statement.query_map(params![limit], |row| {
            Ok(ConversationSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                provider_id: row.get(2)?,
                model: row.get(3)?,
                updated_at: row.get(4)?,
                message_count: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn load(&self, id: &str) -> Result<Option<Conversation>, AiError> {
        let conn = self.conn()?;
        let head = conn
            .query_row(
                "SELECT title, provider_id, model, created_at, updated_at FROM conversations WHERE id = ?1",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                },
            )
            .map(Some)
            .or_else(|err| match err {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
        let Some((title, provider_id, model, created_at, updated_at)) = head else {
            return Ok(None);
        };
        let mut statement = conn.prepare(
            "SELECT role, content, error, created_at FROM messages
             WHERE conversation_id = ?1 ORDER BY position",
        )?;
        let messages = statement
            .query_map(params![id], |row| {
                Ok(StoredMessage {
                    role: row.get(0)?,
                    content: row.get(1)?,
                    error: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Some(Conversation {
            id: id.to_string(),
            title,
            provider_id,
            model,
            created_at,
            updated_at,
            messages,
        }))
    }

    pub fn delete(&self, id: &str) -> Result<bool, AiError> {
        let conn = self.conn()?;
        conn.execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            params![id],
        )?;
        Ok(conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])? > 0)
    }

    /// Deletes every conversation.
    pub fn clear_all(&self) -> Result<(), AiError> {
        let conn = self.conn()?;
        conn.execute_batch("DELETE FROM messages; DELETE FROM conversations;")?;
        conn.execute_batch("VACUUM;")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conversation(id: &str, at: i64) -> Conversation {
        Conversation {
            id: id.into(),
            title: format!("Chat {id}"),
            provider_id: "p".into(),
            model: "m".into(),
            created_at: at,
            updated_at: at,
            messages: vec![
                StoredMessage {
                    role: "user".into(),
                    content: "hi".into(),
                    error: None,
                    created_at: at,
                },
                StoredMessage {
                    role: "assistant".into(),
                    content: String::new(),
                    error: Some("boom".into()),
                    created_at: at,
                },
            ],
        }
    }

    fn store() -> (tempfile::TempDir, ConversationStore) {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = ConversationStore::open(&dir.path().join("ai").join("c.sqlite")).expect("open");
        (dir, store)
    }

    #[test]
    fn save_load_and_replace() {
        let (_dir, store) = store();
        store.save(&conversation("a", 1)).expect("save");
        let loaded = store.load("a").expect("load").expect("some");
        assert_eq!(loaded.messages.len(), 2);
        assert_eq!(loaded.messages[1].error.as_deref(), Some("boom"));
        let mut again = conversation("a", 1);
        again.updated_at = 5;
        again.messages.truncate(1);
        store.save(&again).expect("save again");
        let loaded = store.load("a").expect("load").expect("some");
        assert_eq!(loaded.messages.len(), 1);
        assert_eq!(loaded.updated_at, 5);
        assert!(store.load("missing").expect("load").is_none());
    }

    #[test]
    fn list_is_newest_first_and_delete_and_clear_work() {
        let (_dir, store) = store();
        store.save(&conversation("old", 1)).expect("save");
        store.save(&conversation("new", 9)).expect("save");
        let list = store.list(10).expect("list");
        assert_eq!(list[0].id, "new");
        assert_eq!(list[0].message_count, 2);
        assert!(store.delete("old").expect("delete"));
        assert_eq!(store.list(10).expect("list").len(), 1);
        store.clear_all().expect("clear");
        assert!(store.list(10).expect("list").is_empty());
    }

    #[test]
    fn a_conversation_survives_reopening_the_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("c.sqlite");
        ConversationStore::open(&path)
            .expect("open")
            .save(&conversation("a", 1))
            .expect("save");
        let reopened = ConversationStore::open(&path).expect("reopen");
        assert!(reopened.load("a").expect("load").is_some());
    }

    #[test]
    fn oversized_or_unnamed_conversations_are_refused() {
        let (_dir, store) = store();
        let mut big = conversation("a", 1);
        big.messages[0].content = "x".repeat(MAX_CONTENT + 1);
        assert!(store.save(&big).is_err());
        assert!(store.save(&conversation("", 1)).is_err());
    }
}
