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
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SettingDef {
    pub id: String,
    pub category: String,
    pub title: String,
    pub description: String,
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
    "Extensions",
    "Debugger",
    "AI",
    "PHP Server",
    "Network",
    "Workbench",
];

fn opts(pairs: &[(&str, &str)]) -> SettingKind {
    SettingKind::Enum {
        options: pairs
            .iter()
            .map(|(value, label)| EnumOption {
                value: (*value).to_string(),
                label: (*label).to_string(),
            })
            .collect(),
    }
}

#[allow(clippy::too_many_arguments)]
fn def(
    id: &str,
    category: &str,
    title: &str,
    description: &str,
    kind: SettingKind,
    default: Value,
    scope: SettingScope,
) -> SettingDef {
    SettingDef {
        id: id.to_string(),
        category: category.to_string(),
        title: title.to_string(),
        description: description.to_string(),
        kind,
        default,
        scope,
    }
}

const MONO: &str = "Consolas, 'Cascadia Mono', 'Courier New', monospace";

fn editor_definitions() -> Vec<SettingDef> {
    use SettingScope::{Both, User};
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
        def(
            "files.autoSave",
            "Editor",
            "Auto Save",
            "Save changed files by themselves: after a short delay, when you switch to another editor, or when you leave the window. An unsaved new file is never saved automatically.",
            opts(&[
                ("off", "Off"),
                ("afterDelay", "After Delay"),
                ("onFocusChange", "On Focus Change"),
                ("onWindowChange", "On Window Change"),
            ]),
            json!("off"),
            User,
        ),
        def(
            "files.autoSaveDelay",
            "Editor",
            "Auto Save Delay",
            "Milliseconds after the last edit before Auto Save (After Delay) saves the file.",
            int(100, 60_000),
            json!(1000),
            User,
        ),
        // Formatting (Milestone 15.2). Everything that can start a tool is user-only: a folder you open must not be
        // able to switch on running its own tools from a checked-in settings file.
        def(
            "editor.formatOnSave",
            "Editor",
            "Format on Save",
            "Format a text file with its formatter just before it is saved. If there is no formatter or it fails, the file is still saved as it is.",
            SettingKind::Bool,
            json!(true),
            User,
        ),
        def(
            "editor.defaultFormatter",
            "Editor",
            "Default Formatter",
            "The id of the formatter to prefer (for example prettier, biome, black, ruff, builtin.json). It is used for the languages it supports; other languages ignore it. Format Document With... can set a per-language choice.",
            text(),
            json!(""),
            Both,
        ),
        def(
            "formatter.timeoutMs",
            "Editor",
            "Formatter Time Limit",
            "An external formatter that takes longer than this many milliseconds is stopped and the text is left as it is.",
            int(1000, 120_000),
            json!(10_000),
            User,
        ),
        def(
            "formatter.useProjectLocalTools",
            "Editor",
            "Formatters: Use Project Tools",
            "Run a formatter installed in the open project (node_modules/.bin, .venv, vendor/bin). Project tools are programs from the folder you opened: turn this off for folders you do not trust.",
            SettingKind::Bool,
            json!(true),
            User,
        ),
        def(
            "formatter.useBundledTools",
            "Editor",
            "Formatters: Use Bundled Tools",
            "Run a formatter from OpenMind's own tools folder.",
            SettingKind::Bool,
            json!(true),
            User,
        ),
        def(
            "formatter.useSystemTools",
            "Editor",
            "Formatters: Use System Tools",
            "Also run a formatter found on the computer's PATH when nothing else provides one.",
            SettingKind::Bool,
            json!(false),
            User,
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
        def("search.indexing.enabled", "Search", "Index the Workspace", "Index the open folder in the background so file, text and symbol search are fast. The index stays on this machine, in the app's own folder, and may contain your project's text.", SettingKind::Bool, json!(true), Both),
        def("search.indexing.exclude", "Search", "Index: Files to Exclude", "Glob patterns of files and folders the index never reads, separated by commas (node_modules, .git, target, dist and build are always skipped).", text(300), json!(""), Both),
        def("search.indexing.maxFileSizeKb", "Search", "Index: Largest File", "Files larger than this many kilobytes are listed by name but their text is not indexed.", SettingKind::Int { min: 64, max: 8192 }, json!(1024), Both),
        def("search.indexing.useGitignore", "Search", "Index: Respect .gitignore", "Leave out files that .gitignore files exclude. (.openmindignore files are always honoured.)", SettingKind::Bool, json!(true), Both),
        def("search.indexing.indexHiddenFiles", "Search", "Index: Hidden Files", "Index files and folders whose names start with a dot.", SettingKind::Bool, json!(false), Both),
        def("ai.enabled", "AI", "Enable AI Features", "Show the AI panel and AI commands while at least one AI provider is enabled. Turn it off to hide all AI features (providers and history are kept).", SettingKind::Bool, json!(true), User),
        def("ai.defaultProvider", "AI", "Default Provider", "Id of the provider the AI panel selects first. It is set from the AI provider manager.", text(120), json!(""), User),
        def("ai.defaultModel", "AI", "Default Model", "The model used first when the default provider has none chosen. It is set from the AI provider manager.", text(120), json!(""), User),
        def("ai.confirmBeforeOnlineRequest", "AI", "Confirm Before Sending Online", "Ask before any text leaves this computer for an online AI provider, naming the provider and what is sent. Requests to a server on this computer are never asked about.", SettingKind::Bool, json!(true), User),
        def("ai.saveConversationHistory", "AI", "Save Conversation History", "Keep AI conversations on this computer (in the app's own folder) so they are there after a restart. When off, a chat lasts until you close it.", SettingKind::Bool, json!(true), User),
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
    let text = |max_length| SettingKind::Text { max_length };
    vec![
        def("extensions.allowSystemNode", "Extensions", "Allow System Node.js for Extensions", "Run the extension host with a Node.js found on this computer when OpenMind's portable Node.js is not installed. It is always labelled as the system Node.js.", SettingKind::Bool, json!(false), User),
        def("extensions.marketplace.autoFetch", "Extensions", "Load Marketplace Automatically", "Load the Popular list from Open VSX (open-vsx.org) whenever the Extensions view is shown (not at launch). Turn it off to contact the marketplace only when you search, load Popular, open an extension page or install.", SettingKind::Bool, json!(true), User),
        def("php.server.defaultPort", "PHP Server", "Default Port", "Port the PHP server uses until you choose another one in the PHP control panel.", SettingKind::Int { min: 1024, max: 65_535 }, json!(8000), User),
        def("php.tray.hideOnClose", "PHP Server", "Keep Servers Running in the Tray", "Closing the main window while a PHP, MariaDB or phpMyAdmin server runs hides the app to the system tray instead of quitting.", SettingKind::Bool, json!(true), User),
        def("network.proxy.mode", "Network", "Proxy", "How programs OpenMind starts (terminals, Run Code, tasks, Git, package managers, downloads) reach the network. No Proxy changes nothing. Use System Proxy uses the proxy Windows or the environment already names. Manual Proxy uses the addresses below. Only processes OpenMind starts are affected; Windows' own settings are never changed.", opts(&[("none", "No Proxy"), ("system", "Use System Proxy"), ("manual", "Manual Proxy")]), json!("none"), User),
        def("network.proxy.http", "Network", "HTTP Proxy", "Manual proxy for http:// addresses, as host:port or http://host:port. Put the user name and password in Network: Proxy Settings, not here.", text(300), json!(""), User),
        def("network.proxy.https", "Network", "HTTPS Proxy", "Manual proxy for https:// addresses. Empty: the HTTP proxy is used for https:// too.", text(300), json!(""), User),
        def("network.proxy.socks", "Network", "SOCKS Proxy", "Optional SOCKS5 proxy (socks5://host:port), passed as ALL_PROXY. Not every tool supports SOCKS.", text(300), json!(""), User),
        def("network.proxy.noProxy", "Network", "No Proxy For", "Comma-separated hosts that are reached directly (for example intranet.local, .corp). localhost, 127.0.0.1 and ::1 are always direct.", text(1000), json!("localhost,127.0.0.1,::1,.local"), User),
        def("network.goProxy", "Network", "Go Module Proxy", "GOPROXY for Go commands OpenMind starts. Empty: Go's own setting is used.", text(300), json!(""), User),
        def("network.testUrl", "Network", "Connection Test Address", "The address Test Connection requests (http or https). Nothing is contacted until you press Test.", text(300), json!("https://pypi.org/"), User),
        def("network.offline.useWheelhouse", "Network", "Use Offline Python Packages", "Let pip in processes OpenMind starts also look in the imported offline wheels (PIP_FIND_LINKS). pip's own configuration is not changed.", SettingKind::Bool, json!(false), User),
        def("workbench.colorTheme", "Workbench", "Color Theme", "Colors of the workbench, the editor and the terminal. System follows Windows.", opts(&[("system", "System"), ("dark", "Dark"), ("light", "Light"), ("high-contrast", "High Contrast")]), json!("dark"), User),
        def("workbench.iconTheme", "Workbench", "Icon Theme", "The icons in the Explorer, tabs and search. The built-in themes are bundled with the app; an extension's icon theme uses the images inside that extension. Nothing is downloaded.", opts(&[("material", "Material Icons (files and folders)"), ("material-files", "Material Icons (files only)"), ("minimal", "Minimal (one file icon, no folder icons)")]), json!("material"), User),
        def("workbench.productIconTheme", "Workbench", "Product Icon Theme", "The icons used by workbench buttons and views.", opts(&[("default", "Default")]), json!("default"), User),
        def("workbench.language", "Workbench", "Display Language", "The language of OpenMind Studio's own menus, dialogs and messages. System Default follows the language of Windows; English is used for anything a language doesn't translate. Code, file paths and extensions keep their own text.", opts(&[("system", "System Default"), ("en", "English"), ("ru", "Русский (Russian)"), ("bn", "বাংলা (Bangla)")]), json!("system"), User),
        def("workbench.welcomeOnStartup", "Workbench", "Show Welcome Page on Startup", "Open the Welcome page when the app starts.", SettingKind::Bool, json!(true), User),
    ]
}

/// What extensions add to the built-in settings: settings of their own, colour themes (extra choices of
/// `workbench.colorTheme`) and icon themes (extra choices of `workbench.iconTheme`, Milestone 18). An extension can't
/// replace a built-in setting.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Extras {
    pub settings: Vec<SettingDef>,
    pub themes: Vec<EnumOption>,
    pub icon_themes: Vec<EnumOption>,
    pub product_icon_themes: Vec<EnumOption>,
}

