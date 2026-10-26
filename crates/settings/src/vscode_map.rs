//! How a VS Code setting or shortcut becomes an OpenMind one. VS Code and OpenMind share many setting ids, but not
//! the shape of every value (`editor.wordWrap: "on"` is a boolean here) nor any command id
//! (`workbench.action.files.save` is `file.save`). Anything without a faithful equivalent is reported, never guessed.
use serde_json::Value;

use crate::keybindings::{self, KeybindingEntry};
use crate::schema::{self, Extras};

/// VS Code's command id -> OpenMind's, for every command OpenMind has a shortcut-worthy equivalent of.
pub const COMMANDS: &[(&str, &str)] = &[
    ("workbench.action.files.newUntitledFile", "file.new"),
    ("workbench.action.newWindow", "workbench.newWindow"),
    ("workbench.action.files.openFile", "file.open"),
    ("workbench.action.files.openFolder", "file.openFolder"),
    ("workbench.action.files.openFileFolder", "file.open"),
    ("workbench.action.reopenClosedEditor", "file.reopenClosed"),
    ("workbench.action.files.save", "file.save"),
    ("workbench.action.files.saveAs", "file.saveAs"),
    ("workbench.action.files.saveAll", "file.saveAll"),
    ("workbench.action.closeActiveEditor", "file.closeActiveTab"),
    ("workbench.action.closeWindow", "file.closeWindow"),
    ("undo", "edit.undo"),
    ("redo", "edit.redo"),
    ("editor.action.clipboardCutAction", "edit.cut"),
    ("editor.action.clipboardCopyAction", "edit.copy"),
    ("editor.action.clipboardPasteAction", "edit.paste"),
    ("actions.find", "edit.find"),
    ("editor.action.startFindReplaceAction", "edit.replace"),
    ("editor.action.commentLine", "edit.toggleLineComment"),
    ("editor.action.blockComment", "edit.toggleBlockComment"),
    ("editor.action.formatDocument", "edit.formatDocument"),
    ("editor.action.rename", "edit.renameSymbol"),
    ("editor.action.changeAll", "edit.changeAllOccurrences"),
    ("editor.action.refactor", "edit.refactor"),
    ("editor.action.selectAll", "selection.selectAll"),
    (
        "editor.action.insertCursorAbove",
        "selection.addCursorAbove",
    ),
    (
        "editor.action.insertCursorBelow",
        "selection.addCursorBelow",
    ),
    (
        "editor.action.insertCursorAtEndOfEachLineSelected",
        "selection.addCursorsToLineEnds",
    ),
    (
        "editor.action.addSelectionToNextFindMatch",
        "selection.addNextOccurrence",
    ),
    (
        "editor.action.selectHighlights",
        "selection.selectAllOccurrences",
    ),
    (
        "editor.action.copyLinesDownAction",
        "selection.copyLineDown",
    ),
    ("editor.action.copyLinesUpAction", "selection.copyLineUp"),
    (
        "editor.action.moveLinesDownAction",
        "selection.moveLineDown",
    ),
    ("editor.action.moveLinesUpAction", "selection.moveLineUp"),
    ("editor.action.smartSelect.expand", "selection.expand"),
    ("editor.action.smartSelect.shrink", "selection.shrink"),
    ("workbench.action.showCommands", "workbench.commandPalette"),
    ("workbench.action.quickOpen", "go.toFile"),
    ("workbench.action.gotoLine", "go.toLine"),
    ("workbench.action.gotoSymbol", "go.toSymbolInEditor"),
    ("workbench.action.showAllSymbols", "go.toSymbolInWorkspace"),
    ("workbench.action.nextEditor", "go.nextEditor"),
    ("workbench.action.previousEditor", "go.previousEditor"),
    ("editor.action.marker.nextInFiles", "go.nextProblem"),
    ("editor.action.marker.prevInFiles", "go.previousProblem"),
    ("editor.action.jumpToBracket", "go.toBracket"),
    ("editor.action.revealDefinition", "go.toDefinition"),
    ("editor.action.goToImplementation", "go.toImplementations"),
    ("editor.action.goToReferences", "go.toReferences"),
    ("workbench.action.findInFiles", "search.findInFiles"),
    ("workbench.action.replaceInFiles", "search.replaceInFiles"),
    (
        "workbench.action.toggleSidebarVisibility",
        "view.toggleSidebar",
    ),
    ("workbench.action.togglePanel", "view.togglePanel"),
    (
        "workbench.action.toggleAuxiliaryBar",
        "view.toggleSecondarySidebar",
    ),
    ("workbench.action.toggleFullScreen", "view.toggleFullScreen"),
    ("editor.action.toggleWordWrap", "view.toggleWordWrap"),
    ("workbench.action.zoomIn", "view.zoomIn"),
    ("workbench.action.zoomOut", "view.zoomOut"),
    ("workbench.action.zoomReset", "view.zoomReset"),
    ("workbench.view.explorer", "view.showExplorer"),
    ("workbench.view.extensions", "view.showExtensions"),
    ("workbench.view.scm", "view.showSourceControl"),
    ("workbench.view.debug", "view.showRun"),
    ("workbench.action.output.toggleOutput", "view.showOutput"),
    ("workbench.actions.view.problems", "view.showProblems"),
    ("workbench.action.splitEditor", "editorLayout.splitRight"),
    (
        "workbench.action.splitEditorRight",
        "editorLayout.splitRight",
    ),
    (
        "workbench.action.terminal.toggleTerminal",
        "terminal.toggle",
    ),
    ("workbench.action.terminal.new", "terminal.new"),
    ("workbench.action.terminal.split", "terminal.split"),
    ("workbench.action.openSettings", "preferences.openSettings"),
    (
        "workbench.action.openGlobalKeybindings",
        "preferences.openKeybindings",
    ),
    ("workbench.action.debug.start", "debug.start"),
    ("workbench.action.debug.stop", "debug.stop"),
    ("workbench.action.debug.stepOver", "debug.stepOver"),
    ("workbench.action.debug.stepInto", "debug.stepInto"),
    ("workbench.action.debug.stepOut", "debug.stepOut"),
    (
        "editor.debug.action.toggleBreakpoint",
        "debug.toggleBreakpoint",
    ),
    ("workbench.action.debug.run", "run.code"),
    ("workbench.action.tasks.build", "tasks.runBuild"),
    ("workbench.action.tasks.runTask", "tasks.run"),
];

