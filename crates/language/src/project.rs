//! Project detection: what kind of project a folder is, found only from the names and small contents of files in
//! it. Nothing is executed and nothing outside the workspace is read. A folder can be several things at once (a
//! Tauri app with a React front end), and a folder that could be several different things is reported as
//! ambiguous with every candidate rather than guessed.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::commands::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StackGroup {
    Web,
    Backend,
    Desktop,
    Mobile,
    Systems,
    Devops,
    Data,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Confidence {
    /// A hint (an `index.html`, a dependency name in a text file).
    Low,
    /// A dependency or a marker that usually, not always, means it.
    Medium,
    /// A definitive marker file (`tauri.conf.json`, `artisan`, `go.mod`, `pubspec.yaml` with Flutter).
    High,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    pub id: String,
    pub name: String,
    pub group: StackGroup,
    pub confidence: Confidence,
    /// What was seen ("package.json depends on react").
    pub evidence: String,
}

pub fn det(
    id: &str,
    name: &str,
    group: StackGroup,
    confidence: Confidence,
    evidence: impl Into<String>,
) -> Detection {
    Detection {
        id: id.to_string(),
        name: name.to_string(),
        group,
        confidence,
        evidence: evidence.into(),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    /// The folder relative to the workspace, with forward slashes (`""` for the workspace itself).
    pub root: String,
    /// The folder's name (the workspace's for the root).
    pub name: String,
    pub detections: Vec<Detection>,
    /// npm, pnpm, yarn or bun for a Node project.
    pub package_manager: Option<String>,
    /// More than one different backend/framework could be meant and nothing settles it.
    pub ambiguous: bool,
    pub notes: Vec<String>,
    /// Every tool id the project's commands and stack need.
    pub tools: Vec<String>,
    pub commands: Vec<Command>,
}

impl Project {
    pub fn has(&self, id: &str) -> bool {
        self.detections.iter().any(|d| d.id == id)
    }

    /// "Tauri + React": the specific detections by confidence; the plain language/tool ones (Node.js, PHP, Python ...)
    /// only when nothing more specific was found.
    pub fn title(&self) -> String {
        const BASE: &[&str] = &[
            "node",
            "web-static",
            "php",
            "python",
            "ruby",
            "maven",
            "gradle",
            "dotnet",
            "dart",
        ];
        let mut sorted: Vec<&Detection> = self.detections.iter().collect();
        sorted.sort_by_key(|d| std::cmp::Reverse(d.confidence));
        let specific: Vec<&Detection> = sorted
            .iter()
            .copied()
            .filter(|d| !BASE.contains(&d.id.as_str()))
            .collect();
        let chosen = if specific.is_empty() {
            sorted
        } else {
            specific
        };
        let mut names: Vec<&str> = chosen.iter().map(|d| d.name.as_str()).collect();
        names.truncate(4);
        names.join(" + ")
    }
}

const MAX_FILE: u64 = 256 * 1024;

/// One folder as the detectors see it: its entry names (case-insensitively), and its small text files on request.
pub struct Dir {
    pub path: PathBuf,
    entries: Vec<String>,
    lower: HashSet<String>,
    pub package: Option<Value>,
}

impl Dir {
    pub fn open(path: &Path) -> Option<Self> {
        let read = std::fs::read_dir(path).ok()?;
        let entries: Vec<String> = read
            .filter_map(Result::ok)
            .take(4000)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect();
        let lower = entries.iter().map(|n| n.to_ascii_lowercase()).collect();
        let mut dir = Self {
            path: path.to_path_buf(),
            entries,
            lower,
            package: None,
        };
        dir.package = dir
            .read("package.json")
            .and_then(|text| serde_json::from_str(&text).ok());
        Some(dir)
    }

    pub fn has(&self, name: &str) -> bool {
        self.lower.contains(&name.to_ascii_lowercase())
    }

    pub fn has_any(&self, names: &[&str]) -> bool {
        names.iter().any(|n| self.has(n))
    }

    /// An entry that starts with `prefix` and ends with `suffix` (`vite.config` + any extension).
    pub fn find(&self, prefix: &str, suffix: &str) -> Option<&str> {
        let prefix = prefix.to_ascii_lowercase();
        let suffix = suffix.to_ascii_lowercase();
        self.entries.iter().map(String::as_str).find(|name| {
            let lower = name.to_ascii_lowercase();
            lower.starts_with(&prefix) && lower.ends_with(&suffix)
        })
    }

    /// The first entry named `<stem>.<js|ts|mjs|cjs|mts|cts|json>` (`vite.config`).
    pub fn config(&self, stem: &str) -> Option<&str> {
        ["js", "ts", "mjs", "cjs", "mts", "cts", "json"]
            .iter()
            .find_map(|ext| {
                let wanted = format!("{stem}.{ext}");
                self.entries
                    .iter()
                    .map(String::as_str)
                    .find(|n| n.eq_ignore_ascii_case(&wanted))
            })
    }

    pub fn is_dir(&self, name: &str) -> bool {
        self.entries
            .iter()
            .find(|entry| entry.eq_ignore_ascii_case(name))
            .is_some_and(|entry| {
                std::fs::symlink_metadata(self.path.join(entry)).is_ok_and(|m| m.is_dir())
            })
    }

    /// A small text file's contents (files over 256 KB and links are not read).
    pub fn read(&self, name: &str) -> Option<String> {
        let entry = self
            .entries
            .iter()
            .find(|entry| entry.eq_ignore_ascii_case(name))?;
        let path = self.path.join(entry);
        let meta = std::fs::symlink_metadata(&path).ok()?;
        if !meta.is_file() || meta.len() > MAX_FILE {
            return None;
        }
        std::fs::read(&path)
            .ok()
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
    }

    pub fn dep(&self, name: &str) -> bool {
        ["dependencies", "devDependencies", "peerDependencies"]
            .iter()
            .any(|section| {
                self.package
                    .as_ref()
                    .and_then(|p| p.get(section))
                    .and_then(Value::as_object)
                    .is_some_and(|deps| deps.contains_key(name))
            })
    }

    pub fn script(&self, name: &str) -> Option<String> {
        self.package
            .as_ref()?
            .get("scripts")?
            .get(name)?
            .as_str()
            .map(str::to_string)
    }

    pub fn scripts(&self) -> Vec<String> {
        self.package
            .as_ref()
            .and_then(|p| p.get("scripts"))
            .and_then(Value::as_object)
            .map(|scripts| scripts.keys().cloned().collect())
            .unwrap_or_default()
    }

    pub fn package_field(&self, field: &str) -> Option<&Value> {
        self.package.as_ref()?.get(field)
    }

    /// Whether `text` (lower-cased) mentions `word` — a cheap "depends on" test for manifests that aren't JSON.
    pub fn mentions(text: &str, word: &str) -> bool {
        text.to_ascii_lowercase()
            .contains(&word.to_ascii_lowercase())
    }
}

/// The package manager a Node project uses: `packageManager` in `package.json`, else its lock file, else npm.
pub fn package_manager(dir: &Dir) -> &'static str {
    let declared = dir
        .package_field("packageManager")
        .and_then(Value::as_str)
        .map(|s| s.split('@').next().unwrap_or(s).to_string());
    match declared.as_deref() {
        Some("pnpm") => return "pnpm",
        Some("yarn") => return "yarn",
        Some("bun") => return "bun",
        Some("npm") => return "npm",
        _ => {}
    }
    if dir.has("pnpm-lock.yaml") {
        "pnpm"
    } else if dir.has("yarn.lock") {
        "yarn"
    } else if dir.has("bun.lockb") || dir.has("bun.lock") {
        "bun"
    } else {
        "npm"
    }
}

