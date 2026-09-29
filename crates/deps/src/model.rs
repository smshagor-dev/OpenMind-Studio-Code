//! What the Dependencies view shows for a workspace: per project folder, each ecosystem found with its declared
//! and installed packages, its environment and its setup gaps. Everything here was *read* from the folder — nothing
//! was run to find it.

use serde::Serialize;

/// Every project folder in the workspace (the language crate's bounded scan) with its dependencies.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepsSnapshot {
    pub projects: Vec<ProjectDeps>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDeps {
    /// Relative to the workspace, `/`-separated (`""` for the workspace itself).
    pub root: String,
    pub name: String,
    /// Absolute folder.
    pub path: String,
    pub python: Option<PythonInfo>,
    pub node: Option<NodeInfo>,
    pub php: Option<PhpInfo>,
    pub rust: Option<RustInfo>,
    pub java: Option<JavaInfo>,
    pub cmake: Option<CmakeInfo>,
    /// Incomplete setup worth offering to fix (never fixed by itself).
    pub setup: Vec<SetupHint>,
}

/// A declared dependency and, when it could be read, the installed version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dep {
    pub name: String,
    /// The version requirement as written (`^1.2.0`, `>=2.0`, empty when none).
    pub spec: String,
    /// `None` when not installed (or not readable).
    pub installed: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonInfo {
    /// `requirements.txt`, `pyproject.toml`, `setup.py`, `setup.cfg` — those that exist.
    pub manifests: Vec<String>,
    pub environments: Vec<PythonEnv>,
    /// Declared in `requirements.txt` / `pyproject.toml` `[project] dependencies`.
    pub requirements: Vec<Dep>,
    /// Declared requirements that aren't installed in the selected environment.
    pub missing: Vec<String>,
    /// Everything installed in the selected environment (from its `*.dist-info` folders).
    pub installed: Vec<Package>,
    /// Lines of the manifests that weren't understood (options, URLs, markers ...) — shown, not guessed.
    pub skipped: Vec<String>,
    pub notes: Vec<String>,
}

/// A project-local virtual environment (a folder with `pyvenv.cfg` and an interpreter).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonEnv {
    /// Folder name inside the project (`.venv`).
    pub name: String,
    pub interpreter: String,
    /// `version` from `pyvenv.cfg`.
    pub version: Option<String>,
    /// The base interpreter is OpenMind's portable Python (from `pyvenv.cfg` `home`).
    pub from_openmind: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeInfo {
    /// The package manager to use, when it is certain (`npm`, `pnpm`, `yarn`).
    pub package_manager: Option<String>,
    /// Why no single package manager could be picked (several lock files, or `packageManager` disagreeing).
    pub conflict: Option<String>,
    /// Lock files present.
    pub lockfiles: Vec<String>,
    pub dependencies: Vec<Dep>,
    pub dev_dependencies: Vec<Dep>,
    pub scripts: Vec<Script>,
    pub node_modules: bool,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Script {
    pub name: String,
    pub command: String,
    /// The name can be passed to the package manager safely (it never reaches a shell as text).
    pub runnable: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhpInfo {
    pub lock: bool,
    pub vendor: bool,
    pub require: Vec<Dep>,
    pub require_dev: Vec<Dep>,
    /// `php` and `ext-*` requirements: provided by PHP itself, not installed by Composer.
    pub platform: Vec<Dep>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RustInfo {
    pub name: Option<String>,
    pub version: Option<String>,
    pub edition: Option<String>,
    pub dependencies: Vec<Dep>,
    pub dev_dependencies: Vec<Dep>,
    pub features: Vec<String>,
    pub lock: bool,
    /// A `[workspace]`-only manifest (its members are the packages).
    pub workspace_only: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaInfo {
    pub maven: bool,
    pub gradle: bool,
    /// `build.gradle.kts` (Kotlin DSL).
    pub kotlin_dsl: bool,
    /// The project's Gradle wrapper (`gradlew.bat` / `gradlew`) — preferred over any installed Gradle.
    pub gradle_wrapper: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CmakeInfo {
    /// `configurePresets` names from `CMakePresets.json` that are safe to pass on.
    pub presets: Vec<String>,
    /// `build/CMakeCache.txt` exists (configured before).
    pub configured: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SetupKind {
    /// A Python project with no project environment.
    PythonNoEnv,
    /// `package.json` declares dependencies but `node_modules` is missing.
    NodeNotInstalled,
    /// `composer.json` requires packages but `vendor` is missing.
    ComposerNotInstalled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupHint {
    pub kind: SetupKind,
}