/// OpenMind's command for a VS Code command id.
pub fn command(vscode: &str) -> Option<&'static str> {
    COMMANDS
        .iter()
        .find(|(from, _)| *from == vscode)
        .map(|(_, to)| *to)
}

/// One VS Code `keybindings.json` row as an OpenMind entry, or why it can't be one. A command an installed
/// OpenMind extension contributes keeps its id (an imported VS Code extension keeps its command ids).
pub fn keybinding(
    key: &str,
    command_id: &str,
    extension_commands: &[String],
) -> Result<KeybindingEntry, String> {
    if key.trim().contains(' ') {
        return Err(format!("Key sequence not supported: {key}"));
    }
    let (removal, name) = match command_id.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, command_id),
    };
    let target = match command(name) {
        Some(mapped) => mapped.to_string(),
        None if extension_commands.iter().any(|known| known == name) => name.to_string(),
        None => return Err(format!("No OpenMind equivalent: {name}")),
    };
    let command = if removal {
        format!("-{target}")
    } else {
        target
    };
    keybindings::normalize_entries(&[KeybindingEntry {
        key: key.into(),
        command,
    }])
    .map_err(|_| format!("Unsupported key: {key}"))?
    .pop()
    .ok_or_else(|| format!("Unsupported key: {key}"))
}

/// The user's existing shortcuts with the imported ones added: an imported binding replaces the user's own binding
/// of the same key (VS Code's choice wins for that key), every other existing entry is kept.
pub fn merge_keybindings(
    existing: &[KeybindingEntry],
    imported: &[KeybindingEntry],
) -> Vec<KeybindingEntry> {
    let imported_keys: Vec<&str> = imported
        .iter()
        .filter(|entry| !entry.command.starts_with('-'))
        .map(|entry| entry.key.as_str())
        .collect();
    let mut merged: Vec<KeybindingEntry> = existing
        .iter()
        .filter(|entry| {
            entry.command.starts_with('-') || !imported_keys.contains(&entry.key.as_str())
        })
        .cloned()
        .collect();
    for entry in imported {
        if !merged.contains(entry) {
            merged.push(entry.clone());
        }
    }
    merged
}

