//! Optional shell integration, only on request: the `openmind` command on the user's PATH and "Open with OpenMind
//! Studio" in File Explorer. Asked for by the NSIS installer's check boxes (it runs `OpenMindStudio.exe --integration
//! <action>`) or by the commands of the same name in the app (portable copies); nothing here runs by itself.
//!
//! Per user only (`HKCU`): the per-machine MSI uses its own WiX components (`src-tauri/wix/integration.wxs`).
//! What was added is recorded under [`RECORD_KEY`] (outside the installer's product key, which its uninstaller
//! deletes), and removal takes away only that: a PATH entry that was already there is never recorded and never
//! removed, and an Explorer entry pointing at another OpenMind copy is left alone.

pub mod check;
pub mod deploy;
pub mod provision;
#[cfg(windows)]
pub mod registry;
#[cfg(windows)]
pub mod shortcut;

use std::fs;
use std::path::Path;

use serde::Serialize;

/// Where OpenMind records what it added (per user).
pub const RECORD_KEY: &str = r"Software\OpenMind\OpenMind Studio Integration";
/// Where installed copies note their folder for the setup programs (per user), so a new setup finds an installation
/// it did not install itself (a shared network folder another person installed, a folder chosen by hand): one value
/// per installation folder (name = the folder, data = the version that last started from it) and the default value
/// = the folder started last. Written only by installed copies (never portable ones), removed by the uninstaller.
pub const INSTALLATIONS_KEY: &str = r"Software\OpenMind\OpenMind Studio Installations";
/// The record of the Explorer entries: the exe they run.
const EXPLORER_RECORD: &str = "Explorer";
/// The text of the Explorer entries.
pub const MENU_LABEL: &str = "Open with OpenMind Studio";
/// The folder added to PATH, next to the executable: it holds only the launchers, never `uninstall.exe`.
pub const BIN_DIR: &str = "bin";

/// The launchers written into `bin` (the installers ship the same files, so a write is usually a no-op).
pub const LAUNCHERS: [(&str, &str); 2] = [
    ("openmind.cmd", include_str!("../../cli/openmind.cmd")),
    ("openmind", include_str!("../../cli/openmind")),
];

/// The three Explorer entries (under `HKCU\Software\Classes`) and the placeholder Explorer fills in.
pub const MENU_KEYS: [(&str, &str); 3] = [
    // A folder, right-clicked.
    (r"Software\Classes\Directory\shell\OpenMindStudio", "%V"),
    // The empty background of an open folder.
    (
        r"Software\Classes\Directory\Background\shell\OpenMindStudio",
        "%V",
    ),
    // Any file.
    (r"Software\Classes\*\shell\OpenMindStudio", "%1"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    AddPath,
    RemovePath,
    AddExplorer,
    RemoveExplorer,
    /// What the uninstaller runs: both removals.
    RemoveAll,
    Status,
}

impl Action {
    pub fn parse(text: &str) -> Option<Action> {
        Some(match text {
            "add-path" => Action::AddPath,
            "remove-path" => Action::RemovePath,
            "add-explorer" => Action::AddExplorer,
            "remove-explorer" => Action::RemoveExplorer,
            "remove-all" => Action::RemoveAll,
            "status" => Action::Status,
            _ => return None,
        })
    }
}

/// The per-user settings OpenMind can change, behind a small interface so the rules are tested without a Registry.
pub trait Store {
    /// The user's own PATH (`HKCU\Environment\Path`) as stored, and whether it is an expandable string.
    fn user_path(&self) -> Result<Option<(String, bool)>, String>;
    fn set_user_path(&mut self, value: &str, expandable: bool) -> Result<(), String>;
    /// A string value (`""` = the key's default value); `None` when the key or value is missing.
    fn value(&self, key: &str, name: &str) -> Result<Option<String>, String>;
    fn set_value(&mut self, key: &str, name: &str, value: &str) -> Result<(), String>;
    fn delete_value(&mut self, key: &str, name: &str) -> Result<(), String>;
    /// Deletes a key with its sub-keys (only ever one of [`MENU_KEYS`]).
    fn delete_tree(&mut self, key: &str) -> Result<(), String>;
    /// Deletes `key` only when it has no values and no sub-keys (the record, once nothing is recorded).
    fn delete_key_if_empty(&mut self, key: &str) -> Result<(), String>;
    /// `%VAR%` expanded, to recognise an entry the user wrote with a variable.
    fn expand(&self, text: &str) -> String;
    /// Tells running programs (Explorer, so new terminals) that the environment changed.
    fn environment_changed(&mut self);
}

/// What is in place for this copy of OpenMind.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub exe: String,
    pub bin_dir: String,
    /// `bin_dir` is on the user's PATH (added by anyone).
    pub path_present: bool,
    /// OpenMind added it (and will remove it).
    pub path_added: bool,
    /// The Explorer entries run this copy.
    pub explorer_this_copy: bool,
    /// The Explorer entries run another OpenMind copy (left alone).
    pub explorer_other_copy: Option<String>,
}

