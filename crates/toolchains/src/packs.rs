//! Turns the static catalog plus `tools/toolchains.json` into what the app shows and uses: per tool, its versions
//! (at most `maxBundledVersions`, newest kept), which one is active and whether its program is really there.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::catalog::{known, Category, Known, KNOWN};
use crate::manifest::{self, is_safe_relative, ManifestTool, DEFAULT_MAX_VERSIONS};
use crate::version;

/// The platform this build runs on, as the manifest spells it.
pub fn current_platform() -> &'static str {
    if cfg!(all(windows, target_arch = "x86_64")) {
        "windows-x64"
    } else if cfg!(windows) {
        "windows-arm64"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "macos-arm64"
    } else if cfg!(target_os = "macos") {
        "macos-x64"
    } else if cfg!(target_arch = "aarch64") {
        "linux-arm64"
    } else {
        "linux-x64"
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VersionStatus {
    /// The selected version, and its program exists.
    Active,
    /// Present and usable, not selected.
    Bundled,
    /// Listed in the manifest but the program is missing from disk.
    Broken,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolStatus {
    /// A bundled version is selected and present.
    Active,
    /// Nothing bundled for this tool.
    Missing,
    /// Versions are listed, but the selected one (or all of them) is missing on disk.
    Broken,
    /// A large or non-redistributable tool the user installs; OpenMind only detects it.
    External,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionView {
    pub version: String,
    /// The absolute path of the program.
    pub path: String,
    pub status: VersionStatus,
    pub latest: bool,
    pub size_bytes: Option<u64>,
    pub license: Option<String>,
    pub license_url: Option<String>,
    pub verify_args: Option<Vec<String>>,
    /// Installed from Language Tools (`tools/installed.json`) rather than shipped with the app.
    pub installed: bool,
    /// Variables a process needs for it: name and absolute path.
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolView {
    pub id: String,
    pub name: String,
    pub category: Category,
    pub summary: String,
    pub details: String,
    pub used_by: Vec<String>,
    pub command: String,
    pub hint: String,
    pub status: ToolStatus,
    pub active_version: Option<String>,
    /// Newest first.
    pub versions: Vec<VersionView>,
    pub max_versions: usize,
    /// Versions the manifest listed beyond the cap (the oldest are ignored).
    pub ignored_versions: usize,
    /// The program of the active version.
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Packs {
    /// `<app>/tools`.
    pub tools_dir: String,
    pub platform: String,
    pub manifest_found: bool,
    /// Set when `toolchains.json` couldn't be read; the app carries on with nothing bundled.
    pub manifest_error: Option<String>,
    pub warnings: Vec<String>,
    pub tools: Vec<ToolView>,
}

/// The folders to put on the PATH of a process OpenMind starts (never the system PATH), and the variables an active
/// tool needs (absolute paths inside the app folder).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Injection {
    pub path_prepend: Vec<PathBuf>,
    pub env: Vec<(String, PathBuf)>,
}

/// Where the manifest lives.
pub fn manifest_path(app_root: &Path) -> PathBuf {
    app_root.join("tools").join("toolchains.json")
}

/// Where the tools installed from Language Tools are recorded (same format; written by the app's installer).
pub fn installed_path(app_root: &Path) -> PathBuf {
    app_root.join("tools").join("installed.json")
}

/// Adds the installed tools' versions to the manifest's (an installed version replaces a listed one of the same name).
fn merge_installed(manifest: &mut manifest::Manifest, installed: manifest::Manifest) {
    for tool in installed.tools {
        match manifest.tools.iter_mut().find(|entry| entry.id == tool.id) {
            Some(entry) => {
                for mut version in tool.versions {
                    version.installed = true;
                    entry.versions.retain(|v| v.version != version.version);
                    entry.versions.push(version);
                }
            }
            None => {
                let mut tool = tool;
                for version in &mut tool.versions {
                    version.installed = true;
                }
                manifest.tools.push(tool);
            }
        }
    }
}

/// Reads the manifest and builds the view. `chosen` = the user's active versions by tool id.
pub fn load(app_root: &Path, platform: &str, chosen: &HashMap<String, String>) -> Packs {
    let mut warnings = Vec::new();
    let mut manifest_error = None;
    let mut found = false;
    let manifest = match manifest::read(&manifest_path(app_root)) {
        Ok(Some(m)) => {
            found = true;
            m
        }
        Ok(None) => manifest::Manifest::default(),
        Err(err) => {
            tracing::warn!(%err, "ignoring the toolchain manifest");
            manifest_error = Some(err.to_string());
            found = true;
            manifest::Manifest::default()
        }
    };
    let mut manifest = manifest;
    match manifest::read(&installed_path(app_root)) {
        Ok(Some(installed)) => merge_installed(&mut manifest, installed),
        Ok(None) => {}
        Err(err) => warnings.push(format!("tools/installed.json was ignored: {err}")),
    }
    let mut tools: Vec<ToolView> = KNOWN
        .iter()
        .map(|k| {
            let entry = manifest.tools.iter().find(|t| t.id == k.id);
            build(app_root, platform, k, entry, chosen, &mut warnings)
        })
        .collect();
    for entry in &manifest.tools {
        if known(&entry.id).is_none() {
            warnings.push(format!(
                "tools/toolchains.json lists \"{}\", which OpenMind doesn't know; it is ignored.",
                entry.id
            ));
        }
    }
    tools.sort_by_key(|t| category_order(t.category));
    Packs {
        tools_dir: app_root.join("tools").to_string_lossy().replace('\\', "/"),
        platform: platform.to_string(),
        manifest_found: found,
        manifest_error,
        warnings,
        tools,
    }
}

fn category_order(c: Category) -> u8 {
    match c {
        Category::Runtime => 0,
        Category::PackageManager => 1,
        Category::LanguageServer => 2,
        Category::Formatter => 3,
        Category::Linter => 4,
        Category::Debugger => 5,
        Category::Vcs => 6,
        Category::DatabaseTool => 7,
        Category::HelperTool => 8,
        Category::Sdk => 9,
    }
}

fn build(
    app_root: &Path,
    platform: &str,
    k: &Known,
    entry: Option<&ManifestTool>,
    chosen: &HashMap<String, String>,
    warnings: &mut Vec<String>,
) -> ToolView {
    let max = entry
        .and_then(|e| e.max_bundled_versions)
        .unwrap_or(DEFAULT_MAX_VERSIONS)
        .clamp(1, DEFAULT_MAX_VERSIONS.max(1));
    let mut listed: Vec<&manifest::ManifestVersion> = entry
        .map(|e| {
            e.versions
                .iter()
                .filter(|v| (v.bundled || v.installed) && v.platform == platform)
                .collect()
        })
        .unwrap_or_default();
    listed.retain(|v| {
        let ok = is_safe_relative(&v.path);
        if !ok {
            warnings.push(format!(
                "{} {}: the path \"{}\" is not inside the app folder; the version is ignored.",
                k.name, v.version, v.path
            ));
        }
        ok
    });
    listed.sort_by(|a, b| version::compare(&b.version, &a.version));
    listed.dedup_by(|a, b| a.version == b.version);
    let ignored = listed.len().saturating_sub(max);
    if ignored > 0 {
        warnings.push(format!(
            "{}: {} is more than {max} versions; the {ignored} oldest are ignored.",
            k.name,
            listed.len()
        ));
    }
    listed.truncate(max);

    let mut versions: Vec<VersionView> = listed
        .iter()
        .map(|v| {
            let program = app_root.join(&v.path);
            VersionView {
                version: v.version.clone(),
                path: program.to_string_lossy().replace('\\', "/"),
                status: if program.is_file() {
                    VersionStatus::Bundled
                } else {
                    VersionStatus::Broken
                },
                latest: false,
                size_bytes: v.size_bytes,
                license: v.license.clone(),
                license_url: v.license_url.clone(),
                verify_args: v.verify_args.clone(),
                installed: v.installed,
                env: v
                    .env
                    .iter()
                    .filter(|(_, path)| is_safe_relative(path))
                    .map(|(name, path)| {
                        (
                            name.clone(),
                            app_root.join(path).to_string_lossy().replace('\\', "/"),
                        )
                    })
                    .collect(),
            }
        })
        .collect();
    // The newest stable version that is really there is "latest".
    let latest = versions
        .iter()
        .position(|v| v.status == VersionStatus::Bundled && version::is_stable(&v.version))
        .or_else(|| {
            versions
                .iter()
                .position(|v| v.status == VersionStatus::Bundled)
        });
    if let Some(i) = latest {
        versions[i].latest = true;
    }
    let wanted = chosen
        .get(k.id)
        .or_else(|| entry.and_then(|e| e.active_version.as_ref()));
    let active_index = wanted
        .and_then(|w| {
            versions
                .iter()
                .position(|v| &v.version == w && v.status == VersionStatus::Bundled)
        })
        .or(latest);
    if let Some(i) = active_index {
        versions[i].status = VersionStatus::Active;
    }
    let broken = !versions.is_empty() && active_index.is_none();
    let status = if let Some(_i) = active_index {
        ToolStatus::Active
    } else if broken {
        ToolStatus::Broken
    } else if k.external {
        ToolStatus::External
    } else {
        ToolStatus::Missing
    };
    let active = active_index.map(|i| &versions[i]);
    ToolView {
        id: k.id.into(),
        name: k.name.into(),
        category: k.category,
        summary: k.summary.into(),
        details: k.details.into(),
        used_by: k.used_by.iter().map(|s| (*s).to_string()).collect(),
        command: k.command.into(),
        hint: k.hint.into(),
        status,
        active_version: active.map(|v| v.version.clone()),
        path: active.map(|v| v.path.clone()),
        max_versions: max,
        ignored_versions: ignored,
        versions,
    }
}

impl Packs {
    pub fn tool(&self, id: &str) -> Option<&ToolView> {
        self.tools.iter().find(|t| t.id == id)
    }

    /// The active, present program of a tool.
    pub fn active_program(&self, id: &str) -> Option<PathBuf> {
        let tool = self.tool(id)?;
        (tool.status == ToolStatus::Active)
            .then(|| tool.path.as_ref().map(PathBuf::from))
            .flatten()
    }

    /// The folders of every active bundled program, in category order. Only for processes OpenMind launches.
    /// A debugger's files are not a command, so they are left out.
    pub fn injection(&self) -> Injection {
        let mut env: Vec<(String, PathBuf)> = Vec::new();
        for tool in &self.tools {
            if tool.status != ToolStatus::Active {
                continue;
            }
            if let Some(version) = tool
                .versions
                .iter()
                .find(|v| v.status == VersionStatus::Active)
            {
                env.extend(
                    version
                        .env
                        .iter()
                        .map(|(name, path)| (name.clone(), PathBuf::from(path))),
                );
            }
        }
        let mut dirs: Vec<PathBuf> = Vec::new();
        for tool in self
            .tools
            .iter()
            .filter(|t| t.category != Category::Debugger)
        {
            if let Some(dir) = self
                .active_program(&tool.id)
                .and_then(|p| p.parent().map(Path::to_path_buf))
            {
                if !dirs.contains(&dir) {
                    dirs.push(dir);
                }
            }
        }
        Injection {
            path_prepend: dirs,
            env,
        }
    }

    /// Whether `version` of `id` can be chosen: it is listed and its program exists.
    pub fn can_select(&self, id: &str, version: &str) -> bool {
        self.tool(id).is_some_and(|t| {
            t.versions
                .iter()
                .any(|v| v.version == version && v.status != VersionStatus::Broken)
        })
    }
}