impl Extras {
    /// The Settings page's categories: the built-in ones, then each extension's own.
    pub fn categories(&self) -> Vec<String> {
        let mut all: Vec<String> = CATEGORIES.iter().map(|name| (*name).to_string()).collect();
        for def in &self.settings {
            if !all.contains(&def.category) {
                all.push(def.category.clone());
            }
        }
        all
    }
}

/// Every setting, in the order the Settings page shows them.
pub fn definitions(extras: &Extras) -> Vec<SettingDef> {
    let mut all = editor_definitions();
    all.extend(tools_definitions());
    all.extend(app_definitions());
    for def in &mut all {
        if def.id == "workbench.colorTheme" {
            if let SettingKind::Enum { options } = &mut def.kind {
                options.extend(extras.themes.iter().cloned());
            }
        }
        if def.id == "workbench.iconTheme" {
            if let SettingKind::Enum { options } = &mut def.kind {
                options.extend(extras.icon_themes.iter().cloned());
            }
        }
        if def.id == "workbench.productIconTheme" {
            if let SettingKind::Enum { options } = &mut def.kind {
                options.extend(extras.product_icon_themes.iter().cloned());
            }
        }
    }
    for def in &extras.settings {
        if !all.iter().any(|known| known.id == def.id) {
            all.push(def.clone());
        }
    }
    all
}

