//! The models folder: `<models>/<model id>/<repository path>`. A model counts as downloaded only when every file has
//! its catalog size *and* was verified against its SHA-256 (recorded in `.openmind-verified.json` as each file passes),
//! so a half-finished or tampered download is never started.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::catalog::{safe_file_path, ModelEntry, ModelFile};
use crate::error::LlmError;

const VERIFIED: &str = ".openmind-verified.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Verified {
    /// `path:sha256` of each file that passed.
    files: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelState {
    NotDownloaded,
    /// Some bytes are on disk (a stopped download resumes from them).
    Partial,
    Ready,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModel {
    pub state: ModelState,
    pub bytes_on_disk: u64,
}

#[derive(Debug, Clone)]
pub struct ModelStore {
    dir: PathBuf,
}

fn key(file: &ModelFile) -> String {
    format!("{}:{}", file.path, file.sha256.to_ascii_lowercase())
}

impl ModelStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The model's own folder (the id is validated by the catalog, so it is a plain name).
    pub fn folder(&self, model: &ModelEntry) -> PathBuf {
        self.dir.join(&model.id)
    }

    pub fn file_path(&self, model: &ModelEntry, file: &ModelFile) -> Result<PathBuf, LlmError> {
        if !safe_file_path(&file.path) {
            return Err(LlmError::Catalog(format!("unsafe file path {}", file.path)));
        }
        let mut path = self.folder(model);
        for segment in file.path.split('/') {
            path.push(segment);
        }
        Ok(path)
    }

    fn verified(&self, model: &ModelEntry) -> Verified {
        fs::read_to_string(self.folder(model).join(VERIFIED))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    /// Whether `file` is complete and passed its checksum.
    pub fn is_verified(&self, model: &ModelEntry, file: &ModelFile) -> bool {
        let size_ok = self
            .file_path(model, file)
            .ok()
            .and_then(|p| fs::metadata(p).ok())
            .is_some_and(|m| m.len() == file.size_bytes);
        size_ok && self.verified(model).files.contains(&key(file))
    }

    pub fn mark_verified(&self, model: &ModelEntry, file: &ModelFile) -> Result<(), LlmError> {
        let mut verified = self.verified(model);
        let entry = key(file);
        if !verified.files.contains(&entry) {
            verified.files.push(entry);
        }
        let path = self.folder(model).join(VERIFIED);
        let text = serde_json::to_string_pretty(&verified)
            .map_err(|err| LlmError::Catalog(err.to_string()))?;
        let temp = path.with_extension("json.tmp");
        fs::write(&temp, text).map_err(|err| LlmError::io(&temp, err))?;
        fs::rename(&temp, &path).map_err(|err| LlmError::io(&path, err))
    }

    /// Bytes of this model already on disk, finished files and `.part` files alike.
    pub fn bytes_on_disk(&self, model: &ModelEntry) -> u64 {
        model
            .files
            .iter()
            .filter_map(|file| self.file_path(model, file).ok())
            .map(|path| {
                let mut part = path.clone().into_os_string();
                part.push(".part");
                let size = |p: &Path| fs::metadata(p).map(|m| m.len()).unwrap_or(0);
                size(&path).max(size(Path::new(&part)))
            })
            .sum()
    }

    pub fn local(&self, model: &ModelEntry) -> LocalModel {
        let bytes_on_disk = self.bytes_on_disk(model);
        let state = if model.files.iter().all(|f| self.is_verified(model, f)) {
            ModelState::Ready
        } else if bytes_on_disk > 0 {
            ModelState::Partial
        } else {
            ModelState::NotDownloaded
        };
        LocalModel {
            state,
            bytes_on_disk,
        }
    }

    /// The file to start the engine with, only for a fully verified model.
    pub fn ready_entry(&self, model: &ModelEntry) -> Result<PathBuf, LlmError> {
        if self.local(model).state != ModelState::Ready {
            return Err(LlmError::NotDownloaded(model.name.clone()));
        }
        self.file_path(model, model.entry_file())
    }

    /// Removes the model's folder, downloaded and partial files alike.
    pub fn delete(&self, model: &ModelEntry) -> Result<(), LlmError> {
        let folder = self.folder(model);
        if !folder.starts_with(&self.dir) || folder == self.dir {
            return Err(LlmError::Catalog(
                "refusing to delete outside the models folder".into(),
            ));
        }
        match fs::remove_dir_all(&folder) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(LlmError::io(&folder, err)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::Catalog;

    fn setup() -> (tempfile::TempDir, ModelStore, ModelEntry) {
        let dir = tempfile::tempdir().expect("tmp");
        let store = ModelStore::new(dir.path().join("models"));
        let mut model = Catalog::builtin()
            .expect("catalog")
            .get("nemotron-3-nano-4b-q4")
            .expect("nano")
            .clone();
        model.files[0].size_bytes = 5;
        (dir, store, model)
    }

    #[test]
    fn a_model_is_ready_only_after_every_file_is_verified() {
        let (_dir, store, model) = setup();
        assert_eq!(store.local(&model).state, ModelState::NotDownloaded);
        let path = store.file_path(&model, &model.files[0]).expect("path");
        fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        fs::write(&path, b"hello").expect("write");
        assert_eq!(store.local(&model).state, ModelState::Partial);
        assert!(store.ready_entry(&model).is_err());
        store.mark_verified(&model, &model.files[0]).expect("mark");
        assert_eq!(store.local(&model).state, ModelState::Ready);
        assert_eq!(store.ready_entry(&model).expect("entry"), path);
        // A file changed in size afterwards is no longer trusted.
        fs::write(&path, b"hello!").expect("write");
        assert_eq!(store.local(&model).state, ModelState::Partial);
    }

    #[test]
    fn partial_downloads_count_their_part_files() {
        let (_dir, store, model) = setup();
        let path = store.file_path(&model, &model.files[0]).expect("path");
        fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        let mut part = path.into_os_string();
        part.push(".part");
        fs::write(&part, b"abc").expect("write");
        assert_eq!(store.bytes_on_disk(&model), 3);
        assert_eq!(store.local(&model).state, ModelState::Partial);
    }

    #[test]
    fn delete_removes_only_the_models_folder() {
        let (dir, store, model) = setup();
        let keep = dir.path().join("models").join("other.txt");
        let path = store.file_path(&model, &model.files[0]).expect("path");
        fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        fs::write(&path, b"hello").expect("write");
        fs::write(&keep, b"x").expect("write");
        store.delete(&model).expect("delete");
        assert!(!store.folder(&model).exists());
        assert!(keep.exists());
        store.delete(&model).expect("deleting twice is fine");
    }
}
