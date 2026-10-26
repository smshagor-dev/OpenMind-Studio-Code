//! Importable settings from VS Code's local user profiles. Import is opt-in:
//! no source files are modified, and credentials are never copied.
use crate::{keybindings::KeybindingEntry, schema::Extras, vscode_map};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

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
    [
        ("code", "Code"),
        ("insiders", "Code - Insiders"),
        ("codium", "VSCodium"),
        ("oss", "Code - OSS"),
    ]
}

fn config_root(edition: &str) -> Result<PathBuf, String> {
    let folder = editions()
        .into_iter()
        .find(|(id, _)| *id == edition)
        .map(|(_, folder)| folder)
        .ok_or_else(|| "Unknown VS Code edition.".to_string())?;
    #[cfg(target_os = "windows")]
    let root = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "APPDATA isn't configured.".to_string())?;
    #[cfg(target_os = "macos")]
    let root = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME isn't configured.".to_string())?
        .join("Library")
        .join("Application Support");
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let root = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .ok_or_else(|| "Cannot locate the VS Code configuration directory.".to_string())?;
    Ok(root.join(folder).join("User"))
}

fn source_path(edition: &str, profile: &str) -> Result<PathBuf, String> {
    let root = config_root(edition)?;
    if profile == "default" {
        return Ok(root);
    }
    if profile.is_empty()
        || profile.len() > 80
        || !profile
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
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
        let Ok(root) = config_root(edition) else {
            continue;
        };
        if !root.is_dir() {
            continue;
        }
        output.push(Source {
            edition: edition.into(),
            profile: "default".into(),
            label: format!("{label} — Default"),
        });
        if let Ok(profiles) = fs::read_dir(root.join("profiles")) {
            for dir in profiles.flatten() {
                let id = dir.file_name().to_string_lossy().to_string();
                if source_path(edition, &id).is_ok_and(|path| path.is_dir()) {
                    output.push(Source {
                        edition: edition.into(),
                        profile: id.clone(),
                        label: format!("{label} — {id}"),
                    });
                }
            }
        }
    }
    output.sort_by(|a, b| a.label.cmp(&b.label));
    output
}

/// The folder an edition keeps its installed extensions in (the edition is checked against the allow-list).
fn extensions_root(edition: &str) -> Result<PathBuf, String> {
    config_root(edition)?;
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or("Cannot locate the VS Code extensions directory.")?;
    let store = match edition {
        "insiders" => ".vscode-insiders",
        "codium" | "oss" => ".vscode-oss",
        _ => ".vscode",
    };
    Ok(PathBuf::from(home).join(store).join("extensions"))
}

/// Extension folders VS Code has replaced by a newer version but not deleted yet (its `.obsolete` file).
fn obsolete_folders(root: &Path) -> Vec<String> {
    let Ok(text) = fs::read_to_string(root.join(".obsolete")) else {
        return Vec::new();
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => map
            .into_iter()
            .filter(|(_, gone)| gone.as_bool() == Some(true))
            .map(|(folder, _)| folder)
            .collect(),
        _ => Vec::new(),
    }
}

/// The installed extensions an edition offers for import: current versions only, never VS Code's leftovers.
pub fn extension_folders(edition: &str) -> Vec<String> {
    let Ok(root) = extensions_root(edition) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&root) else {
        return Vec::new();
    };
    let obsolete = obsolete_folders(&root);
    let mut folders: Vec<String> = entries
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| !name.starts_with('.') && !obsolete.contains(name))
        .filter(|name| extension_path(edition, name).is_ok())
        .take(1000)
        .collect();
    folders.sort();
    folders
}

