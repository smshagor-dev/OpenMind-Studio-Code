use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// One line of the user's `keybindings.json`, VS Code style: `{ "key": "Ctrl+Alt+S", "command":
/// "file.saveAll" }` binds a key, and a command with a leading `-` (`"-file.save"`) removes that
/// command's default binding for `key`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeybindingEntry {
    pub key: String,
    pub command: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct KeybindingsFile {
    pub entries: Vec<KeybindingEntry>,
    /// Set when the file exists but can't be used; the entries are then empty.
    pub error: Option<String>,
}

const MODIFIERS: [&str; 3] = ["Ctrl", "Shift", "Alt"];
const NAMED_KEYS: &[&str] = &[
    "Up",
    "Down",
    "Left",
    "Right",
    "PageUp",
    "PageDown",
    "Home",
    "End",
    "Enter",
    "Space",
    "Tab",
    "Backspace",
    "Delete",
    "Insert",
];
const PUNCTUATION: &str = "`-=[]\\;',./";

fn canonical_key(token: &str) -> Option<String> {
    let lower = token.to_ascii_lowercase();
    if let Some(named) = NAMED_KEYS
        .iter()
        .find(|name| name.to_ascii_lowercase() == lower)
    {
        return Some((*named).to_string());
    }
    if let Some(number) = lower
        .strip_prefix('f')
        .and_then(|rest| rest.parse::<u8>().ok())
    {
        return (1..=24).contains(&number).then(|| format!("F{number}"));
    }
    if let Some(digit) = lower.strip_prefix("numpad") {
        return (digit.len() == 1 && digit.chars().all(|c| c.is_ascii_digit()))
            .then(|| format!("Numpad{digit}"));
    }
    let mut chars = token.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) if c.is_ascii_alphanumeric() => Some(c.to_ascii_uppercase().to_string()),
        (Some(c), None) if PUNCTUATION.contains(c) => Some(c.to_string()),
        _ => None,
    }
}

/// Checks a key chord and returns it in the one spelling the app uses (`ctrl+shift+s` ->
/// `Ctrl+Shift+S`). A chord needs Ctrl or Alt unless it is a function key, so a shortcut can never
/// take over plain typing.
pub fn normalize_chord(chord: &str) -> Result<String, String> {
    let chord = chord.trim();
    if chord.is_empty() {
        return Err("The key is empty.".into());
    }
    let mut modifiers = [false; 3];
    let mut key: Option<String> = None;
    // The last part is the key; a trailing "+" is the plus key itself is not supported (use "=").
    let parts: Vec<&str> = chord.split('+').collect();
    for (index, part) in parts.iter().enumerate() {
        let part = part.trim();
        let is_last = index + 1 == parts.len();
        if !is_last {
            let position = MODIFIERS
                .iter()
                .position(|name| name.eq_ignore_ascii_case(part))
                .or_else(|| part.eq_ignore_ascii_case("cmd").then_some(0))
                .ok_or_else(|| format!("\"{part}\" is not a modifier (Ctrl, Shift, Alt)."))?;
            if modifiers[position] {
                return Err(format!("{} appears twice.", MODIFIERS[position]));
            }
            modifiers[position] = true;
        } else {
            key = Some(
                canonical_key(part)
                    .ok_or_else(|| format!("\"{part}\" is not a key this app can bind."))?,
            );
        }
    }
    let key = key.ok_or_else(|| "The chord has no key.".to_string())?;
    let is_function_key = key.starts_with('F') && key[1..].chars().all(|c| c.is_ascii_digit());
    if !modifiers[0] && !modifiers[2] && !is_function_key {
        return Err("A shortcut needs Ctrl or Alt (or be a function key).".into());
    }
    let mut out: Vec<String> = MODIFIERS
        .iter()
        .zip(modifiers)
        .filter(|(_, on)| *on)
        .map(|(name, _)| (*name).to_string())
        .collect();
    out.push(key);
    Ok(out.join("+"))
}

fn valid_command(command: &str) -> Result<(), String> {
    let name = command.strip_prefix('-').unwrap_or(command);
    let ok = !name.is_empty()
        && name.len() <= 80
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-');
    if ok {
        Ok(())
    } else {
        Err(format!("\"{command}\" is not a command id."))
    }
}

/// Validates entries and returns them normalized, without duplicates.
pub fn normalize_entries(entries: &[KeybindingEntry]) -> Result<Vec<KeybindingEntry>, String> {
    let mut out: Vec<KeybindingEntry> = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let position = index + 1;
        valid_command(&entry.command).map_err(|err| format!("Entry {position}: {err}"))?;
        let key = normalize_chord(&entry.key).map_err(|err| format!("Entry {position}: {err}"))?;
        let normalized = KeybindingEntry {
            key,
            command: entry.command.clone(),
        };
        if !out.contains(&normalized) {
            out.push(normalized);
        }
    }
    Ok(out)
}

pub fn read_file(path: &Path) -> KeybindingsFile {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return KeybindingsFile::default()
        }
        Err(err) => {
            return KeybindingsFile {
                entries: Vec::new(),
                error: Some(format!("Couldn't read the file: {err}")),
            }
        }
    };
    parse(&text)
}

/// Parses the text of a keybindings file; an empty file is an empty list.
pub fn parse(text: &str) -> KeybindingsFile {
    let trimmed = text.trim_start_matches('\u{feff}').trim();
    if trimmed.is_empty() {
        return KeybindingsFile::default();
    }
    let failed = |error: String| KeybindingsFile {
        entries: Vec::new(),
        error: Some(error),
    };
    match serde_json::from_str::<Vec<KeybindingEntry>>(trimmed) {
        Err(err) => failed(format!(
            "Not a list of {{ \"key\", \"command\" }} entries (line {}, column {}): {err}",
            err.line(),
            err.column()
        )),
        Ok(entries) => match normalize_entries(&entries) {
            Ok(entries) => KeybindingsFile {
                entries,
                error: None,
            },
            Err(error) => failed(error),
        },
    }
}