pub fn find(id: &str, extras: &Extras) -> Option<SettingDef> {
    definitions(extras).into_iter().find(|def| def.id == id)
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
                let allowed: Vec<&str> =
                    options.iter().map(|option| option.value.as_str()).collect();
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
        let all = definitions(&Extras::default());
        let mut seen = std::collections::HashSet::new();
        for def in &all {
            assert!(seen.insert(def.id.clone()), "duplicate id {}", def.id);
            assert!(
                CATEGORIES.contains(&def.category.as_str()),
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
        let def = find("editor.fontSize", &Extras::default()).expect("defined");
        assert_eq!(validate(&def, &json!(18)), Ok(json!(18)));
        assert!(validate(&def, &json!(7)).is_err());
        assert!(validate(&def, &json!(41)).is_err());
        assert!(validate(&def, &json!(12.5)).is_err());
        assert!(validate(&def, &json!("14")).is_err());
    }

    #[test]
    fn enums_booleans_and_text_are_checked() {
        let theme = find("workbench.colorTheme", &Extras::default()).expect("defined");
        assert_eq!(
            validate(&theme, &json!("high-contrast")),
            Ok(json!("high-contrast"))
        );
        let message = validate(&theme, &json!("neon")).expect_err("neon is not a theme");
        assert!(message.contains("system, dark, light, high-contrast"));
        let wrap = find("editor.wordWrap", &Extras::default()).expect("defined");
        assert!(validate(&wrap, &json!("yes")).is_err());
        let family = find("editor.fontFamily", &Extras::default()).expect("defined");
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
            assert_eq!(
                find(id, &Extras::default()).expect("defined").scope,
                SettingScope::User
            );
        }
        assert_eq!(
            find("editor.fontSize", &Extras::default())
                .expect("defined")
                .scope,
            SettingScope::Both
        );
    }
}