/// Resolve a discovered VS Code extension folder without accepting caller paths.
pub fn extension_path(edition: &str, folder: &str) -> Result<PathBuf, String> {
    if folder.is_empty()
        || folder.len() > 160
        || !folder
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-' || c == b'_' || c == b'@')
        || folder == "."
        || folder == ".."
    {
        return Err("Invalid extension folder name.".into());
    }
    let root = extensions_root(edition)?;
    let expected = root.join(folder);
    let actual_root = root.canonicalize().map_err(|e| e.to_string())?;
    let actual = expected.canonicalize().map_err(|e| e.to_string())?;
    if !actual.starts_with(&actual_root)
        || actual == actual_root
        || !expected.is_dir()
        || !actual.join("package.json").is_file()
    {
        return Err("This extension wasn't found in the selected VS Code installation.".into());
    }
    Ok(actual)
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
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                quoted = false;
            }
        } else if ch == '"' {
            quoted = true;
            output.push(ch);
        } else if ch == '/' && chars.peek() == Some(&'/') {
            chars.next();
            for next in chars.by_ref() {
                if next == '\n' {
                    output.push('\n');
                    break;
                }
            }
        } else if ch == '/' && chars.peek() == Some(&'*') {
            chars.next();
            let mut prev = '\0';
            for next in chars.by_ref() {
                if next == '\n' {
                    output.push('\n');
                }
                if prev == '*' && next == '/' {
                    break;
                }
                prev = next;
            }
        } else {
            output.push(ch);
        }
    }
    let mut filtered = String::with_capacity(output.len());
    let chars: Vec<char> = output.chars().collect();
    let mut quoted = false;
    let mut escaped = false;
    for (index, ch) in chars.iter().copied().enumerate() {
        if quoted {
            filtered.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                quoted = false;
            }
        } else if ch == '"' {
            quoted = true;
            filtered.push(ch);
        } else if ch == ','
            && chars[index + 1..]
                .iter()
                .find(|c| !c.is_whitespace())
                .is_some_and(|c| *c == '}' || *c == ']')
        {
            continue;
        } else {
            filtered.push(ch);
        }
    }
    filtered
}

fn sensitive(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    [
        "password",
        "secret",
        "token",
        "apikey",
        "api_key",
        "credential",
        "authorization",
        "privatekey",
    ]
    .iter()
    .any(|fragment| id.contains(fragment))
}