#[derive(Debug, thiserror::Error)]
pub enum KeybindingsError {
    #[error("{0}")]
    Invalid(String),
    #[error("Couldn't write {path}: {source}")]
    Write {
        path: PathBuf,
        source: std::io::Error,
    },
}

/// Writes the user's keybindings (validated and normalized). A file that currently can't be
/// parsed is left alone: rewriting it would throw away what the user typed.
pub fn write_file(
    path: &Path,
    entries: &[KeybindingEntry],
) -> Result<Vec<KeybindingEntry>, KeybindingsError> {
    if let Some(error) = read_file(path).error {
        return Err(KeybindingsError::Invalid(format!(
            "{} has a problem, so it wasn't changed. {error}",
            path.display()
        )));
    }
    let entries = normalize_entries(entries).map_err(KeybindingsError::Invalid)?;
    let fail = |source| KeybindingsError::Write {
        path: path.to_path_buf(),
        source,
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(fail)?;
    }
    let mut text = serde_json::to_string_pretty(&entries).unwrap_or_else(|_| "[]".into());
    text.push('\n');
    let mut temp = path.as_os_str().to_owned();
    temp.push(".tmp");
    let temp = PathBuf::from(temp);
    std::fs::write(&temp, text).map_err(fail)?;
    std::fs::rename(&temp, path).map_err(|source| {
        let _ = std::fs::remove_file(&temp);
        fail(source)
    })?;
    Ok(entries)
}

/// Creates the file with `[]` when it doesn't exist yet, so the JSON editor has something to open.
pub fn ensure_file(path: &Path) -> Result<(), KeybindingsError> {
    if path.exists() {
        return Ok(());
    }
    write_file(path, &[]).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(key: &str, command: &str) -> KeybindingEntry {
        KeybindingEntry {
            key: key.into(),
            command: command.into(),
        }
    }

    #[test]
    fn chords_are_normalized_to_one_spelling() {
        assert_eq!(
            normalize_chord("ctrl+shift+s").as_deref(),
            Ok("Ctrl+Shift+S")
        );
        assert_eq!(
            normalize_chord("Alt+Shift+ctrl+f5").as_deref(),
            Ok("Ctrl+Shift+Alt+F5")
        );
        assert_eq!(normalize_chord("f10").as_deref(), Ok("F10"));
        assert_eq!(normalize_chord("Ctrl+`").as_deref(), Ok("Ctrl+`"));
        assert_eq!(
            normalize_chord("ctrl+pagedown").as_deref(),
            Ok("Ctrl+PageDown")
        );
        assert_eq!(
            normalize_chord("Ctrl+numpad0").as_deref(),
            Ok("Ctrl+Numpad0")
        );
    }

    #[test]
    fn chords_that_would_break_typing_or_are_unknown_are_refused() {
        for bad in [
            "",
            "S",
            "Shift+S",
            "Ctrl+",
            "Ctrl+Ctrl+S",
            "Ctrl+Hyper+S",
            "Ctrl+F25",
            "Ctrl+ab",
            "Enter",
        ] {
            assert!(normalize_chord(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn entries_are_validated_normalized_and_deduplicated() {
        let entries = [
            entry("ctrl+alt+s", "file.saveAll"),
            entry("Ctrl+Alt+S", "file.saveAll"),
            entry("F9", "-debug.toggleBreakpoint"),
        ];
        let normalized = normalize_entries(&entries).expect("valid");
        assert_eq!(normalized.len(), 2);
        assert_eq!(normalized[0].key, "Ctrl+Alt+S");
        assert!(normalize_entries(&[entry("Ctrl+S", "bad command!")]).is_err());
        let err =
            normalize_entries(&[entry("Ctrl+S", "a"), entry("X", "b")]).expect_err("second is bad");
        assert!(err.starts_with("Entry 2"));
    }

    #[test]
    fn user_keybindings_survive_a_restart() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings").join("keybindings.json");
        assert_eq!(read_file(&path), KeybindingsFile::default());

        write_file(
            &path,
            &[
                entry("ctrl+alt+r", "run.code"),
                entry("F6", "-debug.stepOver"),
            ],
        )
        .expect("saved");
        let again = read_file(&path);
        assert!(again.error.is_none());
        assert_eq!(
            again.entries,
            [
                entry("Ctrl+Alt+R", "run.code"),
                entry("F6", "-debug.stepOver")
            ]
        );
    }

    #[test]
    fn a_broken_file_is_reported_and_not_overwritten() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("keybindings.json");
        std::fs::write(&path, "[ { \"key\": \"Ctrl+S\" } ]").expect("write");
        let file = read_file(&path);
        assert!(file.entries.is_empty());
        assert!(file.error.is_some());
        assert!(write_file(&path, &[entry("Ctrl+Alt+A", "x")]).is_err());
        assert!(std::fs::read_to_string(&path)
            .expect("read")
            .contains("Ctrl+S"));

        std::fs::write(&path, "[ { \"key\": \"S\", \"command\": \"x\" } ]").expect("write");
        assert!(read_file(&path).error.expect("error").contains("Entry 1"));
    }

    #[test]
    fn ensure_file_creates_an_empty_list() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("keybindings.json");
        ensure_file(&path).expect("created");
        assert_eq!(std::fs::read_to_string(&path).expect("read").trim(), "[]");
    }
}