/// An entry as compared: no quotes, no trailing slash, backslashes, lower case.
fn normalize(entry: &str) -> String {
    entry
        .trim()
        .trim_matches('"')
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

fn same_entry(entry: &str, dir: &str, expand: &dyn Fn(&str) -> String) -> bool {
    let wanted = normalize(dir);
    !wanted.is_empty() && (normalize(entry) == wanted || normalize(&expand(entry)) == wanted)
}

/// `current` with `dir` appended, or `None` when it is already there (in any spelling).
pub fn path_with(current: &str, dir: &str, expand: &dyn Fn(&str) -> String) -> Option<String> {
    if current
        .split(';')
        .any(|entry| same_entry(entry, dir, expand))
    {
        return None;
    }
    Some(if current.is_empty() {
        dir.to_string()
    } else if current.ends_with(';') {
        format!("{current}{dir}")
    } else {
        format!("{current};{dir}")
    })
}

/// `current` without `dir` (every other entry kept exactly as written), or `None` when it isn't there.
pub fn path_without(current: &str, dir: &str, expand: &dyn Fn(&str) -> String) -> Option<String> {
    let entries: Vec<&str> = current.split(';').collect();
    let kept: Vec<&str> = entries
        .iter()
        .copied()
        .filter(|entry| !same_entry(entry, dir, expand))
        .collect();
    (kept.len() != entries.len()).then(|| kept.join(";"))
}

/// The command an Explorer entry runs: the exe and Explorer's placeholder, both quoted (paths with spaces).
pub fn menu_command(exe: &Path, placeholder: &str) -> String {
    format!("\"{}\" \"{placeholder}\"", exe.display())
}

pub fn menu_icon(exe: &Path) -> String {
    format!("\"{}\",0", exe.display())
}

fn bin_dir(exe: &Path) -> Result<std::path::PathBuf, String> {
    let dir = exe
        .parent()
        .ok_or("the program's folder is unknown")?
        .join(BIN_DIR);
    if dir.to_string_lossy().contains(';') {
        return Err("A folder whose name contains ';' can't be put on PATH.".into());
    }
    Ok(dir)
}

/// Writes the launchers into `bin` (only when missing or different).
pub fn write_launchers(bin: &Path) -> Result<(), String> {
    fs::create_dir_all(bin).map_err(|err| format!("{}: {err}", bin.display()))?;
    for (name, text) in LAUNCHERS {
        let file = bin.join(name);
        if fs::read_to_string(&file).is_ok_and(|current| current == text) {
            continue;
        }
        fs::write(&file, text).map_err(|err| format!("{}: {err}", file.display()))?;
    }
    Ok(())
}

pub fn status(store: &dyn Store, exe: &Path) -> Result<Status, String> {
    let bin = bin_dir(exe)?;
    let bin_text = bin.display().to_string();
    let expand = |text: &str| store.expand(text);
    let path = store
        .user_path()?
        .map(|(value, _)| value)
        .unwrap_or_default();
    let command_key = format!(r"{}\command", MENU_KEYS[0].0);
    let command = store.value(&command_key, "")?;
    let this = command.as_deref() == Some(menu_command(exe, MENU_KEYS[0].1).as_str());
    Ok(Status {
        exe: exe.display().to_string(),
        path_present: path_with(&path, &bin_text, &expand).is_none(),
        path_added: store.value(RECORD_KEY, &normalize(&bin_text))?.is_some(),
        bin_dir: bin_text,
        explorer_this_copy: this,
        explorer_other_copy: command.filter(|_| !this),
    })
}

/// Adds `<exe folder>\bin` to the user's PATH unless it is there already (then nothing is recorded or changed).
pub fn add_path(store: &mut dyn Store, exe: &Path) -> Result<String, String> {
    let bin = bin_dir(exe)?;
    write_launchers(&bin)?;
    let bin_text = bin.display().to_string();
    let (current, expandable) = store.user_path()?.unwrap_or((String::new(), true));
    let expand = |text: &str| store.expand(text);
    let Some(next) = path_with(&current, &bin_text, &expand) else {
        return Ok(format!(
            "{bin_text} is already on your PATH; left as it is."
        ));
    };
    store.set_user_path(&next, expandable)?;
    store.set_value(RECORD_KEY, &normalize(&bin_text), &bin_text)?;
    store.environment_changed();
    Ok(format!(
        "Added {bin_text} to your PATH. Open a new terminal to use the `openmind` command."
    ))
}

/// Removes the PATH entry only if OpenMind added it.
pub fn remove_path(store: &mut dyn Store, exe: &Path) -> Result<String, String> {
    let bin = bin_dir(exe)?;
    let bin_text = bin.display().to_string();
    let record = normalize(&bin_text);
    if store.value(RECORD_KEY, &record)?.is_none() {
        return Ok(format!(
            "{bin_text} was not added to PATH by OpenMind Studio; nothing removed."
        ));
    }
    let current = store.user_path()?;
    if let Some((current, expandable)) = current {
        let expand = |text: &str| store.expand(text);
        if let Some(next) = path_without(&current, &bin_text, &expand) {
            store.set_user_path(&next, expandable)?;
            store.environment_changed();
        }
    }
    store.delete_value(RECORD_KEY, &record)?;
    // The launchers stay: the installers ship them (the uninstaller removes them) and without the PATH entry they do
    // nothing. A portable copy's `bin` goes with its folder.
    Ok(format!(
        "Removed {bin_text} from your PATH. Terminals already open keep the old PATH until they are restarted."
    ))
}

/// Writes the three Explorer entries for this copy (replacing entries of another copy, which the user asked for).
pub fn add_explorer(store: &mut dyn Store, exe: &Path) -> Result<String, String> {
    for (key, placeholder) in MENU_KEYS {
        store.set_value(key, "", MENU_LABEL)?;
        store.set_value(key, "Icon", &menu_icon(exe))?;
        store.set_value(
            &format!(r"{key}\command"),
            "",
            &menu_command(exe, placeholder),
        )?;
    }
    store.set_value(RECORD_KEY, EXPLORER_RECORD, &exe.display().to_string())?;
    Ok(format!(
        "\"{MENU_LABEL}\" was added to File Explorer (folders, folder backgrounds and files). On Windows 11 it is under \
         \"Show more options\"."
    ))
}

/// Removes the Explorer entries that run this copy; entries of another copy stay.
pub fn remove_explorer(store: &mut dyn Store, exe: &Path) -> Result<String, String> {
    let mut removed = 0;
    for (key, placeholder) in MENU_KEYS {
        let command = store.value(&format!(r"{key}\command"), "")?;
        if command.as_deref() == Some(menu_command(exe, placeholder).as_str()) {
            store.delete_tree(key)?;
            removed += 1;
        }
    }
    if store.value(RECORD_KEY, EXPLORER_RECORD)?.as_deref()
        == Some(exe.display().to_string().as_str())
    {
        store.delete_value(RECORD_KEY, EXPLORER_RECORD)?;
    }
    Ok(if removed == 0 {
        "No File Explorer entry of this OpenMind Studio copy was found; nothing removed."
            .to_string()
    } else {
        format!("Removed \"{MENU_LABEL}\" from File Explorer.")
    })
}

/// Notes `dir` as an installation started now with `version` (see [`INSTALLATIONS_KEY`]).
pub fn remember_installation(
    store: &mut dyn Store,
    dir: &str,
    version: &str,
) -> Result<(), String> {
    store.set_value(INSTALLATIONS_KEY, dir, version)?;
    store.set_value(INSTALLATIONS_KEY, "", dir)
}

/// Removes `dir` from [`INSTALLATIONS_KEY`] (and the key once nothing is left in it).
pub fn forget_installation(store: &mut dyn Store, dir: &str) -> Result<(), String> {
    store.delete_value(INSTALLATIONS_KEY, dir)?;
    if store
        .value(INSTALLATIONS_KEY, "")?
        .is_some_and(|last| normalize(&last) == normalize(dir))
    {
        store.delete_value(INSTALLATIONS_KEY, "")?;
    }
    store.delete_key_if_empty(INSTALLATIONS_KEY)
}

/// Runs one action and returns what it did, in one line per part.
pub fn run(store: &mut dyn Store, exe: &Path, action: Action) -> Result<String, String> {
    let result = match action {
        Action::AddPath => add_path(store, exe),
        Action::RemovePath => remove_path(store, exe),
        Action::AddExplorer => add_explorer(store, exe),
        Action::RemoveExplorer => remove_explorer(store, exe),
        Action::RemoveAll => {
            let path = remove_path(store, exe)?;
            let explorer = remove_explorer(store, exe)?;
            Ok(format!("{path}\n{explorer}"))
        }
        Action::Status => {
            return serde_json::to_string(&status(store, exe)?).map_err(|err| err.to_string())
        }
    }?;
    // After a removal nothing may be recorded any more: then the record key itself goes too.
    if matches!(
        action,
        Action::RemovePath | Action::RemoveExplorer | Action::RemoveAll
    ) {
        store.delete_key_if_empty(RECORD_KEY)?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests;
