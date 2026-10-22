//! Importable settings from VS Code's local user profiles. Import is opt-in:
//! no source files are modified, and credentials are never copied.
use std::fs;
use std::path::{Path, PathBuf};
use serde::Serialize;
use serde_json::Value;
use crate::{keybindings::{self, KeybindingEntry}, schema::{self, Extras}};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub edition: String,
    pub profile: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: String,
    pub value: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub source: Source,
    pub settings: Vec<Candidate>,
    pub keybindings: Vec<KeybindingEntry>,
    pub skipped: Vec<String>,
    pub extensions: Vec<String>,
    pub snippets: Vec<String>,
    pub warnings: Vec<String>,
}

fn editions() -> [(&'static str, &'static str); 4] {
    [("code", "Code"), ("insiders", "Code - Insiders"), ("codium", "VSCodium"), ("oss", "Code - OSS")]
}

fn config_root(edition: &str) -> Result<PathBuf, String> {
    let folder = editions().into_iter()
        .find(|(id, _)| *id == edition)
        .map(|(_, folder)| folder)
        .ok_or_else(|| "Unknown VS Code edition.".to_string())?;
    #[cfg(target_os = "windows")]
    let root = std::env::var_os("APPDATA").map(PathBuf::from)
        .ok_or_else(|| "APPDATA isn't configured.".to_string())?;
    #[cfg(target_os = "macos")]
    let root = std::env::var_os("HOME").map(PathBuf::from)
        .ok_or_else(|| "HOME isn't configured.".to_string())?
        .join("Library").join("Application Support");
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let root = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .ok_or_else(|| "Cannot locate the VS Code configuration directory.".to_string())?;
    Ok(root.join(folder).join("User"))
}

fn source_path(edition: &str, profile: &str) -> Result<PathBuf, String> {
    let root = config_root(edition)?;
    if profile == "default" { return Ok(root); }
    if profile.is_empty() || profile.len() > 80 || !profile.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err("Invalid profile identifier.".into());
    }
    let dir = root.join("profiles").join(profile);
    // Reject junction and symlink escapes if a profile folder is manipulated.
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let canonical_dir = dir.canonicalize().map_err(|e| e.to_string())?;
    if !canonical_dir.starts_with(&canonical_root) || canonical_dir == canonical_root {
        return Err("VS Code profile is outside its user directory.".into());
    }
    Ok(canonical_dir)
}

/// Only discover local VS Code installations. The client never submits arbitrary paths.
pub fn sources() -> Vec<Source> {
    let mut output = Vec::new();
    for (edition, label) in editions() {
        let Ok(root) = config_root(edition) else { continue };
        if !root.is_dir() { continue }
        output.push(Source { edition: edition.into(), profile: "default".into(), label: format!("{label} — Default") });
        if let Ok(profiles) = fs::read_dir(root.join("profiles")) {
            for dir in profiles.flatten() {
                let id = dir.file_name().to_string_lossy().to_string();
                if source_path(edition, &id).is_ok_and(|path| path.is_dir()) {
                    output.push(Source { edition: edition.into(), profile: id.clone(), label: format!("{label} — {id}") });
                }
            }
        }
    }
    output.sort_by(|a, b| a.label.cmp(&b.label));
    output
}

/// Strip JSONC comments and trailing commas without changing the contents of string literals.
pub fn jsonc(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut chars = text.trim_start_matches('\u{feff}').chars().peekable();
    let mut quoted = false;
    let mut escaped = false;
    while let Some(ch) = chars.next() {
        if quoted {
            output.push(ch);
            if escaped { escaped = false; }
            else if ch == '\\' { escaped = true; }
            else if ch == '"' { quoted = false; }
        } else if ch == '"' {
            quoted = true;
            output.push(ch);
        } else if ch == '/' && chars.peek() == Some(&'/') {
            chars.next();
            for next in chars.by_ref() {
                if next == '\n' { output.push('\n'); break; }
            }
        } else if ch == '/' && chars.peek() == Some(&'*') {
            chars.next();
            let mut prev = '\0';
            for next in chars.by_ref() {
                if next == '\n' { output.push('\n'); }
                if prev == '*' && next == '/' { break; }
                prev = next;
            }
        } else { output.push(ch); }
    }
    let mut filtered = String::with_capacity(output.len());
    let chars: Vec<char> = output.chars().collect();
    let mut quoted = false;
    let mut escaped = false;
    for (index, ch) in chars.iter().copied().enumerate() {
        if quoted {
            filtered.push(ch);
            if escaped { escaped = false; }
            else if ch == '\\' { escaped = true; }
            else if ch == '"' { quoted = false; }
        } else if ch == '"' {
            quoted = true;
            filtered.push(ch);
        } else if ch == ',' && chars[index + 1..].iter().find(|c| !c.is_whitespace()).is_some_and(|c| *c == '}' || *c == ']') {
            continue;
        } else { filtered.push(ch); }
    }
    filtered
}

fn sensitive(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    ["password", "secret", "token", "apikey", "api_key", "credential", "authorization", "privatekey"]
        .iter().any(|fragment| id.contains(fragment))
}

