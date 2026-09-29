//! Profiles (Milestone 16): named sets of user settings that can be switched, renamed, duplicated, exported and
//! imported. Everything lives in `settings/profiles/` next to the app (`<id>.json` per profile and `active.json`), so a
//! profile moves with the app folder and is ready for a future sync (`format` + `version` + timestamps in every file)
//! without any account or network.
//!
//! **What a profile holds is a fixed list of settings** ([`PROFILE_SETTINGS`]: appearance, editor, formatting, auto
//! save, search indexing, the AI master switch, marketplace auto-load, the terminal font ...) plus the user's
//! keybindings. Extensions, runtimes, keys and passwords are not part of a profile. Switching writes those settings into
//! the user's `settings.json` and the profile's shortcuts into `keybindings.json` after saving the current values into
//! the profile being left, so nothing is lost. A profile file that is damaged or unknown is skipped and never overwritten.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use thiserror::Error;

use crate::keybindings::{self, KeybindingEntry};
use crate::schema::{self, Extras};
use crate::store;

pub const FORMAT: &str = "openmind-profile";
pub const VERSION: u32 = 1;
pub const DEFAULT_ID: &str = "default";
const MAX_FILE_BYTES: usize = 256 * 1024;
const MAX_NAME_CHARS: usize = 40;

/// The settings a profile carries. All are user-scope settings that hold no secret and no path.
pub const PROFILE_SETTINGS: &[&str] = &[
    "workbench.colorTheme",
    "workbench.iconTheme",
    "editor.fontSize",
    "editor.fontFamily",
    "editor.tabSize",
    "editor.insertSpaces",
    "editor.wordWrap",
    "editor.minimap",
    "editor.lineNumbers",
    "editor.stickyScroll",
    "editor.renderWhitespace",
    "editor.formatOnSave",
    "files.autoSave",
    "files.autoSaveDelay",
    "terminal.fontSize",
    "terminal.scrollback",
    "search.indexing.enabled",
    "ai.enabled",
    "extensions.marketplace.autoFetch",
    "lsp.enabled",
    "git.autoRefresh",
];

