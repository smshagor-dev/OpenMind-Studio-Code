//! The models OpenMind can download, as data (`catalog.json`, compiled in). Every file is pinned to a Hugging Face
//! commit and a SHA-256, so a download is exactly the file that was reviewed — never "whatever is there today".

use serde::{Deserialize, Serialize};

use crate::error::LlmError;

const BUILTIN: &str = include_str!("../catalog.json");

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct License {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelFile {
    /// Path inside the repository (forward slashes); also the path inside the model's folder.
    pub path: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: String,
    pub family: String,
    pub name: String,
    pub quant: String,
    pub publisher: String,
    pub description: String,
    pub total_params_b: f64,
    pub active_params_b: f64,
    /// The context window the engine is started with.
    pub context_tokens: u32,
    pub repo: String,
    pub revision: String,
    pub license: License,
    pub files: Vec<ModelFile>,
}

impl ModelEntry {
    pub fn size_bytes(&self) -> u64 {
        self.files.iter().map(|f| f.size_bytes).sum()
    }

    /// The file llama.cpp is given: the first part of a split model loads the rest by itself.
    pub fn entry_file(&self) -> &ModelFile {
        &self.files[0]
    }

    /// The download address of `file`, at the pinned commit.
    pub fn url(&self, file: &ModelFile) -> String {
        format!(
            "https://huggingface.co/{}/resolve/{}/{}",
            self.repo, self.revision, file.path
        )
    }

    /// A mixture of experts reads only its active parameters per token, which is what makes it usable on a processor.
    pub fn is_mixture_of_experts(&self) -> bool {
        self.active_params_b < self.total_params_b
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogFile {
    format: String,
    version: u32,
    models: Vec<ModelEntry>,
}

#[derive(Debug, Clone)]
pub struct Catalog {
    models: Vec<ModelEntry>,
}

impl Catalog {
    pub fn builtin() -> Result<Self, LlmError> {
        Self::parse(BUILTIN)
    }

    /// No models (what the app falls back to if the built-in list could not be read).
    pub fn empty() -> Self {
        Self { models: Vec::new() }
    }

    pub fn parse(text: &str) -> Result<Self, LlmError> {
        let file: CatalogFile =
            serde_json::from_str(text).map_err(|err| LlmError::Catalog(err.to_string()))?;
        if file.format != "openmind-llm-catalog" || file.version != 1 {
            return Err(LlmError::Catalog(format!(
                "unknown format {} version {}",
                file.format, file.version
            )));
        }
        let mut seen = std::collections::HashSet::new();
        for model in &file.models {
            validate(model)?;
            if !seen.insert(model.id.clone()) {
                return Err(LlmError::Catalog(format!(
                    "model {} is listed twice",
                    model.id
                )));
            }
        }
        Ok(Self {
            models: file.models,
        })
    }

    /// From the smallest to the largest (the order of the file).
    pub fn models(&self) -> &[ModelEntry] {
        &self.models
    }

    pub fn get(&self, id: &str) -> Result<&ModelEntry, LlmError> {
        self.models
            .iter()
            .find(|m| m.id == id)
            .ok_or_else(|| LlmError::UnknownModel(id.to_string()))
    }
}

fn safe_name(text: &str, extra: &str) -> bool {
    !text.is_empty()
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || extra.contains(c))
}

fn is_hex(text: &str, len: usize) -> bool {
    text.len() == len && text.chars().all(|c| c.is_ascii_hexdigit())
}

/// A repository file path that stays inside the model's folder: relative, forward slashes, no `..`, a `.gguf` file.
pub fn safe_file_path(path: &str) -> bool {
    !path.starts_with('/')
        && path.ends_with(".gguf")
        && path
            .split('/')
            .all(|segment| safe_name(segment, "._-") && segment != "." && segment != "..")
}

fn validate(model: &ModelEntry) -> Result<(), LlmError> {
    let fail = |what: &str| Err(LlmError::Catalog(format!("model {}: {what}", model.id)));
    if !safe_name(&model.id, ".-") {
        return fail("the id may only have letters, digits, '.' and '-'");
    }
    let mut repo = model.repo.split('/');
    let (Some(owner), Some(name), None) = (repo.next(), repo.next(), repo.next()) else {
        return fail("the repository must be owner/name");
    };
    if !safe_name(owner, "._-") || !safe_name(name, "._-") {
        return fail("the repository name has characters it can't have");
    }
    if !is_hex(&model.revision, 40) {
        return fail("the revision must be a full commit hash");
    }
    if model.files.is_empty() {
        return fail("it has no files");
    }
    for file in &model.files {
        if !safe_file_path(&file.path) {
            return fail("a file path is not a plain relative .gguf path");
        }
        if !is_hex(&file.sha256, 64) || file.size_bytes == 0 {
            return fail("a file needs its size and SHA-256");
        }
    }
    if model.context_tokens < 2048 || model.active_params_b <= 0.0 {
        return fail("the context or parameter count is not plausible");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_builtin_catalog_is_valid_and_ordered_small_to_large() {
        let catalog = Catalog::builtin().expect("catalog");
        assert!(catalog.models().len() >= 4);
        let sizes: Vec<u64> = catalog
            .models()
            .iter()
            .map(ModelEntry::size_bytes)
            .collect();
        let mut sorted = sizes.clone();
        sorted.sort_unstable();
        assert_eq!(sizes, sorted);
        assert!(catalog
            .models()
            .iter()
            .all(|m| m.family.contains("Nemotron")));
    }

    #[test]
    fn the_url_is_pinned_to_the_commit() {
        let catalog = Catalog::builtin().expect("catalog");
        let model = catalog.get("nemotron-3-nano-4b-q4").expect("nano");
        assert_eq!(
            model.url(model.entry_file()),
            "https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-4B-GGUF/resolve/ba223d14e45525f7fae81db77ea8cabeb2fc6c25/NVIDIA-Nemotron3-Nano-4B-Q4_K_M.gguf"
        );
    }

    #[test]
    fn split_models_load_from_their_first_part() {
        let catalog = Catalog::builtin().expect("catalog");
        let model = catalog.get("nemotron-3-super-120b-a12b-q4").expect("super");
        assert!(model.entry_file().path.ends_with("-00001-of-00003.gguf"));
        assert!(model.is_mixture_of_experts());
    }

    #[test]
    fn file_paths_can_never_leave_the_model_folder() {
        for bad in [
            "../x.gguf",
            "/x.gguf",
            "a/../b.gguf",
            "a\\b.gguf",
            "x.exe",
            "a//b.gguf",
            "C:x.gguf",
        ] {
            assert!(!safe_file_path(bad), "{bad}");
        }
        assert!(safe_file_path("UD-Q4_K_XL/model-00001-of-00003.gguf"));
    }

    #[test]
    fn a_damaged_catalog_is_refused() {
        let text = BUILTIN.replace("ba223d14e45525f7fae81db77ea8cabeb2fc6c25", "main");
        assert!(matches!(Catalog::parse(&text), Err(LlmError::Catalog(_))));
        assert!(Catalog::parse("{}").is_err());
    }
}