fn read_jsonc(path: &Path) -> Result<Option<Value>, String> {
    match fs::read_to_string(path) {
        Ok(text) if text.len() <= 4 * 1024 * 1024 => serde_json::from_str(&jsonc(&text))
            .map(Some)
            .map_err(|e| format!("{}: {e}", path.display())),
        Ok(_) => Err(format!("{} exceeds the 4 MB import limit.", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// Read safe VS Code snippet files as normalized JSON. Source files are
/// never changed or executed, and links outside the profile are refused.
pub fn snippet_contents(edition: &str, profile: &str) -> Result<Vec<(String, String)>, String> {
    let root = source_path(edition, profile)?;
    let folder = root.join("snippets");
    if !folder.exists() {
        return Ok(Vec::new());
    }
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let canonical_folder = folder.canonicalize().map_err(|e| e.to_string())?;
    if !canonical_folder.starts_with(&canonical_root) || canonical_folder == canonical_root {
        return Err("Snippets folder escapes its VS Code profile.".into());
    }
    let mut result = Vec::new();
    let entries = fs::read_dir(&folder).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.len() > 100
            || !name
                .bytes()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == b'_' || ch == b'-' || ch == b'.')
        {
            continue;
        }
        if !(name.ends_with(".json") || name.ends_with(".code-snippets")) {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            continue;
        }
        let canonical = entry.path().canonicalize().map_err(|e| e.to_string())?;
        if !canonical.starts_with(&canonical_folder) {
            continue;
        }
        if let Some(Value::Object(map)) = read_jsonc(&canonical)? {
            let text = serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?;
            result.push((name, text));
        }
    }
    result.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(result)
}

/// What the given VS Code profile would bring: translated settings and shortcuts, snippets, installed extensions,
/// and a line for everything left out. `extension_commands` are the commands installed OpenMind extensions contribute
/// (shortcuts for them are kept as they are).
pub fn inspect(
    edition: &str,
    profile: &str,
    extras: &Extras,
    extension_commands: &[String],
) -> Result<Preview, String> {
    let folder = source_path(edition, profile)?;
    let source = sources()
        .into_iter()
        .find(|s| s.edition == edition && s.profile == profile)
        .ok_or("VS Code profile was not found.")?;
    let mut preview = inspect_folder(&folder, source, extras, extension_commands)?;
    preview.extensions = extension_folders(edition);
    Ok(preview)
}

fn read_settings(folder: &Path, extras: &Extras, preview: &mut Preview) -> Result<(), String> {
    let Some(value) = read_jsonc(&folder.join("settings.json"))? else {
        return Ok(());
    };
    let map = value
        .as_object()
        .ok_or("VS Code settings.json must be an object.")?;
    for (id, value) in map {
        if sensitive(id) {
            preview.skipped.push(format!("{id} (credential)"));
            continue;
        }
        if id == "window.autoDetectColorScheme" {
            continue;
        }
        match vscode_map::setting(id, value, extras) {
            Ok((target, value)) => {
                preview.settings.retain(|known| known.id != target);
                preview.settings.push(Candidate { id: target, value });
            }
            Err(reason) => preview.skipped.push(reason),
        }
    }
    // VS Code's "follow the OS theme" switch wins over the fixed theme, as it does in VS Code.
    if map
        .get("window.autoDetectColorScheme")
        .and_then(Value::as_bool)
        == Some(true)
    {
        preview
            .settings
            .retain(|known| known.id != "workbench.colorTheme");
        preview.settings.push(Candidate {
            id: "workbench.colorTheme".into(),
            value: Value::String("system".into()),
        });
    }
    Ok(())
}

fn read_keybindings(
    folder: &Path,
    extension_commands: &[String],
    preview: &mut Preview,
) -> Result<(), String> {
    let Some(value) = read_jsonc(&folder.join("keybindings.json"))? else {
        return Ok(());
    };
    let Some(entries) = value.as_array() else {
        preview
            .warnings
            .push("keybindings.json isn't a list.".into());
        return Ok(());
    };
    for entry in entries {
        let Some(object) = entry.as_object() else {
            preview.skipped.push("Invalid shortcut".into());
            continue;
        };
        let command = object.get("command").and_then(Value::as_str);
        if object
            .get("when")
            .and_then(Value::as_str)
            .is_some_and(|condition| !condition.trim().is_empty())
        {
            preview.skipped.push(format!(
                "Conditional shortcut: {}",
                command.unwrap_or("unknown")
            ));
            continue;
        }
        let (Some(key), Some(command)) = (object.get("key").and_then(Value::as_str), command)
        else {
            preview
                .skipped
                .push("Shortcut without key or command".into());
            continue;
        };
        match vscode_map::keybinding(key, command, extension_commands) {
            Ok(entry) if !preview.keybindings.contains(&entry) => preview.keybindings.push(entry),
            Ok(_) => {}
            Err(reason) => preview.skipped.push(reason),
        }
    }
    Ok(())
}

/// The profile folder's part of the preview (everything but the installed extensions).
fn inspect_folder(
    folder: &Path,
    source: Source,
    extras: &Extras,
    extension_commands: &[String],
) -> Result<Preview, String> {
    let mut preview = Preview {
        source,
        settings: vec![],
        keybindings: vec![],
        skipped: vec![],
        extensions: vec![],
        snippets: vec![],
        warnings: vec![],
    };
    read_settings(folder, extras, &mut preview)?;
    read_keybindings(folder, extension_commands, &mut preview)?;
    if let Ok(entries) = fs::read_dir(folder.join("snippets")) {
        for item in entries.flatten() {
            let name = item.file_name().to_string_lossy().to_string();
            if item.path().is_file()
                && (name.ends_with(".json") || name.ends_with(".code-snippets"))
            {
                preview.snippets.push(name);
            }
        }
    }
    preview.snippets.sort();
    Ok(preview)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile_folder() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("settings.json"),
            r#"{
            // A typical VS Code user file.
            "editor.fontSize": 15,
            "editor.wordWrap": "on",
            "editor.minimap.enabled": false,
            "workbench.colorTheme": "Default Light Modern",
            "window.autoDetectColorScheme": true,
            "terminal.integrated.fontSize": 13,
            "github.copilot.advanced": { "authProvider": "x" },
            "remote.SSH.password": "hunter2",
        }"#,
        )
        .unwrap();
        fs::write(
            dir.path().join("keybindings.json"),
            r#"[
            { "key": "ctrl+alt+s", "command": "workbench.action.files.saveAll" },
            { "key": "ctrl+s", "command": "-workbench.action.files.save" },
            { "key": "ctrl+k ctrl+t", "command": "workbench.action.selectTheme" },
            { "key": "ctrl+e", "command": "workbench.action.quickOpen", "when": "editorFocus" },
            { "key": "ctrl+alt+g", "command": "acme.graph" },
        ]"#,
        )
        .unwrap();
        fs::create_dir(dir.path().join("snippets")).unwrap();
        fs::write(dir.path().join("snippets").join("rust.json"), "{}").unwrap();
        dir
    }

    #[test]
    fn a_vscode_profile_is_translated_and_everything_left_out_is_named() {
        let dir = profile_folder();
        let source = Source {
            edition: "code".into(),
            profile: "default".into(),
            label: "Code — Default".into(),
        };
        let preview = inspect_folder(
            dir.path(),
            source,
            &Extras::default(),
            &["acme.graph".into()],
        )
        .unwrap();
        let value = |id: &str| {
            preview
                .settings
                .iter()
                .find(|c| c.id == id)
                .map(|c| c.value.clone())
        };
        assert_eq!(value("editor.fontSize"), Some(serde_json::json!(15)));
        assert_eq!(value("editor.wordWrap"), Some(serde_json::json!(true)));
        assert_eq!(value("editor.minimap"), Some(serde_json::json!(false)));
        assert_eq!(value("terminal.fontSize"), Some(serde_json::json!(13)));
        // autoDetectColorScheme wins over the fixed theme.
        assert_eq!(
            value("workbench.colorTheme"),
            Some(serde_json::json!("system"))
        );
        let keys: Vec<(String, String)> = preview
            .keybindings
            .iter()
            .map(|e| (e.key.clone(), e.command.clone()))
            .collect();
        assert_eq!(
            keys,
            vec![
                ("Ctrl+Alt+S".into(), "file.saveAll".into()),
                ("Ctrl+S".into(), "-file.save".into()),
                ("Ctrl+Alt+G".into(), "acme.graph".into()),
            ]
        );
        assert!(preview
            .skipped
            .contains(&"remote.SSH.password (credential)".to_string()));
        assert!(preview
            .skipped
            .contains(&"github.copilot.advanced (no OpenMind equivalent)".to_string()));
        assert!(preview
            .skipped
            .contains(&"Key sequence not supported: ctrl+k ctrl+t".to_string()));
        assert!(preview
            .skipped
            .contains(&"Conditional shortcut: workbench.action.quickOpen".to_string()));
        assert_eq!(preview.snippets, vec!["rust.json".to_string()]);
        assert!(!serde_json::to_string(&preview).unwrap().contains("hunter2"));
    }

    /// Read-only preview of the VS Code profiles on this computer (`cargo test -p openmind-settings real_vscode -- --ignored
    /// --nocapture`). Prints counts and skip reasons only, never a setting's value.
    #[test]
    #[ignore]
    fn real_vscode_profiles_on_this_computer_can_be_previewed() {
        for source in sources() {
            let preview =
                inspect(&source.edition, &source.profile, &Extras::default(), &[]).unwrap();
            println!(
                "{}: {} settings, {} shortcuts, {} snippets, {} extensions, {} left out",
                source.label,
                preview.settings.len(),
                preview.keybindings.len(),
                preview.snippets.len(),
                preview.extensions.len(),
                preview.skipped.len()
            );
            for line in &preview.skipped {
                println!("    left out: {line}");
            }
            for entry in &preview.keybindings {
                println!("    shortcut: {} -> {}", entry.key, entry.command);
            }
        }
    }

    #[test]
    fn obsolete_extension_versions_are_read_from_vscode_s_list() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(".obsolete"),
            r#"{"acme.x-1.0.0":true,"acme.y-2.0.0":false}"#,
        )
        .unwrap();
        assert_eq!(
            obsolete_folders(dir.path()),
            vec!["acme.x-1.0.0".to_string()]
        );
        assert!(obsolete_folders(&dir.path().join("missing")).is_empty());
    }

    #[test]
    fn comments_and_trailing_commas_are_removed_but_urls_stay_intact() {
        let cleaned = jsonc(
            r#"{
            // comment
            "url": "https://example.org/a//b",
            "editor.fontSize": 15, /* ignored */
        }"#,
        );
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
