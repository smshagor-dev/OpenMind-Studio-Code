use serde::{Deserialize, Serialize};

/// Folders the index never enters, whatever any ignore file says: dependency, build and cache output that would bury
/// real results and make indexing a real project slow. Compared case-insensitively against a folder's own name.
pub const INDEX_EXCLUDED_DIRS: [&str; 20] = [
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    "vendor",
    ".venv",
    "venv",
    "__pycache__",
    ".gradle",
    ".cache",
    ".npm",
    ".yarn",
    ".pnpm-store",
    ".openmind",
];

/// What the user can tune (the `search.*` settings); everything else is fixed and safe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IndexSettings {
    /// Index the open folder in the background.
    pub enabled: bool,
    /// Files larger than this are listed (searchable by name) but their text is not indexed.
    pub max_file_bytes: u64,
    /// Once the indexed text adds up to this, further files are listed but not indexed.
    pub max_total_bytes: u64,
    /// Honour `.gitignore` files (`.openmindignore` files are always honoured).
    pub use_gitignore: bool,
    /// Index files and folders whose name starts with a dot.
    pub index_hidden: bool,
    /// Extra globs (VS Code style) that are never indexed.
    pub exclude: Vec<String>,
}

impl Default for IndexSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            max_file_bytes: 1024 * 1024,
            max_total_bytes: 256 * 1024 * 1024,
            use_gitignore: true,
            index_hidden: false,
            exclude: Vec::new(),
        }
    }
}

impl IndexSettings {
    /// What decides which files are in the index and how: when it changes, every file is looked at again.
    pub fn signature(&self) -> String {
        format!(
            "v1|{}|{}|{}|{}|{}",
            self.max_file_bytes,
            self.max_total_bytes,
            self.use_gitignore,
            self.index_hidden,
            self.exclude.join("\u{1f}")
        )
    }
}