#[cfg(test)]
mod extras_tests {
    use super::*;

    fn extension_setting() -> SettingDef {
        def(
            "sampleConfig.greeting",
            "Sample Configuration",
            "Greeting",
            "The greeting the sample shows.",
            SettingKind::Text { max_length: 50 },
            json!("Hello"),
            SettingScope::Both,
        )
    }

    #[test]
    fn extension_settings_are_added_after_the_built_in_ones_with_their_own_category() {
        let extras = Extras {
            settings: vec![extension_setting()],
            themes: Vec::new(),
            icon_themes: Vec::new(),
            product_icon_themes: Vec::new(),
        };
        let all = definitions(&extras);
        assert_eq!(
            all.last().map(|def| def.id.as_str()),
            Some("sampleConfig.greeting")
        );
        assert!(find("sampleConfig.greeting", &extras).is_some());
        assert!(find("sampleConfig.greeting", &Extras::default()).is_none());
        let categories = extras.categories();
        assert_eq!(
            categories.last().map(String::as_str),
            Some("Sample Configuration")
        );
        assert_eq!(categories.len(), CATEGORIES.len() + 1);
    }

    #[test]
    fn an_extension_cannot_replace_a_built_in_setting() {
        let mut hijack = extension_setting();
        hijack.id = "editor.fontSize".to_string();
        hijack.default = json!("huge");
        let extras = Extras {
            settings: vec![hijack],
            themes: Vec::new(),
            icon_themes: Vec::new(),
            product_icon_themes: Vec::new(),
        };
        let def = find("editor.fontSize", &extras).expect("built in");
        assert_eq!(def.default, json!(14));
        assert_eq!(
            definitions(&extras).len(),
            definitions(&Extras::default()).len()
        );
    }

    #[test]
    fn extension_themes_become_choices_of_the_color_theme_setting() {
        let extras = Extras {
            settings: Vec::new(),
            themes: vec![EnumOption {
                value: "extension:acme.pack/Night".to_string(),
                label: "Night".to_string(),
            }],
            icon_themes: vec![EnumOption {
                value: "extension:acme.pack/icons".to_string(),
                label: "Acme Icons".to_string(),
            }],
            product_icon_themes: Vec::new(),
        };
        let theme = find("workbench.colorTheme", &extras).expect("defined");
        assert_eq!(
            validate(&theme, &json!("extension:acme.pack/Night")),
            Ok(json!("extension:acme.pack/Night"))
        );
        let plain = find("workbench.colorTheme", &Extras::default()).expect("defined");
        assert!(validate(&plain, &json!("extension:acme.pack/Night")).is_err());
        let icons = find("workbench.iconTheme", &extras).expect("defined");
        assert_eq!(
            validate(&icons, &json!("extension:acme.pack/icons")),
            Ok(json!("extension:acme.pack/icons"))
        );
        let plain_icons = find("workbench.iconTheme", &Extras::default()).expect("defined");
        assert!(validate(&plain_icons, &json!("extension:acme.pack/icons")).is_err());
    }

    #[test]
    fn extension_icon_themes_become_choices_of_their_workbench_settings() {
        let extras = Extras {
            settings: Vec::new(),
            themes: Vec::new(),
            icon_themes: vec![EnumOption {
                value: "extension:acme.pack/icons".to_string(),
                label: "Acme Icons".to_string(),
            }],
            product_icon_themes: vec![EnumOption {
                value: "extension:acme.pack/product".to_string(),
                label: "Acme Product Icons".to_string(),
            }],
        };
        let icons = find("workbench.iconTheme", &extras).expect("icons");
        assert_eq!(
            validate(&icons, &json!("extension:acme.pack/icons")),
            Ok(json!("extension:acme.pack/icons"))
        );
        let product = find("workbench.productIconTheme", &extras).expect("product");
        assert_eq!(
            validate(&product, &json!("extension:acme.pack/product")),
            Ok(json!("extension:acme.pack/product"))
        );
    }
}