const THEMES: &[(&str, &str)] = &[
    ("Default Dark Modern", "dark"),
    ("Default Dark+", "dark"),
    ("Dark Modern", "dark"),
    ("Dark+", "dark"),
    ("Dark+ (default dark)", "dark"),
    ("Visual Studio Dark", "dark"),
    ("Default Dark", "dark"),
    ("Default Light Modern", "light"),
    ("Default Light+", "light"),
    ("Light Modern", "light"),
    ("Light+", "light"),
    ("Light+ (default light)", "light"),
    ("Visual Studio Light", "light"),
    ("Default Light", "light"),
    ("Default High Contrast", "high-contrast"),
    ("Dark High Contrast", "high-contrast"),
    ("Default High Contrast Light", "high-contrast"),
    ("Light High Contrast", "high-contrast"),
];

fn theme(name: &str, extras: &Extras) -> Option<String> {
    if let Some((_, value)) = THEMES
        .iter()
        .find(|(label, _)| label.eq_ignore_ascii_case(name))
    {
        return Some((*value).to_string());
    }
    // An installed extension's theme with that label (an imported VS Code theme extension keeps its labels).
    extras
        .themes
        .iter()
        .find(|option| option.label == name)
        .map(|option| option.value.clone())
}

/// The OpenMind id and value for a VS Code setting before validation, or why there is none.
fn translate(id: &str, value: &Value, extras: &Extras) -> Result<(String, Value), String> {
    let text = value.as_str();
    let mapped = match id {
        "editor.minimap.enabled" => ("editor.minimap", value.clone()),
        "editor.stickyScroll.enabled" => ("editor.stickyScroll", value.clone()),
        "terminal.integrated.fontSize" => ("terminal.fontSize", value.clone()),
        "terminal.integrated.fontFamily" => ("terminal.fontFamily", value.clone()),
        "terminal.integrated.cursorBlinking" => ("terminal.cursorBlink", value.clone()),
        "terminal.integrated.scrollback" => ("terminal.scrollback", value.clone()),
        "editor.wordWrap" => match text {
            Some("off") => ("editor.wordWrap", Value::Bool(false)),
            Some("on" | "wordWrapColumn" | "bounded") => ("editor.wordWrap", Value::Bool(true)),
            _ => return Err("value not supported".into()),
        },
        "editor.renderWhitespace" => match text {
            Some("none") => ("editor.renderWhitespace", Value::Bool(false)),
            Some("boundary" | "selection" | "trailing" | "all") => {
                ("editor.renderWhitespace", Value::Bool(true))
            }
            _ => return Err("value not supported".into()),
        },
        "workbench.colorTheme" => {
            let found = text
                .and_then(|name| theme(name, extras))
                .ok_or("theme not available in OpenMind")?;
            ("workbench.colorTheme", Value::String(found))
        }
        "workbench.iconTheme" => match text {
            Some("material-icon-theme") => {
                ("workbench.iconTheme", Value::String("material".into()))
            }
            None if value.is_null() => ("workbench.iconTheme", Value::String("minimal".into())),
            _ => return Err("icon theme not available in OpenMind".into()),
        },
        "workbench.startupEditor" => match text {
            Some("welcomePage" | "welcomePageInEmptyWorkbench") => {
                ("workbench.welcomeOnStartup", Value::Bool(true))
            }
            Some("none" | "newUntitledFile") => ("workbench.welcomeOnStartup", Value::Bool(false)),
            _ => return Err("value not supported".into()),
        },
        "search.exclude" => {
            let patterns: Vec<&str> = value
                .as_object()
                .ok_or("value not supported")?
                .iter()
                .filter(|(_, on)| on.as_bool() == Some(true))
                .map(|(pattern, _)| pattern.as_str())
                .collect();
            ("search.exclude", Value::String(patterns.join(", ")))
        }
        _ => (id, value.clone()),
    };
    Ok((mapped.0.to_string(), mapped.1))
}

