use serde::Serialize;
use serde_json::{json, Value};

/// Where a setting may be set: `Both` settings can be overridden per workspace folder,
/// `User` settings (theme, terminal fonts, the PHP server) only exist for the whole app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SettingScope {
    User,
    Both,
}

/// What a setting holds and what it accepts. Everything a UI needs to draw the right control and
/// everything validation needs to refuse a bad value, so both live in one place.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum SettingKind {
    Bool,
    Int {
        min: i64,
        max: i64,
    },
    Text {
        #[serde(rename = "maxLength")]
        max_length: usize,
    },
    Enum {
        options: Vec<EnumOption>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EnumOption {
    pub value: &'static str,
    pub label: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SettingDef {
    pub id: &'static str,
    pub category: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub kind: SettingKind,
    pub default: Value,
    pub scope: SettingScope,
}

/// The categories in the order the Settings page lists them.
pub const CATEGORIES: &[&str] = &[
    "Editor",
    "Search",
    "Terminal",
    "Runtime & Run Code",
    "Git",
    "Language Servers",
    "Debugger",
    "PHP Server",
    "Workbench",
];

fn opts(pairs: &[(&'static str, &'static str)]) -> SettingKind {
    SettingKind::Enum {
        options: pairs
            .iter()
            .map(|(value, label)| EnumOption { value, label })
            .collect(),
    }
}

#[allow(clippy::too_many_arguments)]
fn def(
    id: &'static str,
    category: &'static str,
    title: &'static str,
    description: &'static str,
    kind: SettingKind,
    default: Value,
    scope: SettingScope,
) -> SettingDef {
    SettingDef {
        id,
        category,
        title,
        description,
        kind,
        default,
        scope,
    }
}

const MONO: &str = "Consolas, 'Cascadia Mono', 'Courier New', monospace";

fn editor_definitions() -> Vec<SettingDef> {
    use SettingScope::Both;
    let int = |min, max| SettingKind::Int { min, max };
    let text = || SettingKind::Text { max_length: 200 };
    vec![
        def(
            "editor.fontSize",
            "Editor",
            "Font Size",
            "Font size of the editor in pixels.",
            int(8, 40),
            json!(14),
            Both,
        ),
        def(
            "editor.fontFamily",
            "Editor",
            "Font Family",
            "Font family list of the editor, most preferred first.",
            text(),
            json!(MONO),
            Both,
        ),
        def(
            "editor.tabSize",
            "Editor",
            "Tab Size",
            "Number of spaces a tab is equal to.",
            int(1, 16),
            json!(4),
            Both,
        ),
        def(
            "editor.insertSpaces",
            "Editor",
            "Insert Spaces",
            "Insert spaces when pressing Tab.",
            SettingKind::Bool,
            json!(true),
            Both,
        ),
        def(
            "editor.lineNumbers",
            "Editor",
            "Line Numbers",
            "Controls how line numbers are shown.",
            opts(&[("on", "On"), ("off", "Off"), ("relative", "Relative")]),
            json!("on"),
            Both,
        ),
        def(
            "editor.cursorBlinking",
            "Editor",
            "Cursor Blinking",
            "Animation style of the editor cursor.",
            opts(&[
                ("blink", "Blink"),
                ("smooth", "Smooth"),
                ("phase", "Phase"),
                ("expand", "Expand"),
                ("solid", "Solid"),
            ]),
            json!("blink"),
            Both,
        ),
        def(
            "editor.wordWrap",
            "Editor",
            "Word Wrap",
            "Wrap long lines at the edge of the editor.",
            SettingKind::Bool,
            json!(false),
            Both,
        ),
        def(
            "editor.minimap",
            "Editor",
            "Minimap",
            "Show the minimap on the right of the editor.",
            SettingKind::Bool,
            json!(true),
            Both,
        ),
        def(
            "editor.stickyScroll",
            "Editor",
            "Sticky Scroll",
            "Keep the enclosing scopes visible at the top while scrolling.",
            SettingKind::Bool,
            json!(true),
            Both,
        ),
        def(
            "editor.renderWhitespace",
            "Editor",
            "Render Whitespace",
            "Show spaces and tabs as dots and arrows.",
            SettingKind::Bool,
            json!(true),
            Both,
        ),
    ]
}

fn tools_definitions() -> Vec<SettingDef> {
    use SettingScope::{Both, User};
    let text = |max_length| SettingKind::Text { max_length };
    vec![
        def("search.caseSensitive", "Search", "Match Case", "Search is case sensitive by default.", SettingKind::Bool, json!(false), Both),
        def("search.useRegex", "Search", "Use Regular Expression", "Search queries are regular expressions by default.", SettingKind::Bool, json!(false), Both),
        def("search.wholeWord", "Search", "Match Whole Word", "Search matches whole words only by default.", SettingKind::Bool, json!(false), Both),
        def("search.include", "Search", "Files to Include", "Default glob patterns of the search's include field, separated by commas.", text(300), json!(""), Both),
        def("search.exclude", "Search", "Files to Exclude", "Default glob patterns of the search's exclude field, separated by commas.", text(300), json!(""), Both),
        def("terminal.fontSize", "Terminal", "Font Size", "Font size of the integrated terminal in pixels.", SettingKind::Int { min: 8, max: 32 }, json!(14), User),
        def("terminal.fontFamily", "Terminal", "Font Family", "Font family list of the integrated terminal.", text(200), json!(MONO), User),
        def("terminal.cursorBlink", "Terminal", "Cursor Blink", "The terminal cursor blinks.", SettingKind::Bool, json!(true), User),
        def("terminal.scrollback", "Terminal", "Scrollback", "Number of lines a terminal keeps.", SettingKind::Int { min: 500, max: 100_000 }, json!(5000), User),
        def("run.saveBeforeRun", "Runtime & Run Code", "Save Before Run", "Save the file before Run Code runs it. When off, a file with unsaved changes can't be run.", SettingKind::Bool, json!(true), Both),
        def("run.clearOutputBeforeRun", "Runtime & Run Code", "Clear Output Before Run", "Clear the language's Output channel each time Run Code starts.", SettingKind::Bool, json!(true), Both),
        def("git.autoRefresh", "Git", "Auto Refresh", "Refresh Source Control when the window gets focus and when files change.", SettingKind::Bool, json!(true), Both),
        def("git.showBranchInStatusBar", "Git", "Show Branch in Status Bar", "Show the current branch in the status bar.", SettingKind::Bool, json!(true), Both),
        def("lsp.enabled", "Language Servers", "Enable Language Servers", "Start language servers for files in the open folder. Turning it off stops the running ones.", SettingKind::Bool, json!(true), Both),
        def("lsp.verboseLogging", "Language Servers", "Verbose Logging", "Write every message exchanged with a language server to the LSP output channel.", SettingKind::Bool, json!(false), User),
        def("debug.stopOnEntry", "Debugger", "Stop on Entry", "Pause at the first line when a debug session starts.", SettingKind::Bool, json!(false), Both),
        def("debug.openConsoleOnStart", "Debugger", "Open Debug Console on Start", "Show the Debug Console panel when a debug session starts (off: the panel opens only when you open it).", SettingKind::Bool, json!(false), Both),
    ]
}

fn app_definitions() -> Vec<SettingDef> {
    use SettingScope::User;
    vec![
        def("php.server.defaultPort", "PHP Server", "Default Port", "Port the PHP server uses until you choose another one in the PHP control panel.", SettingKind::Int { min: 1024, max: 65_535 }, json!(8000), User),
        def("php.tray.hideOnClose", "PHP Server", "Keep Servers Running in the Tray", "Closing the main window while a PHP, MariaDB or phpMyAdmin server runs hides the app to the system tray instead of quitting.", SettingKind::Bool, json!(true), User),
        def("workbench.colorTheme", "Workbench", "Color Theme", "Colors of the workbench, the editor and the terminal. System follows Windows.", opts(&[("system", "System"), ("dark", "Dark"), ("light", "Light"), ("high-contrast", "High Contrast")]), json!("dark"), User),
        def("workbench.welcomeOnStartup", "Workbench", "Show Welcome Page on Startup", "Open the Welcome page when the app starts.", SettingKind::Bool, json!(true), User),
    ]
}

/// Every setting, in the order the Settings page shows them.
pub fn definitions() -> Vec<SettingDef> {
    let mut all = editor_definitions();
    all.extend(tools_definitions());
    all.extend(app_definitions());
    all
}

pub fn find(id: &str) -> Option<SettingDef> {
    definitions().into_iter().find(|def| def.id == id)
}

/// Why `value` isn't acceptable for `def`, in words a user can act on; `Ok` carries the value
/// as it will be stored.
pub fn validate(def: &SettingDef, value: &Value) -> Result<Value, String> {
    match &def.kind {
        SettingKind::Bool => value
            .as_bool()
            .map(Value::Bool)
            .ok_or_else(|| format!("{} must be true or false.", def.title)),
        SettingKind::Int { min, max } => {
            let number = value
                .as_i64()
                .ok_or_else(|| format!("{} must be a whole number.", def.title))?;
            if number < *min || number > *max {
                return Err(format!("{} must be between {min} and {max}.", def.title));
            }
            Ok(json!(number))
        }
        SettingKind::Text { max_length } => {
            let text = value
                .as_str()
                .ok_or_else(|| format!("{} must be text.", def.title))?;
            if text.chars().count() > *max_length {
                return Err(format!(
                    "{} can be at most {max_length} characters long.",
                    def.title
                ));
            }
            if text.chars().any(char::is_control) {
                return Err(format!(
                    "{} can't contain line breaks or control characters.",
                    def.title
                ));
            }
            Ok(json!(text))
        }
        SettingKind::Enum { options } => {
            let text = value.as_str().unwrap_or_default();
            if options.iter().any(|option| option.value == text) {
                Ok(json!(text))
            } else {
                let allowed: Vec<&str> = options.iter().map(|option| option.value).collect();
                Err(format!(
                    "{} must be one of: {}.",
                    def.title,
                    allowed.join(", ")
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_and_every_default_is_valid() {
        let all = definitions();
        let mut seen = std::collections::HashSet::new();
        for def in &all {
            assert!(seen.insert(def.id), "duplicate id {}", def.id);
            assert!(
                CATEGORIES.contains(&def.category),
                "{} has an unlisted category",
                def.id
            );
            assert_eq!(
                validate(def, &def.default).as_ref(),
                Ok(&def.default),
                "default of {} is not valid",
                def.id
            );
        }
    }

    #[test]
    fn numbers_are_range_checked_and_must_be_whole() {
        let def = find("editor.fontSize").expect("defined");
        assert_eq!(validate(&def, &json!(18)), Ok(json!(18)));
        assert!(validate(&def, &json!(7)).is_err());
        assert!(validate(&def, &json!(41)).is_err());
        assert!(validate(&def, &json!(12.5)).is_err());
        assert!(validate(&def, &json!("14")).is_err());
    }

    #[test]
    fn enums_booleans_and_text_are_checked() {
        let theme = find("workbench.colorTheme").expect("defined");
        assert_eq!(
            validate(&theme, &json!("high-contrast")),
            Ok(json!("high-contrast"))
        );
        let message = validate(&theme, &json!("neon")).expect_err("neon is not a theme");
        assert!(message.contains("system, dark, light, high-contrast"));
        let wrap = find("editor.wordWrap").expect("defined");
        assert!(validate(&wrap, &json!("yes")).is_err());
        let family = find("editor.fontFamily").expect("defined");
        assert!(validate(&family, &json!("a\nb")).is_err());
        assert!(validate(&family, &json!("x".repeat(201))).is_err());
    }

    #[test]
    fn user_only_settings_are_the_app_wide_ones() {
        for id in [
            "workbench.colorTheme",
            "terminal.fontSize",
            "php.server.defaultPort",
        ] {
            assert_eq!(find(id).expect("defined").scope, SettingScope::User);
        }
        assert_eq!(
            find("editor.fontSize").expect("defined").scope,
            SettingScope::Both
        );
    }
}