fn read_jsonc(path: &Path) -> Result<Option<Value>, String> {
    match fs::read_to_string(path) {
        Ok(text) if text.len() <= 4 * 1024 * 1024 =>
            serde_json::from_str(&jsonc(&text)).map(Some)
                .map_err(|e| format!("{}: {e}", path.display())),
        Ok(_) => Err(format!("{} exceeds the 4 MB import limit.", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

pub fn inspect(edition: &str, profile: &str, extras: &Extras) -> Result<Preview, String> {
    let folder = source_path(edition, profile)?;
    if !sources().iter().any(|s| s.edition == edition && s.profile == profile) {
        return Err("VS Code profile was not found.".into());
    }
    let source = Source { edition: edition.into(), profile: profile.into(),
        label: format!("{edition} / {profile}") };
    let mut preview = Preview { source, settings: vec![], keybindings: vec![],
        skipped: vec![], extensions: vec![], snippets: vec![], warnings: vec![] };
    if let Some(value) = read_jsonc(&folder.join("settings.json"))? {
        let map = value.as_object().ok_or("VS Code settings.json must be an object.")?;
        for (original_id, original_value) in map {
            if sensitive(original_id) {
                preview.skipped.push(format!("{original_id} (credential)"));
                continue;
            }
            let (id, value) = match original_id.as_str() {
                "editor.minimap.enabled" => ("editor.minimap", original_value.clone()),
                "editor.stickyScroll.enabled" => ("editor.stickyScroll", original_value.clone()),
                _ => (original_id.as_str(), original_value.clone()),
            };
            match schema::find(id, extras).and_then(|definition| schema::validate(&definition, &value).ok()) {
                Some(value) => preview.settings.push(Candidate { id: id.into(), value }),
                None => preview.skipped.push(original_id.clone()),
            }
        }
    }
    if let Some(value) = read_jsonc(&folder.join("keybindings.json"))? {
        if let Some(entries) = value.as_array() {
            for entry in entries {
                let Some(object) = entry.as_object() else { preview.skipped.push("Invalid shortcut".into()); continue };
                if object.get("when").and_then(Value::as_str).is_some_and(|condition| !condition.is_empty()) {
                    preview.skipped.push(format!("Conditional shortcut: {}", object.get("command").and_then(Value::as_str).unwrap_or("unknown")));
                    continue;
                }
                let (Some(key), Some(command)) = (object.get("key").and_then(Value::as_str), object.get("command").and_then(Value::as_str)) else {
                    preview.skipped.push("Shortcut without key or command".into());
                    continue;
                };
                let entry = KeybindingEntry { key: key.into(), command: command.into() };
                match keybindings::normalize_entries(&[entry]) {
                    Ok(mut supported) => preview.keybindings.append(&mut supported),
                    Err(_) => preview.skipped.push(format!("Unsupported shortcut: {key}")),
                }
            }
        } else { preview.warnings.push("keybindings.json isn't a list.".into()); }
    }
    let snippet_dir = folder.join("snippets");
    if let Ok(entries) = fs::read_dir(snippet_dir) {
        for item in entries.flatten() {
            if item.path().is_file() && item.file_name().to_string_lossy().ends_with(".json") ||
                item.path().is_file() && item.file_name().to_string_lossy().ends_with(".code-snippets") {
                preview.snippets.push(item.file_name().to_string_lossy().to_string());
            }
        }
    }
    // Extension directories are listed for a compatibility review; never blindly execute/copy third-party code.
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    let extension_folder = match edition {
        "insiders" => ".vscode-insiders",
        "codium" => ".vscode-oss",
        _ => ".vscode",
    };
    if let Some(home) = home {
        if let Ok(entries) = fs::read_dir(PathBuf::from(home).join(extension_folder).join("extensions")) {
            for entry in entries.flatten() {
                if entry.path().join("package.json").is_file() {
                    preview.extensions.push(entry.file_name().to_string_lossy().to_string());
                }
            }
        }
    }
    preview.extensions.sort();
    preview.snippets.sort();
    preview.warnings.push("Extensions require VSIX compatibility checks; installed code is not copied automatically.".into());
    preview.warnings.push("Snippets are inventoried but are not enabled automatically.".into());
    Ok(preview)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comments_and_trailing_commas_are_removed_but_urls_stay_intact() {
        let cleaned = jsonc(r#"{
            // comment
            "url": "https://example.org/a//b",
            "editor.fontSize": 15, /* ignored */
        }"#);
        let value: Value = serde_json::from_str(&cleaned).unwrap();
        assert_eq!(value["url"], "https://example.org/a//b");
        assert_eq!(value["editor.fontSize"], 15);
    }

    #[test]
    fn sensitive_keys_are_rejected() {
        assert!(sensitive("my.provider.apiKey"));
        assert!(sensitive("auth.accessToken"));
        assert!(!sensitive("editor.fontSize"));
    }

    #[test]
    fn profile_paths_cannot_traverse() {
        assert!(source_path("code", "../Secrets").is_err());
        assert!(source_path("other", "default").is_err());
    }
}