/// A VS Code setting as a validated OpenMind setting, or the line that tells the user why it was left out.
pub fn setting(id: &str, value: &Value, extras: &Extras) -> Result<(String, Value), String> {
    let (target, value) =
        translate(id, value, extras).map_err(|reason| format!("{id} ({reason})"))?;
    let definition =
        schema::find(&target, extras).ok_or_else(|| format!("{id} (no OpenMind equivalent)"))?;
    let value =
        schema::validate(&definition, &value).map_err(|_| format!("{id} (value not supported)"))?;
    Ok((target, value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::EnumOption;
    use serde_json::json;

    fn entry(key: &str, command: &str) -> KeybindingEntry {
        KeybindingEntry {
            key: key.into(),
            command: command.into(),
        }
    }

    #[test]
    fn vscode_values_become_openmind_values() {
        let none = Extras::default();
        assert_eq!(
            setting("editor.wordWrap", &json!("on"), &none),
            Ok(("editor.wordWrap".into(), json!(true)))
        );
        assert_eq!(
            setting("editor.renderWhitespace", &json!("none"), &none),
            Ok(("editor.renderWhitespace".into(), json!(false)))
        );
        assert_eq!(
            setting("workbench.colorTheme", &json!("Default Dark Modern"), &none),
            Ok(("workbench.colorTheme".into(), json!("dark")))
        );
        assert_eq!(
            setting("terminal.integrated.fontSize", &json!(16), &none),
            Ok(("terminal.fontSize".into(), json!(16)))
        );
        assert_eq!(
            setting(
                "search.exclude",
                &json!({"**/dist": true, "**/tmp": false}),
                &none
            ),
            Ok(("search.exclude".into(), json!("**/dist")))
        );
        assert_eq!(
            setting("editor.fontSize", &json!(15), &none),
            Ok(("editor.fontSize".into(), json!(15)))
        );
    }

    #[test]
    fn unsupported_settings_say_why() {
        let none = Extras::default();
        assert_eq!(
            setting("workbench.colorTheme", &json!("Monokai"), &none),
            Err("workbench.colorTheme (theme not available in OpenMind)".into())
        );
        assert_eq!(
            setting("editor.lineNumbers", &json!("interval"), &none),
            Err("editor.lineNumbers (value not supported)".into())
        );
        assert_eq!(
            setting("vim.useCtrlKeys", &json!(true), &none),
            Err("vim.useCtrlKeys (no OpenMind equivalent)".into())
        );
    }

    #[test]
    fn an_installed_extension_theme_is_matched_by_label() {
        let extras = Extras {
            themes: vec![EnumOption {
                value: "extension:acme.dracula/Dracula".into(),
                label: "Dracula".into(),
            }],
            ..Extras::default()
        };
        assert_eq!(
            setting("workbench.colorTheme", &json!("Dracula"), &extras),
            Ok((
                "workbench.colorTheme".into(),
                json!("extension:acme.dracula/Dracula")
            ))
        );
    }

    #[test]
    fn vscode_commands_are_translated_and_unknown_ones_refused() {
        assert_eq!(
            keybinding("ctrl+alt+s", "workbench.action.files.saveAll", &[]),
            Ok(entry("Ctrl+Alt+S", "file.saveAll"))
        );
        assert_eq!(
            keybinding("ctrl+s", "-workbench.action.files.save", &[]),
            Ok(entry("Ctrl+S", "-file.save"))
        );
        assert_eq!(
            keybinding("ctrl+k ctrl+s", "workbench.action.files.save", &[]),
            Err("Key sequence not supported: ctrl+k ctrl+s".into())
        );
        assert_eq!(
            keybinding("ctrl+alt+g", "gitlens.showGraph", &[]),
            Err("No OpenMind equivalent: gitlens.showGraph".into())
        );
        assert_eq!(
            keybinding(
                "ctrl+alt+g",
                "gitlens.showGraph",
                &["gitlens.showGraph".into()]
            ),
            Ok(entry("Ctrl+Alt+G", "gitlens.showGraph"))
        );
    }

    #[test]
    fn merging_keeps_the_users_shortcuts_and_lets_the_import_win_its_keys() {
        let existing = vec![
            entry("Ctrl+Alt+R", "run.code"),
            entry("Ctrl+Alt+T", "terminal.new"),
            entry("F5", "-debug.start"),
        ];
        let imported = vec![
            entry("Ctrl+Alt+T", "terminal.toggle"),
            entry("Ctrl+Alt+S", "file.saveAll"),
        ];
        assert_eq!(
            merge_keybindings(&existing, &imported),
            vec![
                entry("Ctrl+Alt+R", "run.code"),
                entry("F5", "-debug.start"),
                entry("Ctrl+Alt+T", "terminal.toggle"),
                entry("Ctrl+Alt+S", "file.saveAll"),
            ]
        );
    }
}
