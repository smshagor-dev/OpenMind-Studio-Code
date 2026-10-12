use std::collections::HashMap;
use std::path::PathBuf;

use super::*;

/// An in-memory `HKCU`: keys are case-insensitive, like the Registry.
#[derive(Default)]
struct Fake {
    path: Option<(String, bool)>,
    values: HashMap<(String, String), String>,
    /// Keys that exist (a write creates its key, as the Registry does).
    keys: std::collections::HashSet<String>,
    broadcasts: usize,
}

fn key_of(key: &str, name: &str) -> (String, String) {
    (key.to_lowercase(), name.to_lowercase())
}

impl Store for Fake {
    fn user_path(&self) -> Result<Option<(String, bool)>, String> {
        Ok(self.path.clone())
    }
    fn set_user_path(&mut self, value: &str, expandable: bool) -> Result<(), String> {
        self.path = Some((value.to_string(), expandable));
        Ok(())
    }
    fn value(&self, key: &str, name: &str) -> Result<Option<String>, String> {
        Ok(self.values.get(&key_of(key, name)).cloned())
    }
    fn set_value(&mut self, key: &str, name: &str, value: &str) -> Result<(), String> {
        self.values.insert(key_of(key, name), value.to_string());
        self.keys.insert(key.to_lowercase());
        Ok(())
    }
    fn delete_value(&mut self, key: &str, name: &str) -> Result<(), String> {
        self.values.remove(&key_of(key, name));
        Ok(())
    }
    fn delete_tree(&mut self, key: &str) -> Result<(), String> {
        let prefix = key.to_lowercase();
        let inside = |k: &String| k == &prefix || k.starts_with(&format!("{prefix}\\"));
        self.values.retain(|(k, _), _| !inside(k));
        self.keys.retain(|k| !inside(k));
        Ok(())
    }
    fn delete_key_if_empty(&mut self, key: &str) -> Result<(), String> {
        let key = key.to_lowercase();
        let used = self.values.keys().any(|(k, _)| k == &key)
            || self.keys.iter().any(|k| k.starts_with(&format!("{key}\\")));
        if !used {
            self.keys.remove(&key);
        }
        Ok(())
    }
    fn expand(&self, text: &str) -> String {
        text.replace("%LOCALAPPDATA%", r"C:\Users\Ivan\AppData\Local")
    }
    fn environment_changed(&mut self) {
        self.broadcasts += 1;
    }
}

/// A copy of the app in a temporary folder whose path has spaces.
fn app() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().expect("tmp");
    let dir = tmp.path().join("Open Mind Studio");
    std::fs::create_dir_all(&dir).expect("dir");
    let exe = dir.join("OpenMindStudio.exe");
    (tmp, exe)
}

fn no_expand(text: &str) -> String {
    text.to_string()
}

#[test]
fn path_entries_are_added_once_in_any_spelling() {
    let dir = r"C:\Users\Ivan\AppData\Local\OpenMind Studio\bin";
    assert_eq!(path_with("", dir, &no_expand).as_deref(), Some(dir));
    assert_eq!(
        path_with(r"C:\a;C:\b", dir, &no_expand).as_deref(),
        Some(format!(r"C:\a;C:\b;{dir}").as_str())
    );
    assert_eq!(
        path_with(r"C:\a;", dir, &no_expand).as_deref(),
        Some(format!(r"C:\a;{dir}").as_str())
    );
    for spelling in [
        dir.to_string(),
        dir.to_uppercase(),
        format!("{dir}\\"),
        format!("\"{dir}\""),
        dir.replace('\\', "/"),
    ] {
        assert_eq!(
            path_with(&format!(r"C:\a;{spelling}"), dir, &no_expand),
            None,
            "{spelling}"
        );
    }
    let fake = Fake::default();
    let expand = |text: &str| fake.expand(text);
    assert_eq!(
        path_with(r"%LOCALAPPDATA%\OpenMind Studio\bin", dir, &expand),
        None
    );
}

#[test]
fn only_the_matching_entry_is_removed_and_the_rest_stay_as_written() {
    let dir = r"C:\Apps\OpenMind Studio\bin";
    let current = format!(r"%SystemRoot%\system32;{dir};C:\Tools\;;C:\Apps\OpenMind Studio");
    assert_eq!(
        path_without(&current, dir, &no_expand).as_deref(),
        Some(r"%SystemRoot%\system32;C:\Tools\;;C:\Apps\OpenMind Studio")
    );
    assert_eq!(path_without(r"C:\a;C:\b", dir, &no_expand), None);
    // A sibling whose name starts the same is another folder.
    assert_eq!(
        path_without(r"C:\Apps\OpenMind Studio\bin2", dir, &no_expand),
        None
    );
}