#[derive(Debug, Error)]
pub enum ProfileError {
    #[error("{0}")]
    Invalid(String),
    #[error("There is no profile called \"{0}\".")]
    Missing(String),
    #[error("Couldn't read or write the profile files: {0}")]
    Io(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub format: String,
    pub version: u32,
    pub id: String,
    pub name: String,
    /// Seconds since 1970 (for conflict-safe comparison by a future sync).
    pub created_at: u64,
    pub updated_at: u64,
    pub settings: Map<String, Value>,
    #[serde(default)]
    pub keybindings: Vec<KeybindingEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSummary {
    pub id: String,
    pub name: String,
    pub active: bool,
    pub setting_count: usize,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileList {
    pub profiles: Vec<ProfileSummary>,
    pub active: String,
    /// Files that were skipped because they are damaged or unknown.
    pub problems: Vec<String>,
    /// The settings a profile carries (so the UI never claims more).
    pub covers: Vec<String>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn io(err: impl std::fmt::Display) -> ProfileError {
    ProfileError::Io(err.to_string())
}

/// A profile's name: 1-40 characters, no control characters, trimmed.
pub fn clean_name(name: &str) -> Result<String, ProfileError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(ProfileError::Invalid("A profile needs a name.".into()));
    }
    if trimmed.chars().count() > MAX_NAME_CHARS {
        return Err(ProfileError::Invalid(format!(
            "A profile name can have at most {MAX_NAME_CHARS} characters."
        )));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(ProfileError::Invalid(
            "A profile name can't contain control characters.".into(),
        ));
    }
    Ok(trimmed.to_string())
}

fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "profile".into()
    } else {
        trimmed.chars().take(30).collect()
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 40
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A value that names a place on this computer (a drive path or a UNC path): never exported or imported.
pub fn looks_like_absolute_path(text: &str) -> bool {
    let bytes = text.as_bytes();
    let drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    drive
        || text.starts_with("\\\\")
        || (text.starts_with('/') && !text.starts_with("//") && text.len() > 1)
}

/// Keeps only the profile settings of `values` that are valid and hold no local path.
pub fn snapshot(values: &Map<String, Value>) -> Map<String, Value> {
    let extras = Extras::default();
    let mut out = Map::new();
    for id in PROFILE_SETTINGS {
        let Some(value) = values.get(*id) else {
            continue;
        };
        if value.as_str().is_some_and(looks_like_absolute_path) {
            continue;
        }
        let Some(def) = schema::find(id, &extras) else {
            continue;
        };
        if let Ok(checked) = schema::validate(&def, value) {
            out.insert((*id).to_string(), checked);
        }
    }
    out
}

pub fn keybindings_snapshot(entries: &[KeybindingEntry]) -> Vec<KeybindingEntry> {
    keybindings::normalize_entries(entries).unwrap_or_default()
}

fn preset(id: &str, name: &str, settings: Value) -> Profile {
    let t = now();
    Profile {
        format: FORMAT.into(),
        version: VERSION,
        id: id.into(),
        name: name.into(),
        created_at: t,
        updated_at: t,
        settings: settings.as_object().cloned().unwrap_or_default(),
        keybindings: Vec::new(),
    }
}

/// The ready-made profiles (every value is checked against the schema by a test).
pub fn presets() -> Vec<Profile> {
    vec![
        preset(
            "web-development",
            "Web Development",
            json!({
                "editor.tabSize": 2, "editor.insertSpaces": true, "editor.formatOnSave": true,
                "editor.minimap": true, "workbench.iconTheme": "material",
                "extensions.marketplace.autoFetch": true
            }),
        ),
        preset(
            "python",
            "Python",
            json!({
                "editor.tabSize": 4, "editor.insertSpaces": true, "editor.formatOnSave": true,
                "editor.stickyScroll": true, "workbench.iconTheme": "material"
            }),
        ),
        preset(
            "php-laravel",
            "PHP / Laravel",
            json!({
                "editor.tabSize": 4, "editor.insertSpaces": true, "editor.formatOnSave": true,
                "workbench.iconTheme": "material", "search.indexing.enabled": true
            }),
        ),
        preset(
            "systems",
            "Systems (Rust / Go / C++)",
            json!({
                "editor.tabSize": 4, "editor.insertSpaces": true, "editor.stickyScroll": true,
                "editor.renderWhitespace": true, "workbench.iconTheme": "material",
                "search.indexing.enabled": true
            }),
        ),
        preset(
            "minimal",
            "Minimal / Low memory",
            json!({
                "editor.minimap": false, "editor.stickyScroll": false, "editor.renderWhitespace": false,
                "workbench.iconTheme": "minimal", "search.indexing.enabled": false,
                "ai.enabled": false, "extensions.marketplace.autoFetch": false,
                "files.autoSave": "off"
            }),
        ),
    ]
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActiveFile {
    format: String,
    version: u32,
    active: String,
    seeded: bool,
    updated_at: u64,
}

/// The `settings/profiles` folder.
pub struct ProfileStore {
    dir: PathBuf,
}

impl ProfileStore {
    pub fn new(settings_dir: &Path) -> Self {
        Self {
            dir: settings_dir.join("profiles"),
        }
    }

    fn path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    fn write(&self, path: &Path, text: &str) -> Result<(), ProfileError> {
        std::fs::create_dir_all(&self.dir).map_err(io)?;
        let temp = path.with_extension("json.tmp");
        std::fs::write(&temp, text).map_err(io)?;
        std::fs::rename(&temp, path).map_err(io)
    }

    fn read_active(&self) -> ActiveFile {
        let fallback = ActiveFile {
            format: FORMAT.into(),
            version: VERSION,
            active: DEFAULT_ID.into(),
            seeded: false,
            updated_at: 0,
        };
        std::fs::read_to_string(self.dir.join("active.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<ActiveFile>(&text).ok())
            .filter(|file| valid_id(&file.active))
            .unwrap_or(fallback)
    }

    fn write_active(&self, active: &str, seeded: bool) -> Result<(), ProfileError> {
        let file = ActiveFile {
            format: FORMAT.into(),
            version: VERSION,
            active: active.into(),
            seeded,
            updated_at: now(),
        };
        let text = serde_json::to_string_pretty(&file).map_err(io)?;
        self.write(&self.dir.join("active.json"), &text)
    }

    /// The active profile's id; falls back to Default when the file is missing or damaged, or names a missing profile.
    pub fn active_id(&self) -> String {
        let id = self.read_active().active;
        if self.path(&id).exists() {
            id
        } else {
            DEFAULT_ID.into()
        }
    }

    /// First run: Default = the user's current values, plus the ready-made profiles. Done once (deleting a ready-made
    /// profile keeps it deleted).
    pub fn ensure_seeded(
        &self,
        current: &Map<String, Value>,
        keybindings: &[KeybindingEntry],
    ) -> Result<(), ProfileError> {
        let active = self.read_active();
        if active.seeded {
            return Ok(());
        }
        if !self.path(DEFAULT_ID).exists() {
            let mut default = preset(DEFAULT_ID, "Default", json!({}));
            default.settings = snapshot(current);
            default.keybindings = keybindings_snapshot(keybindings);
            self.save(&default)?;
        }
        for profile in presets() {
            if !self.path(&profile.id).exists() {
                self.save(&profile)?;
            }
        }
        self.write_active(&active.active, true)
    }

    pub fn save(&self, profile: &Profile) -> Result<(), ProfileError> {
        if !valid_id(&profile.id) {
            return Err(ProfileError::Invalid("That profile id isn't valid.".into()));
        }
        let mut stored = profile.clone();
        stored.updated_at = now();
        let text = serde_json::to_string_pretty(&stored).map_err(io)?;
        self.write(&self.path(&profile.id), &format!("{text}\n"))
    }

    pub fn load(&self, id: &str) -> Result<Profile, ProfileError> {
        if !valid_id(id) {
            return Err(ProfileError::Missing(id.into()));
        }
        let text = std::fs::read_to_string(self.path(id))
            .map_err(|_| ProfileError::Missing(id.to_string()))?;
        parse_profile(&text, Some(id))
    }

    /// Every readable profile (Default first, then by name) and the files that were skipped.
    pub fn list(&self) -> (Vec<Profile>, Vec<String>) {
        let mut profiles = Vec::new();
        let mut problems = Vec::new();
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return (profiles, problems);
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.extension().is_none_or(|e| e != "json") || name == "active.json" {
                continue;
            }
            let id = name.trim_end_matches(".json").to_string();
            match std::fs::read_to_string(&path)
                .map_err(|e| e.to_string())
                .and_then(|text| parse_profile(&text, Some(&id)).map_err(|e| e.to_string()))
            {
                Ok(profile) => profiles.push(profile),
                Err(reason) => problems.push(format!("{name}: {reason}")),
            }
        }
        profiles.sort_by(|a, b| {
            (a.id != DEFAULT_ID, a.name.to_lowercase())
                .cmp(&(b.id != DEFAULT_ID, b.name.to_lowercase()))
        });
        (profiles, problems)
    }

    pub fn summary(&self) -> ProfileList {
        let (profiles, problems) = self.list();
        let active = if profiles.iter().any(|p| p.id == self.read_active().active) {
            self.read_active().active
        } else {
            DEFAULT_ID.into()
        };
        ProfileList {
            profiles: profiles
                .iter()
                .map(|p| ProfileSummary {
                    id: p.id.clone(),
                    name: p.name.clone(),
                    active: p.id == active,
                    setting_count: p.settings.len(),
                    updated_at: p.updated_at,
                })
                .collect(),
            active,
            problems,
            covers: PROFILE_SETTINGS.iter().map(|s| (*s).to_string()).collect(),
        }
    }

    fn unique_id(&self, name: &str) -> String {
        let base = slug(name);
        let mut candidate = base.clone();
        let mut n = 2;
        while self.path(&candidate).exists() || candidate == "active" {
            candidate = format!("{base}-{n}");
            n += 1;
        }
        candidate
    }

    fn name_taken(&self, name: &str, except: Option<&str>) -> bool {
        self.list()
            .0
            .iter()
            .any(|p| p.name.to_lowercase() == name.to_lowercase() && Some(p.id.as_str()) != except)
    }

    /// A new profile with these settings (already filtered by [`snapshot`]).
    pub fn create(
        &self,
        name: &str,
        settings: Map<String, Value>,
        keybindings: Vec<KeybindingEntry>,
    ) -> Result<Profile, ProfileError> {
        let name = clean_name(name)?;
        if self.name_taken(&name, None) {
            return Err(ProfileError::Invalid(format!(
                "There is already a profile called \"{name}\"."
            )));
        }
        let mut profile = preset(&self.unique_id(&name), &name, json!({}));
        profile.settings = snapshot(&settings);
        profile.keybindings = keybindings_snapshot(&keybindings);
        self.save(&profile)?;
        Ok(profile)
    }

    pub fn duplicate(&self, id: &str, name: &str) -> Result<Profile, ProfileError> {
        let source = self.load(id)?;
        self.create(name, source.settings, source.keybindings)
    }

    pub fn rename(&self, id: &str, name: &str) -> Result<Profile, ProfileError> {
        let name = clean_name(name)?;
        if self.name_taken(&name, Some(id)) {
            return Err(ProfileError::Invalid(format!(
                "There is already a profile called \"{name}\"."
            )));
        }
        let mut profile = self.load(id)?;
        profile.name = name;
        self.save(&profile)?;
        Ok(profile)
    }

    /// Deletes a profile. Default can't be deleted, and neither can the active one (switch away first).
    pub fn delete(&self, id: &str) -> Result<(), ProfileError> {
        if id == DEFAULT_ID {
            return Err(ProfileError::Invalid(
                "The Default profile can't be deleted.".into(),
            ));
        }
        self.load(id)?;
        if self.active_id() == id {
            return Err(ProfileError::Invalid(
                "This profile is in use. Switch to another profile first.".into(),
            ));
        }
        std::fs::remove_file(self.path(id)).map_err(io)
    }

    pub fn set_active(&self, id: &str) -> Result<(), ProfileError> {
        self.load(id)?;
        let seeded = self.read_active().seeded;
        self.write_active(id, seeded)
    }

    /// The file's text for sharing: the profile with only valid, path-free settings.
    pub fn export_text(&self, id: &str) -> Result<String, ProfileError> {
        let mut profile = self.load(id)?;
        profile.settings = snapshot(&profile.settings);
        profile.keybindings = keybindings_snapshot(&profile.keybindings);
        let text = serde_json::to_string_pretty(&profile).map_err(io)?;
        Ok(format!("{text}\n"))
    }

    /// Reads an exported profile as a new profile (a fresh id; a name in use gets a number).
    pub fn import_text(&self, text: &str) -> Result<Profile, ProfileError> {
        let parsed = parse_profile(text, None)?;
        let mut name = clean_name(&parsed.name)?;
        let mut n = 2;
        while self.name_taken(&name, None) {
            name = format!("{} ({n})", clean_name(&parsed.name)?);
            n += 1;
        }
        self.create(&name, parsed.settings, parsed.keybindings)
    }
}

/// Reads and checks a profile file's text. Unknown or invalid settings are dropped (never applied); a wrong format or
/// version, a bad size or damaged JSON is refused.
pub fn parse_profile(text: &str, expected_id: Option<&str>) -> Result<Profile, ProfileError> {
    if text.len() > MAX_FILE_BYTES {
        return Err(ProfileError::Invalid(
            "The profile file is too large.".into(),
        ));
    }
    let mut profile: Profile = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| ProfileError::Invalid(format!("Not a valid profile file: {e}")))?;
    if profile.format != FORMAT {
        return Err(ProfileError::Invalid(format!(
            "This isn't an OpenMind Studio profile (format \"{}\").",
            profile.format
        )));
    }
    if profile.version != VERSION {
        return Err(ProfileError::Invalid(format!(
            "This profile is version {}, but this app reads version {VERSION}.",
            profile.version
        )));
    }
    if let Some(id) = expected_id {
        profile.id = id.to_string();
    }
    profile.name = clean_name(&profile.name)?;
    profile.settings = snapshot(&profile.settings);
    profile.keybindings = keybindings_snapshot(&profile.keybindings);
    Ok(profile)
}

/// Makes the user's `settings.json` carry this profile: each profile setting it has is written, each it doesn't have
/// is removed (the default applies). Every other key in the file is kept.
pub fn apply(
    profile: &Profile,
    user_file: &Path,
    keybindings_file: &Path,
) -> Result<(), store::StoreError> {
    let extras = Extras::default();
    for id in PROFILE_SETTINGS {
        match profile.settings.get(*id) {
            Some(value) => {
                store::set_value(user_file, id, value, false, &extras)?;
            }
            None => store::reset_value(user_file, id, &extras)?,
        }
    }
    keybindings::write_file(keybindings_file, &profile.keybindings)
        .map(|_| ())
        .map_err(|err| store::StoreError::Invalid(err.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, ProfileStore) {
        let dir = tempfile::tempdir().expect("tmp");
        let store = ProfileStore::new(&dir.path().join("my settings"));
        (dir, store)
    }

    fn current() -> Map<String, Value> {
        json!({"editor.fontSize": 18, "workbench.colorTheme": "light", "some.unknown": 1})
            .as_object()
            .cloned()
            .expect("object")
    }

    fn binding(key: &str, command: &str) -> KeybindingEntry {
        KeybindingEntry {
            key: key.to_string(),
            command: command.to_string(),
        }
    }

    #[test]
    fn every_profile_setting_exists_and_carries_no_secret_or_path() {
        for id in PROFILE_SETTINGS {
            let def = schema::find(id, &Extras::default()).unwrap_or_else(|| panic!("{id}"));
            let lower = id.to_lowercase();
            assert!(
                !lower.contains("key") && !lower.contains("password") && !lower.contains("token"),
                "{id}"
            );
            assert!(
                !matches!(def.default, Value::String(ref s) if looks_like_absolute_path(s)),
                "{id}"
            );
        }
    }

    #[test]
    fn the_ready_made_profiles_use_valid_values_only() {
        for profile in presets() {
            for (id, value) in &profile.settings {
                assert!(
                    PROFILE_SETTINGS.contains(&id.as_str()),
                    "{} {id}",
                    profile.name
                );
                let def = schema::find(id, &Extras::default()).expect("defined");
                assert!(
                    schema::validate(&def, value).is_ok(),
                    "{} {id}",
                    profile.name
                );
            }
            assert_eq!(
                snapshot(&profile.settings).len(),
                profile.settings.len(),
                "{}",
                profile.name
            );
        }
        assert_eq!(presets().len(), 5);
    }

    #[test]
    fn first_run_seeds_default_from_the_current_values_and_the_five_presets_once() {
        let (_d, s) = store();
        let keys = [binding("ctrl+alt+s", "file.saveAll")];
        s.ensure_seeded(&current(), &keys).expect("seed");
        let list = s.summary();
        let names: Vec<&str> = list.profiles.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names[0], "Default");
        assert_eq!(list.profiles.len(), 6);
        for wanted in [
            "Web Development",
            "Python",
            "PHP / Laravel",
            "Systems (Rust / Go / C++)",
            "Minimal / Low memory",
        ] {
            assert!(names.contains(&wanted), "{wanted}");
        }
        let default = s.load(DEFAULT_ID).expect("default");
        assert_eq!(default.settings.get("editor.fontSize"), Some(&json!(18)));
        assert_eq!(default.keybindings, [binding("Ctrl+Alt+S", "file.saveAll")]);
        assert!(!default.settings.contains_key("some.unknown"));
        // A deleted ready-made profile stays deleted.
        s.delete("python").expect("delete");
        s.ensure_seeded(&current(), &[]).expect("again");
        assert_eq!(s.summary().profiles.len(), 5);
    }

    #[test]
    fn create_rename_duplicate_switch_and_delete() {
        let (_d, s) = store();
        s.ensure_seeded(&current(), &[]).expect("seed");
        let mine = s
            .create(
                "  My Setup ",
                snapshot(&current()),
                vec![binding("ctrl+alt+s", "file.saveAll")],
            )
            .expect("create");
        assert_eq!(
            (mine.id.as_str(), mine.name.as_str()),
            ("my-setup", "My Setup")
        );
        assert!(
            s.create("my setup", Map::new(), Vec::new()).is_err(),
            "names are unique, ignoring case"
        );
        let renamed = s.rename("my-setup", "Work").expect("rename");
        assert_eq!(renamed.name, "Work");
        let copy = s.duplicate("my-setup", "Work copy").expect("duplicate");
        assert_eq!(copy.settings, renamed.settings);
        assert_eq!(copy.keybindings, renamed.keybindings);
        s.set_active("my-setup").expect("active");
        assert_eq!(s.active_id(), "my-setup");
        assert!(
            s.delete("my-setup").is_err(),
            "the active profile can't be deleted"
        );
        s.set_active(DEFAULT_ID).expect("back");
        s.delete("my-setup").expect("delete");
        assert!(matches!(s.load("my-setup"), Err(ProfileError::Missing(_))));
    }

    #[test]
    fn default_can_never_be_deleted_and_names_are_checked() {
        let (_d, s) = store();
        s.ensure_seeded(&current(), &[]).expect("seed");
        assert!(s
            .delete(DEFAULT_ID)
            .expect_err("refused")
            .to_string()
            .contains("Default"));
        assert!(clean_name("   ").is_err());
        assert!(clean_name(&"x".repeat(41)).is_err());
        assert!(clean_name("bad\u{7}name").is_err());
        assert!(s.load("../evil").is_err(), "an id is never a path");
    }

    #[test]
    fn the_active_profile_persists_and_a_missing_or_damaged_active_file_falls_back_to_default() {
        let (dir, s) = store();
        s.ensure_seeded(&current(), &[]).expect("seed");
        s.set_active("minimal").expect("active");
        let again = ProfileStore::new(&dir.path().join("my settings"));
        assert_eq!(again.active_id(), "minimal");
        std::fs::write(
            dir.path().join("my settings/profiles/active.json"),
            "{ nope",
        )
        .expect("damage");
        assert_eq!(again.active_id(), DEFAULT_ID);
        std::fs::write(
            dir.path().join("my settings/profiles/active.json"),
            r#"{"format":"openmind-profile","version":1,"active":"gone","seeded":true,"updatedAt":1}"#,
        )
        .expect("gone");
        assert_eq!(again.active_id(), DEFAULT_ID);
    }

    #[test]
    fn a_damaged_profile_file_is_skipped_reported_and_never_overwritten() {
        let (dir, s) = store();
        s.ensure_seeded(&current(), &[]).expect("seed");
        let bad = dir.path().join("my settings/profiles/broken.json");
        std::fs::write(&bad, "{ not json").expect("write");
        std::fs::write(dir.path().join("my settings/profiles/wrong.json"), r#"{"format":"other","version":1,"id":"wrong","name":"x","createdAt":1,"updatedAt":1,"settings":{}}"#).expect("write");
        let list = s.summary();
        assert_eq!(list.profiles.len(), 6);
        assert_eq!(list.problems.len(), 2, "{:?}", list.problems);
        assert_eq!(std::fs::read_to_string(&bad).expect("read"), "{ not json");
    }

    #[test]
    fn export_keeps_only_valid_path_free_profile_settings() {
        let (_d, s) = store();
        s.ensure_seeded(&current(), &[]).expect("seed");
        let mut dirty = s.load(DEFAULT_ID).expect("default");
        dirty.settings.insert(
            "editor.fontFamily".into(),
            json!("C:\\Users\\me\\fonts\\x.ttf"),
        );
        dirty
            .settings
            .insert("ai.defaultProvider".into(), json!("secret-provider"));
        dirty.settings.insert("editor.fontSize".into(), json!(9999));
        s.save(&dirty).expect("save");
        let text = s.export_text(DEFAULT_ID).expect("export");
        let parsed: Value = serde_json::from_str(&text).expect("json");
        let settings = parsed["settings"].as_object().expect("settings");
        assert!(settings.contains_key("workbench.colorTheme"));
        assert!(
            !settings.contains_key("editor.fontFamily"),
            "a local path is not exported"
        );
        assert!(
            !settings.contains_key("ai.defaultProvider"),
            "not a profile setting"
        );
        assert!(
            !settings.contains_key("editor.fontSize"),
            "an invalid value is not exported"
        );
        for banned in ["password", "apiKey", "api_key", "C:\\\\", "dpapi"] {
            assert!(!text.contains(banned), "{banned}");
        }
    }

    #[test]
    fn import_validates_the_schema_and_fails_safely() {
        let (_d, s) = store();
        s.ensure_seeded(&current(), &[]).expect("seed");
        let text = s.export_text("minimal").expect("export");
        let imported = s.import_text(&text).expect("import");
        assert_eq!(
            imported.name, "Minimal / Low memory (2)",
            "a name in use gets a number"
        );
        assert_eq!(
            imported.settings.get("workbench.iconTheme"),
            Some(&json!("minimal"))
        );
        for bad in [
            "not json at all",
            "[]",
            r#"{"format":"openmind-profile","version":99,"id":"x","name":"x","createdAt":1,"updatedAt":1,"settings":{}}"#,
            r#"{"format":"something","version":1,"id":"x","name":"x","createdAt":1,"updatedAt":1,"settings":{}}"#,
        ] {
            assert!(s.import_text(bad).is_err(), "{bad}");
        }
        let hostile = r#"{"format":"openmind-profile","version":1,"id":"../../evil","name":"Hostile","createdAt":1,"updatedAt":1,
            "settings":{"editor.tabSize":"many","workbench.iconTheme":"material","ai.key.openai":"sk-123","editor.fontFamily":"/etc/passwd"},
            "keybindings":[{"key":"Ctrl+Alt+H","command":"hello.run"},{"key":"H","command":"bad"}]}"#;
        let p = s
            .import_text(hostile)
            .expect("imported with the bad parts dropped");
        assert_eq!(p.id, "hostile");
        assert_eq!(
            p.settings.keys().map(String::as_str).collect::<Vec<_>>(),
            ["workbench.iconTheme"]
        );
        assert!(
            p.keybindings.is_empty(),
            "invalid imported keybindings are dropped together"
        );
        assert!(s.import_text(&"x".repeat(300_000)).is_err());
    }

    #[test]
    fn switching_writes_the_profile_into_settings_json_and_keeps_every_other_key() {
        let dir = tempfile::tempdir().expect("tmp");
        let file = dir.path().join("settings").join("settings.json");
        let keybindings_file = dir.path().join("settings").join("keybindings.json");
        keybindings::write_file(&keybindings_file, &[binding("Ctrl+Alt+S", "file.saveAll")])
            .expect("keys");
        store::set_value(
            &file,
            "editor.fontSize",
            &json!(20),
            false,
            &Extras::default(),
        )
        .expect("set");
        store::set_value(
            &file,
            "search.include",
            &json!("*.rs"),
            false,
            &Extras::default(),
        )
        .expect("set");
        let minimal = presets()
            .into_iter()
            .find(|p| p.id == "minimal")
            .expect("minimal");
        apply(&minimal, &file, &keybindings_file).expect("apply");
        let layer = store::read_layer(&file);
        assert_eq!(
            layer.values.get("workbench.iconTheme"),
            Some(&json!("minimal"))
        );
        assert_eq!(layer.values.get("ai.enabled"), Some(&json!(false)));
        assert!(
            !layer.values.contains_key("editor.fontSize"),
            "not in the profile: back to the default"
        );
        assert_eq!(
            layer.values.get("search.include"),
            Some(&json!("*.rs")),
            "not a profile setting: kept"
        );
        assert_eq!(
            keybindings::read_file(&keybindings_file).entries,
            Vec::<KeybindingEntry>::new()
        );
    }

    #[test]
    fn profiles_live_in_the_settings_folder_next_to_the_app() {
        let (dir, s) = store();
        s.ensure_seeded(&current(), &[]).expect("seed");
        assert!(dir
            .path()
            .join("my settings/profiles/default.json")
            .exists());
        assert!(dir.path().join("my settings/profiles/active.json").exists());
    }
}