/// Folders never entered: dependencies, build output, caches, VCS.
const SKIP: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    "vendor",
    ".venv",
    "venv",
    "env",
    "__pycache__",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".dart_tool",
    ".gradle",
    "bin",
    "obj",
    "pods",
    ".idea",
    ".vscode",
    "coverage",
    ".openmind",
];

const MAX_DEPTH: usize = 2;
const MAX_DIRS: usize = 400;
const MAX_PROJECTS: usize = 60;

/// Folders a parent project owns: a mobile or desktop project's platform folders (and an Android project's `app`
/// module) are not separate projects.
fn owned_children(detections: &[Detection]) -> Vec<&'static str> {
    let has = |id: &str| detections.iter().any(|d| d.id == id);
    let mut owned = Vec::new();
    if has("react-native") || has("expo") || has("flutter") || has("capacitor") || has("ionic") {
        owned.extend(["android", "ios", "macos", "windows", "linux", "web"]);
    }
    if has("tauri") {
        owned.push("src-tauri");
    }
    if has("android") {
        owned.push("app");
    }
    owned
}

/// Finds the projects under `root` (the folder itself and up to two levels of sub-folders). `platform` is only
/// used for notes that depend on the operating system.
pub fn detect_projects(root: &Path, platform: crate::tools::Os) -> Vec<Project> {
    let mut found = Vec::new();
    let mut visited = 0usize;
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut skip_dirs: HashSet<PathBuf> = HashSet::new();
    let root_name = root.file_name().map_or_else(
        || "workspace".to_string(),
        |n| n.to_string_lossy().into_owned(),
    );
    while let Some((path, depth)) = stack.pop() {
        if visited >= MAX_DIRS || found.len() >= MAX_PROJECTS {
            break;
        }
        visited += 1;
        if skip_dirs.contains(&path) {
            continue;
        }
        let Some(dir) = Dir::open(&path) else {
            continue;
        };
        let detections = crate::detect::detect_dir(&dir);
        let claimed = owned_children(&detections);
        if !detections.is_empty() {
            let relative = path
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            let name = if relative.is_empty() {
                root_name.clone()
            } else {
                relative.rsplit('/').next().unwrap_or(&relative).to_string()
            };
            found.push(crate::commands::assemble(
                &dir, relative, name, detections, platform,
            ));
        }
        for child in &claimed {
            skip_dirs.insert(path.join(child));
        }
        if depth < MAX_DEPTH {
            let mut children: Vec<PathBuf> = dir
                .subfolders()
                .into_iter()
                .filter(|name| {
                    !SKIP.contains(&name.to_ascii_lowercase().as_str()) && !name.starts_with('.')
                })
                .map(|name| path.join(name))
                .collect();
            children.sort();
            children.reverse();
            for child in children {
                stack.push((child, depth + 1));
            }
        }
    }
    found.sort_by(|a, b| a.root.cmp(&b.root));
    found
}

impl Dir {
    /// Real sub-folders (links are not followed).
    pub fn subfolders(&self) -> Vec<String> {
        self.entries
            .iter()
            .filter(|name| {
                std::fs::symlink_metadata(self.path.join(name)).is_ok_and(|m| m.is_dir())
            })
            .cloned()
            .collect()
    }
}