#[test]
fn explorer_commands_quote_the_program_and_the_placeholder() {
    let exe = Path::new(r"C:\Program Files\OpenMind Studio\OpenMindStudio.exe");
    assert_eq!(
        menu_command(exe, "%V"),
        r#""C:\Program Files\OpenMind Studio\OpenMindStudio.exe" "%V""#
    );
    assert_eq!(
        menu_icon(exe),
        r#""C:\Program Files\OpenMind Studio\OpenMindStudio.exe",0"#
    );
    let placeholders: Vec<&str> = MENU_KEYS.iter().map(|(_, p)| *p).collect();
    assert_eq!(placeholders, ["%V", "%V", "%1"]);
    assert!(MENU_KEYS
        .iter()
        .all(|(key, _)| key.starts_with(r"Software\Classes\")));
}

#[test]
fn add_then_remove_path_restores_the_users_path_exactly() {
    let (_tmp, exe) = app();
    let mut store = Fake {
        path: Some((r"C:\Tools;%USERPROFILE%\bin".into(), true)),
        ..Fake::default()
    };
    let bin = exe.parent().expect("dir").join("bin");
    add_path(&mut store, &exe).expect("add");
    let (value, expandable) = store.path.clone().expect("path");
    assert_eq!(
        value,
        format!(r"C:\Tools;%USERPROFILE%\bin;{}", bin.display())
    );
    assert!(expandable, "the value type is kept");
    assert!(bin.join("openmind.cmd").is_file() && bin.join("openmind").is_file());
    assert_eq!(store.broadcasts, 1);
    // A second add changes nothing.
    add_path(&mut store, &exe).expect("again");
    assert_eq!(store.path.as_ref().map(|p| p.0.clone()), Some(value));
    let status = status(&store, &exe).expect("status");
    assert!(status.path_present && status.path_added);
    remove_path(&mut store, &exe).expect("remove");
    assert_eq!(
        store.path,
        Some((r"C:\Tools;%USERPROFILE%\bin".into(), true))
    );
    assert!(store
        .value(RECORD_KEY, &normalize(&bin.display().to_string()))
        .expect("v")
        .is_none());
}

#[test]
fn an_entry_that_was_already_there_is_never_recorded_or_removed() {
    let (_tmp, exe) = app();
    let bin = exe.parent().expect("dir").join("bin").display().to_string();
    let mut store = Fake {
        path: Some((format!(r"C:\Tools;{bin}"), false)),
        ..Fake::default()
    };
    let message = add_path(&mut store, &exe).expect("add");
    assert!(message.contains("already on your PATH"), "{message}");
    let message = remove_path(&mut store, &exe).expect("remove");
    assert!(message.contains("nothing removed"), "{message}");
    assert_eq!(store.path, Some((format!(r"C:\Tools;{bin}"), false)));
    assert_eq!(store.broadcasts, 0);
}

#[test]
fn a_missing_user_path_is_created_and_a_semicolon_folder_is_refused() {
    let (_tmp, exe) = app();
    let mut store = Fake::default();
    add_path(&mut store, &exe).expect("add");
    let (value, expandable) = store.path.clone().expect("path");
    assert!(value.ends_with(r"Open Mind Studio\bin") && expandable);
    let odd = std::env::temp_dir().join("a;b").join("OpenMindStudio.exe");
    assert!(add_path(&mut Fake::default(), &odd).is_err());
}

#[test]
fn explorer_entries_are_removed_only_when_they_run_this_copy() {
    let (_tmp, exe) = app();
    let other = PathBuf::from(r"D:\Portable\OpenMind Studio\OpenMindStudio.exe");
    let mut store = Fake::default();
    store
        .set_value(
            r"Software\Classes\Directory\shell\Unrelated\command",
            "",
            "x",
        )
        .expect("set");
    add_explorer(&mut store, &exe).expect("add");
    for (key, placeholder) in MENU_KEYS {
        assert_eq!(
            store.value(key, "").expect("v").as_deref(),
            Some(MENU_LABEL)
        );
        assert_eq!(
            store.value(&format!(r"{key}\command"), "").expect("v"),
            Some(menu_command(&exe, placeholder))
        );
    }
    assert!(status(&store, &exe).expect("status").explorer_this_copy);
    // Another copy's removal leaves this copy's entries alone.
    let message = remove_explorer(&mut store, &other).expect("other");
    assert!(message.contains("nothing removed"), "{message}");
    assert!(status(&store, &other)
        .expect("s")
        .explorer_other_copy
        .is_some());
    remove_explorer(&mut store, &exe).expect("remove");
    for (key, _) in MENU_KEYS {
        assert!(store.value(key, "").expect("v").is_none());
        assert!(store
            .value(&format!(r"{key}\command"), "")
            .expect("v")
            .is_none());
    }
    assert_eq!(
        store
            .value(r"Software\Classes\Directory\shell\Unrelated\command", "")
            .expect("v")
            .as_deref(),
        Some("x"),
        "an unrelated key survives"
    );
    assert!(store
        .value(RECORD_KEY, EXPLORER_RECORD)
        .expect("v")
        .is_none());
}

#[test]
fn remove_all_takes_the_emptied_record_key_away_too() {
    // Found by the installer smoke test: the uninstaller left an empty record key behind.
    let (_tmp, exe) = app();
    let mut store = Fake {
        path: Some((r"C:\Tools".into(), true)),
        ..Fake::default()
    };
    store
        .set_value(r"Software\OpenMind\Other", "x", "y")
        .expect("unrelated");
    run(&mut store, &exe, Action::AddPath).expect("add path");
    run(&mut store, &exe, Action::AddExplorer).expect("add explorer");
    assert!(store.keys.contains(&RECORD_KEY.to_lowercase()));
    run(&mut store, &exe, Action::RemoveAll).expect("remove all");
    assert!(
        !store.keys.contains(&RECORD_KEY.to_lowercase()),
        "record key removed"
    );
    assert!(store
        .keys
        .iter()
        .all(|k| !k.contains(r"\shell\openmindstudio")));
    assert!(
        store.keys.contains(r"software\openmind\other"),
        "an unrelated key survives"
    );
    assert_eq!(store.path, Some((r"C:\Tools".into(), true)));
    // With another copy's record still there, the key stays.
    store
        .set_value(RECORD_KEY, r"d:\other\bin", r"D:\Other\bin")
        .expect("other copy");
    run(&mut store, &exe, Action::RemoveAll).expect("again");
    assert!(store.keys.contains(&RECORD_KEY.to_lowercase()));
}

#[test]
fn remove_all_is_safe_when_nothing_was_added_and_actions_parse() {
    let (_tmp, exe) = app();
    let mut store = Fake {
        path: Some((r"C:\Tools".into(), true)),
        ..Fake::default()
    };
    run(&mut store, &exe, Action::RemoveAll).expect("remove all");
    assert_eq!(store.path, Some((r"C:\Tools".into(), true)));
    assert!(store.values.is_empty());
    for (text, action) in [
        ("add-path", Action::AddPath),
        ("remove-path", Action::RemovePath),
        ("add-explorer", Action::AddExplorer),
        ("remove-explorer", Action::RemoveExplorer),
        ("remove-all", Action::RemoveAll),
        ("status", Action::Status),
    ] {
        assert_eq!(Action::parse(text), Some(action));
    }
    assert_eq!(Action::parse("--add-path"), None);
}

#[test]
fn the_launchers_are_the_shipped_files_and_point_at_the_program_beside_bin() {
    let cmd = LAUNCHERS[0].1;
    assert!(cmd.contains("\r\n"), "a batch file has CRLF line endings");
    assert!(cmd.contains(r#"start "" "%~dp0..\OpenMindStudio.exe" %*"#));
    assert!(LAUNCHERS[1]
        .1
        .contains(r#""$(dirname "$0")/../OpenMindStudio.exe" "$@""#));
    let tmp = tempfile::tempdir().expect("tmp");
    let bin = tmp.path().join("bin");
    write_launchers(&bin).expect("write");
    write_launchers(&bin).expect("again");
    assert_eq!(
        std::fs::read_to_string(bin.join("openmind.cmd")).expect("read"),
        cmd
    );
}

#[test]
fn installations_are_remembered_for_the_setup_and_forgotten_by_the_uninstaller() {
    let mut store = Fake::default();
    let shared = r"\lab\apps\OpenMind Studio";
    let mine = r"C:\Users\Ivan\AppData\Local\OpenMind Studio";
    remember_installation(&mut store, shared, "1.0.2").expect("remember");
    remember_installation(&mut store, mine, "1.0.3").expect("remember");
    assert_eq!(
        store
            .value(INSTALLATIONS_KEY, shared)
            .expect("read")
            .as_deref(),
        Some("1.0.2")
    );
    // The default value names the folder started last: the setup looks there first.
    assert_eq!(
        store.value(INSTALLATIONS_KEY, "").expect("read").as_deref(),
        Some(mine)
    );

    // Forgetting the last-started folder (in another case: value names are case-insensitive) also clears the default.
    forget_installation(&mut store, &mine.to_uppercase()).expect("forget");
    assert_eq!(store.value(INSTALLATIONS_KEY, mine).expect("read"), None);
    assert_eq!(store.value(INSTALLATIONS_KEY, "").expect("read"), None);
    assert!(
        store.keys.contains(&INSTALLATIONS_KEY.to_lowercase()),
        "the shared copy is still recorded"
    );

    forget_installation(&mut store, shared).expect("forget");
    assert!(
        !store.keys.contains(&INSTALLATIONS_KEY.to_lowercase()),
        "an empty record key goes"
    );
}
