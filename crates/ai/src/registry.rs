//! The list of configured providers, kept in one JSON file (`data/ai/providers.json`). It holds no secret:
//! API keys are stored separately by the app, encrypted, under the provider id.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::AiError;
use crate::provider::ProviderConfig;

#[derive(Debug, Default, Serialize, Deserialize)]
struct Document {
    #[serde(default)]
    providers: Vec<ProviderConfig>,
}

pub struct ProviderStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl ProviderStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    fn read(&self) -> Result<Document, AiError> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) if text.trim().is_empty() => Ok(Document::default()),
            Ok(text) => serde_json::from_str(&text).map_err(|err| {
                AiError::Storage(format!(
                    "The AI provider list is damaged and was left untouched: {err}"
                ))
            }),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Document::default()),
            Err(err) => Err(err.into()),
        }
    }

    fn write(&self, doc: &Document) -> Result<(), AiError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text =
            serde_json::to_string_pretty(doc).map_err(|err| AiError::Storage(err.to_string()))?;
        let temp = self.path.with_extension("json.tmp");
        std::fs::write(&temp, text)?;
        std::fs::rename(&temp, &self.path)?;
        Ok(())
    }

    fn locked(&self) -> Result<std::sync::MutexGuard<'_, ()>, AiError> {
        self.lock
            .lock()
            .map_err(|_| AiError::Storage("The AI provider list is busy.".to_string()))
    }

    pub fn list(&self) -> Result<Vec<ProviderConfig>, AiError> {
        let _guard = self.locked()?;
        Ok(self.read()?.providers)
    }

    pub fn get(&self, id: &str) -> Result<Option<ProviderConfig>, AiError> {
        Ok(self.list()?.into_iter().find(|p| p.id == id))
    }

    /// Adds the provider or replaces the one with the same id (after checking it).
    pub fn upsert(&self, config: ProviderConfig) -> Result<ProviderConfig, AiError> {
        let config = config.normalized()?;
        let _guard = self.locked()?;
        let mut doc = self.read()?;
        match doc.providers.iter_mut().find(|p| p.id == config.id) {
            Some(existing) => *existing = config.clone(),
            None => doc.providers.push(config.clone()),
        }
        self.write(&doc)?;
        Ok(config)
    }

    /// Removes the provider; false when there was none.
    pub fn delete(&self, id: &str) -> Result<bool, AiError> {
        let _guard = self.locked()?;
        let mut doc = self.read()?;
        let before = doc.providers.len();
        doc.providers.retain(|p| p.id != id);
        let removed = doc.providers.len() != before;
        if removed {
            self.write(&doc)?;
        }
        Ok(removed)
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<ProviderConfig, AiError> {
        let _guard = self.locked()?;
        let mut doc = self.read()?;
        let provider = doc
            .providers
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| AiError::InvalidProvider("That provider does not exist.".to_string()))?;
        provider.enabled = enabled;
        let updated = provider.clone();
        self.write(&doc)?;
        Ok(updated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{Capability, ProviderKind};

    fn provider(id: &str) -> ProviderConfig {
        ProviderConfig {
            id: id.into(),
            name: format!("Provider {id}"),
            kind: ProviderKind::OpenAiCompatible,
            base_url: String::new(),
            model: "gpt-x".into(),
            models: vec![],
            enabled: true,
            source: None,
            capabilities: vec![Capability::Chat],
        }
    }

    fn store() -> (tempfile::TempDir, ProviderStore) {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = ProviderStore::new(dir.path().join("ai").join("providers.json"));
        (dir, store)
    }

    #[test]
    fn add_update_and_delete() {
        let (_dir, store) = store();
        assert!(store.list().expect("list").is_empty());
        store.upsert(provider("a")).expect("add");
        store.upsert(provider("b")).expect("add");
        let mut changed = provider("a");
        changed.model = "other".into();
        store.upsert(changed).expect("update");
        let all = store.list().expect("list");
        assert_eq!(all.len(), 2);
        assert_eq!(store.get("a").expect("get").expect("some").model, "other");
        assert!(store.delete("a").expect("delete"));
        assert!(!store.delete("a").expect("delete again"));
        assert_eq!(store.list().expect("list").len(), 1);
    }

    #[test]
    fn enable_and_disable_persist() {
        let (_dir, store) = store();
        store.upsert(provider("a")).expect("add");
        store.set_enabled("a", false).expect("disable");
        assert!(!store.get("a").expect("get").expect("some").enabled);
        store.set_enabled("a", true).expect("enable");
        assert!(store.get("a").expect("get").expect("some").enabled);
        assert!(store.set_enabled("missing", true).is_err());
    }

    #[test]
    fn invalid_providers_are_refused_and_a_damaged_file_is_kept() {
        let (dir, store) = store();
        let mut bad = provider("a");
        bad.base_url = "http://example.com".into();
        assert!(store.upsert(bad).is_err());
        let path = dir.path().join("ai").join("providers.json");
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        std::fs::write(&path, "{ not json").expect("write");
        assert!(store.upsert(provider("a")).is_err());
        assert_eq!(std::fs::read_to_string(&path).expect("read"), "{ not json");
    }
}
