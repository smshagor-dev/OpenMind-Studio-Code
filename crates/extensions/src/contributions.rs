//! What an extension contributes (`package.json` -> `contributes`): parsed into typed data, with every
//! contribution point classified as supported, metadata-only or unsupported, so the UI never claims more
//! than the app does.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Contributions {
    pub commands: Vec<CommandContribution>,
    /// Menu location -> entries, only the locations the app has (see [`SUPPORTED_MENUS`]).
    pub menus: BTreeMap<String, Vec<MenuContribution>>,
    /// Menu locations the extension uses that the app doesn't have.
    pub unsupported_menus: Vec<String>,
    pub keybindings: Vec<KeybindingContribution>,
    pub configuration: Vec<ConfigurationProperty>,
    /// `configuration` properties whose type isn't supported (arrays, objects, decimals...).
    pub unsupported_properties: Vec<String>,
    pub configuration_defaults: BTreeMap<String, Value>,
    pub languages: Vec<LanguageContribution>,
    pub grammars: Vec<GrammarContribution>,
    pub snippets: Vec<SnippetContribution>,
    pub themes: Vec<ThemeContribution>,
    pub icon_themes: Vec<IconThemeContribution>,
    pub debuggers: Vec<DebuggerContribution>,
    pub problem_matchers: Vec<String>,
    /// Contribution points this app doesn't know at all, with how many entries each has.
    pub unsupported: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandContribution {
    pub command: String,
    pub title: String,
    pub category: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuContribution {
    pub command: String,
    pub when: Option<String>,
    pub group: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeybindingContribution {
    pub command: String,
    /// In the app's spelling (`Ctrl+Alt+H`); already normalized.
    pub key: String,
    pub when: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationProperty {
    pub key: String,
    pub kind: ConfigurationKind,
    pub default: Value,
    pub description: String,
    /// The section title (`configuration.title`), used as the Settings category.
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ConfigurationKind {
    Boolean,
    Integer { minimum: i64, maximum: i64 },
    String { max_length: usize },
    Enum { options: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageContribution {
    pub id: String,
    pub extensions: Vec<String>,
    pub filenames: Vec<String>,
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrammarContribution {
    pub language: Option<String>,
    pub scope_name: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetContribution {
    pub language: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeContribution {
    pub label: String,
    /// `vs`, `vs-dark`, `hc-black` or `hc-light`.
    pub ui_theme: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IconThemeContribution {
    pub id: String,
    pub label: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebuggerContribution {
    pub kind: String,
    pub label: Option<String>,
}

/// Menu locations the app has: the Command Palette list, the editor's context menu and the Explorer's.
pub const SUPPORTED_MENUS: &[&str] = &["commandPalette", "editor/context", "explorer/context"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Support {
    /// The app acts on it.
    Supported,
    /// Read and shown, but nothing uses it yet.
    Metadata,
    /// Not supported yet.
    Unsupported,
}

/// One line of the "Contribution points" list in the extension details.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PointReport {
    pub point: String,
    pub count: usize,
    pub support: Support,
    pub note: Option<String>,
}

pub const NOT_SUPPORTED_NOTE: &str = "This contribution point is not supported yet.";

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn strings(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn list<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

/// `Ctrl+Shift+P` in the app's spelling from VS Code's `ctrl+shift+p`; `None` for chord sequences and
/// keys the app can't bind.
pub fn chord_from_vscode(key: &str) -> Option<String> {
    let key = key.trim();
    if key.contains(' ') {
        return None; // "ctrl+k ctrl+c": key sequences aren't supported
    }
    let mapped: Vec<String> = key
        .split('+')
        .map(|part| match part.to_ascii_lowercase().as_str() {
            "cmd" | "meta" | "win" | "super" => "ctrl".to_string(),
            "escape" | "esc" => "esc".to_string(),
            "pageup" => "pageup".to_string(),
            "pagedown" => "pagedown".to_string(),
            "uparrow" => "up".to_string(),
            "downarrow" => "down".to_string(),
            "leftarrow" => "left".to_string(),
            "rightarrow" => "right".to_string(),
            other => other.to_string(),
        })
        .collect();
    openmind_settings::keybindings::normalize_chord(&mapped.join("+")).ok()
}

fn parse_commands(value: &Value) -> Vec<CommandContribution> {
    list(value, "commands")
        .iter()
        .filter_map(|entry| {
            let command = text(entry, "command")?;
            let title = match entry.get("title") {
                Some(Value::String(title)) => title.clone(),
                // Localizable titles are `{ "value": ..., "original": ... }`.
                Some(Value::Object(object)) => object
                    .get("value")
                    .and_then(Value::as_str)
                    .unwrap_or(&command)
                    .to_string(),
                _ => command.clone(),
            };
            Some(CommandContribution {
                command,
                title,
                category: text(entry, "category"),
            })
        })
        .collect()
}

fn parse_menus(value: &Value) -> (BTreeMap<String, Vec<MenuContribution>>, Vec<String>) {
    let mut supported = BTreeMap::new();
    let mut unsupported = Vec::new();
    if let Some(menus) = value.get("menus").and_then(Value::as_object) {
        for (location, entries) in menus {
            if SUPPORTED_MENUS.contains(&location.as_str()) {
                let parsed = entries
                    .as_array()
                    .map(|entries| {
                        entries
                            .iter()
                            .filter_map(|entry| {
                                Some(MenuContribution {
                                    command: text(entry, "command")?,
                                    when: text(entry, "when"),
                                    group: text(entry, "group"),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                supported.insert(location.clone(), parsed);
            } else {
                unsupported.push(location.clone());
            }
        }
    }
    unsupported.sort();
    (supported, unsupported)
}

fn parse_keybindings(value: &Value) -> (Vec<KeybindingContribution>, usize) {
    let mut out = Vec::new();
    let mut skipped = 0;
    for entry in list(value, "keybindings") {
        let (Some(command), Some(key)) = (text(entry, "command"), text(entry, "key")) else {
            skipped += 1;
            continue;
        };
        match chord_from_vscode(&key) {
            Some(key) => out.push(KeybindingContribution {
                command,
                key,
                when: text(entry, "when"),
            }),
            None => skipped += 1,
        }
    }
    (out, skipped)
}

/// `configuration` is one object or a list of them; each has `title` and `properties`.
fn parse_configuration(value: &Value) -> (Vec<ConfigurationProperty>, Vec<String>) {
    let mut props = Vec::new();
    let mut unsupported = Vec::new();
    let sections: Vec<&Value> = match value.get("configuration") {
        Some(Value::Array(items)) => items.iter().collect(),
        Some(object @ Value::Object(_)) => vec![object],
        _ => Vec::new(),
    };
    for section in sections {
        let title = text(section, "title");
        let Some(properties) = section.get("properties").and_then(Value::as_object) else {
            continue;
        };
        for (key, definition) in properties {
            match property(key, definition, &title) {
                Some(parsed) => props.push(parsed),
                None => unsupported.push(key.clone()),
            }
        }
    }
    unsupported.sort();
    (props, unsupported)
}

fn property(key: &str, def: &Value, title: &Option<String>) -> Option<ConfigurationProperty> {
    let description = text(def, "description")
        .or_else(|| text(def, "markdownDescription"))
        .unwrap_or_default();
    let declared = def.get("type").and_then(Value::as_str);
    let default = def.get("default").cloned();
    let kind = if let Some(options) = def.get("enum").and_then(Value::as_array) {
        let names: Vec<String> = options
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        if names.is_empty() || names.len() != options.len() {
            return None;
        }
        ConfigurationKind::Enum { options: names }
    } else {
        match declared {
            Some("boolean") => ConfigurationKind::Boolean,
            Some("integer") => ConfigurationKind::Integer {
                minimum: def
                    .get("minimum")
                    .and_then(Value::as_i64)
                    .unwrap_or(i64::MIN / 2),
                maximum: def
                    .get("maximum")
                    .and_then(Value::as_i64)
                    .unwrap_or(i64::MAX / 2),
            },
            // A `number` is only supported when its default is a whole number.
            Some("number") if default.as_ref().is_none_or(|d| d.as_i64().is_some()) => {
                ConfigurationKind::Integer {
                    minimum: def
                        .get("minimum")
                        .and_then(Value::as_i64)
                        .unwrap_or(i64::MIN / 2),
                    maximum: def
                        .get("maximum")
                        .and_then(Value::as_i64)
                        .unwrap_or(i64::MAX / 2),
                }
            }
            Some("string") => ConfigurationKind::String { max_length: 1000 },
            _ => return None,
        }
    };
    let default = default.unwrap_or_else(|| match &kind {
        ConfigurationKind::Boolean => Value::Bool(false),
        ConfigurationKind::Integer { minimum, .. } => Value::from((*minimum).max(0)),
        ConfigurationKind::String { .. } => Value::String(String::new()),
        ConfigurationKind::Enum { options } => Value::String(options[0].clone()),
    });
    Some(ConfigurationProperty {
        key: key.to_string(),
        kind,
        default,
        description,
        title: title.clone(),
    })
}

fn parse_languages(value: &Value) -> Vec<LanguageContribution> {
    list(value, "languages")
        .iter()
        .filter_map(|entry| {
            Some(LanguageContribution {
                id: text(entry, "id")?,
                extensions: strings(entry, "extensions"),
                filenames: strings(entry, "filenames"),
                aliases: strings(entry, "aliases"),
            })
        })
        .collect()
}

impl Contributions {
    pub fn from_value(value: &Value) -> Self {
        let mut out = Contributions::default();
        let Some(object) = value.as_object() else {
            return out;
        };
        out.commands = parse_commands(value);
        (out.menus, out.unsupported_menus) = parse_menus(value);
        let (keybindings, _skipped) = parse_keybindings(value);
        out.keybindings = keybindings;
        (out.configuration, out.unsupported_properties) = parse_configuration(value);
        out.configuration_defaults = value
            .get("configurationDefaults")
            .and_then(Value::as_object)
            .map(|defaults| {
                defaults
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect()
            })
            .unwrap_or_default();
        out.languages = parse_languages(value);
        out.grammars = list(value, "grammars")
            .iter()
            .map(|entry| GrammarContribution {
                language: text(entry, "language"),
                scope_name: text(entry, "scopeName"),
                path: text(entry, "path"),
            })
            .collect();
        out.snippets = list(value, "snippets")
            .iter()
            .filter_map(|entry| {
                Some(SnippetContribution {
                    language: text(entry, "language")?,
                    path: text(entry, "path")?,
                })
            })
            .collect();
        out.themes = list(value, "themes")
            .iter()
            .filter_map(|entry| {
                let path = text(entry, "path")?;
                let label = text(entry, "label").or_else(|| text(entry, "id"))?;
                Some(ThemeContribution {
                    label,
                    ui_theme: text(entry, "uiTheme").unwrap_or_else(|| "vs-dark".into()),
                    path,
                })
            })
            .collect();
        out.icon_themes = list(value, "iconThemes")
            .iter()
            .filter_map(|entry| {
                Some(IconThemeContribution {
                    id: text(entry, "id")?,
                    label: text(entry, "label").unwrap_or_default(),
                    path: text(entry, "path")?,
                })
            })
            .collect();
        out.debuggers = list(value, "debuggers")
            .iter()
            .filter_map(|entry| {
                Some(DebuggerContribution {
                    kind: text(entry, "type")?,
                    label: text(entry, "label"),
                })
            })
            .collect();
        out.problem_matchers = list(value, "problemMatchers")
            .iter()
            .filter_map(|entry| text(entry, "name"))
            .collect();
        const KNOWN: &[&str] = &[
            "commands",
            "menus",
            "keybindings",
            "configuration",
            "configurationDefaults",
            "languages",
            "grammars",
            "snippets",
            "themes",
            "iconThemes",
            "debuggers",
            "problemMatchers",
        ];
        for (point, body) in object {
            if !KNOWN.contains(&point.as_str()) {
                let count = body
                    .as_array()
                    .map(Vec::len)
                    .or_else(|| body.as_object().map(serde_json::Map::len))
                    .unwrap_or(1);
                out.unsupported.insert(point.clone(), count);
            }
        }
        out
    }

    /// Every contribution point the extension uses, with how far the app supports it.
    pub fn report(&self) -> Vec<PointReport> {
        let mut report = Vec::new();
        let mut add = |point: &str, count: usize, support: Support, note: Option<&str>| {
            if count > 0 {
                report.push(PointReport {
                    point: point.to_string(),
                    count,
                    support,
                    note: note.map(str::to_string),
                });
            }
        };
        add("commands", self.commands.len(), Support::Supported, None);
        let menu_entries: usize = self.menus.values().map(Vec::len).sum();
        add("menus", menu_entries, Support::Supported, None);
        add(
            "keybindings",
            self.keybindings.len(),
            Support::Supported,
            None,
        );
        add(
            "configuration",
            self.configuration.len(),
            Support::Supported,
            None,
        );
        add(
            "configurationDefaults",
            self.configuration_defaults.len(),
            Support::Metadata,
            Some("Read, but other settings' defaults aren't changed yet."),
        );
        add("languages", self.languages.len(), Support::Supported, None);
        add(
            "grammars",
            self.grammars.len(),
            Support::Unsupported,
            Some("TextMate grammars aren't supported yet (the editor highlights with Monaco's own languages)."),
        );
        add("snippets", self.snippets.len(), Support::Supported, None);
        add("themes", self.themes.len(), Support::Supported, None);
        add(
            "iconThemes",
            self.icon_themes.len(),
            Support::Unsupported,
            Some("Icon themes aren't supported yet."),
        );
        add(
            "debuggers",
            self.debuggers.len(),
            Support::Metadata,
            Some("Registered as metadata only: the debugger isn't started from extensions yet."),
        );
        add(
            "problemMatchers",
            self.problem_matchers.len(),
            Support::Metadata,
            Some("Registered as metadata only: problem matchers aren't used yet."),
        );
        for location in &self.unsupported_menus {
            add(
                &format!("menus: {location}"),
                1,
                Support::Unsupported,
                Some(NOT_SUPPORTED_NOTE),
            );
        }
        if !self.unsupported_properties.is_empty() {
            add(
                "configuration: unsupported property types",
                self.unsupported_properties.len(),
                Support::Unsupported,
                Some(NOT_SUPPORTED_NOTE),
            );
        }
        for (point, count) in &self.unsupported {
            add(
                point,
                *count,
                Support::Unsupported,
                Some(NOT_SUPPORTED_NOTE),
            );
        }
        report
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(value: Value) -> Contributions {
        Contributions::from_value(&value)
    }

    #[test]
    fn commands_menus_and_keybindings_are_read_and_chords_normalized() {
        let c = parse(json!({
            "commands": [
                {"command": "hello.say", "title": "Say Hello", "category": "Hello"},
                {"command": "hello.other", "title": {"value": "Other", "original": "Other"}},
                {"title": "no id"}
            ],
            "menus": {
                "commandPalette": [{"command": "hello.say"}],
                "editor/context": [{"command": "hello.say", "when": "editorHasSelection", "group": "navigation"}],
                "view/title": [{"command": "hello.say"}],
                "scm/title": []
            },
            "keybindings": [
                {"command": "hello.say", "key": "ctrl+alt+h", "when": "editorTextFocus"},
                {"command": "hello.say", "key": "ctrl+k ctrl+h"},
                {"command": "hello.say", "key": "h"}
            ]
        }));
        assert_eq!(c.commands.len(), 2);
        assert_eq!(c.commands[1].title, "Other");
        assert_eq!(c.commands[0].category.as_deref(), Some("Hello"));
        assert_eq!(c.menus.len(), 2);
        assert_eq!(
            c.menus["editor/context"][0].when.as_deref(),
            Some("editorHasSelection")
        );
        assert_eq!(c.unsupported_menus, ["scm/title", "view/title"]);
        assert_eq!(
            c.keybindings.len(),
            1,
            "sequences and bare letters are skipped"
        );
        assert_eq!(c.keybindings[0].key, "Ctrl+Alt+H");
    }

    #[test]
    fn configuration_maps_types_and_reports_what_it_cannot_map() {
        let c = parse(json!({
            "configuration": {
                "title": "Hello",
                "properties": {
                    "hello.enabled": {"type": "boolean", "default": true, "description": "On?"},
                    "hello.count": {"type": "integer", "default": 3, "minimum": 1, "maximum": 9},
                    "hello.ratio": {"type": "number", "default": 0.5},
                    "hello.whole": {"type": "number", "default": 7},
                    "hello.name": {"type": "string", "default": "x"},
                    "hello.mode": {"type": "string", "enum": ["a", "b"], "default": "b"},
                    "hello.list": {"type": "array", "default": []},
                    "hello.bad": {"type": "string", "enum": [1, 2]}
                }
            }
        }));
        let kinds: Vec<(&str, &ConfigurationKind)> = c
            .configuration
            .iter()
            .map(|p| (p.key.as_str(), &p.kind))
            .collect();
        assert_eq!(kinds.len(), 5);
        assert!(matches!(
            kinds
                .iter()
                .find(|(k, _)| *k == "hello.count")
                .expect("count")
                .1,
            ConfigurationKind::Integer {
                minimum: 1,
                maximum: 9
            }
        ));
        assert!(matches!(
            kinds
                .iter()
                .find(|(k, _)| *k == "hello.mode")
                .expect("mode")
                .1,
            ConfigurationKind::Enum { .. }
        ));
        assert_eq!(
            c.unsupported_properties,
            ["hello.bad", "hello.list", "hello.ratio"]
        );
        assert_eq!(c.configuration[0].title.as_deref(), Some("Hello"));
        assert_eq!(c.configuration[0].description, "On?");
    }

    #[test]
    fn languages_snippets_themes_and_metadata_points_are_read() {
        let c = parse(json!({
            "languages": [{"id": "hello", "extensions": [".hello"], "aliases": ["Hello"], "filenames": ["HELLOFILE"]}],
            "snippets": [{"language": "hello", "path": "./snippets/hello.json"}],
            "themes": [{"label": "Hello Dark", "uiTheme": "vs-dark", "path": "./themes/hello.json"}],
            "iconThemes": [{"id": "hello-icons", "label": "Hello Icons", "path": "./icons.json"}],
            "grammars": [{"language": "hello", "scopeName": "source.hello", "path": "./hello.tmLanguage.json"}],
            "debuggers": [{"type": "hello", "label": "Hello Debug"}],
            "problemMatchers": [{"name": "hello"}],
            "viewsContainers": {"activitybar": []},
            "views": {"explorer": [{"id": "a"}, {"id": "b"}]}
        }));
        assert_eq!(c.languages[0].extensions, [".hello"]);
        assert_eq!(c.snippets[0].path, "./snippets/hello.json");
        assert_eq!(c.themes[0].label, "Hello Dark");
        assert_eq!(c.debuggers[0].kind, "hello");
        assert_eq!(c.unsupported.get("views"), Some(&1));
        assert_eq!(c.unsupported.get("viewsContainers"), Some(&1));
    }

    #[test]
    fn the_report_says_which_points_are_supported_metadata_or_unsupported() {
        let c = parse(json!({
            "commands": [{"command": "a.b", "title": "A"}],
            "grammars": [{"language": "x", "scopeName": "s", "path": "p"}],
            "iconThemes": [{"id": "i", "path": "p"}],
            "debuggers": [{"type": "d"}],
            "menus": {"view/title": []},
            "customThing": {"a": 1, "b": 2}
        }));
        let report = c.report();
        let support = |name: &str| {
            report
                .iter()
                .find(|line| line.point == name)
                .map(|line| line.support)
        };
        assert_eq!(support("commands"), Some(Support::Supported));
        assert_eq!(support("grammars"), Some(Support::Unsupported));
        assert_eq!(support("iconThemes"), Some(Support::Unsupported));
        assert_eq!(support("debuggers"), Some(Support::Metadata));
        assert_eq!(support("menus: view/title"), Some(Support::Unsupported));
        assert_eq!(support("customThing"), Some(Support::Unsupported));
        let unsupported = report
            .iter()
            .find(|line| line.point == "customThing")
            .expect("customThing");
        assert_eq!(unsupported.count, 2);
        assert_eq!(
            unsupported.note.as_deref(),
            Some("This contribution point is not supported yet.")
        );
        assert_eq!(
            support("themes"),
            None,
            "points the extension doesn't use are not listed"
        );
    }

    #[test]
    fn a_missing_or_wrong_contributes_value_is_simply_empty() {
        assert_eq!(parse(Value::Null), Contributions::default());
        assert_eq!(parse(json!([1, 2])), Contributions::default());
        assert!(parse(json!({})).report().is_empty());
    }
}
