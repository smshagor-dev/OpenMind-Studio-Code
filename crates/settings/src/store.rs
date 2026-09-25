use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::schema::{self, SettingDef, SettingScope};

/// Which file a value comes from (or `Default` when no file sets it).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Source {
    Default,
    User,
    Workspace,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Severity {
    Error,
    Warning,
}

/// A problem found in a settings file: shown next to the setting and in the JSON editor's save
/// notice. Errors make the value be ignored; warnings don't.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Issue {
    pub key: Option<String>,
    pub message: String,
    pub severity: Severity,
    pub line: Option<usize>,
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("{0}")]
    Invalid(String),
    #[error("Unknown setting \"{0}\".")]
    Unknown(String),
    #[error("{0}")]
    Refused(String),
    #[error("Couldn't write {path}: {source}")]
    Write {
        path: PathBuf,
        source: std::io::Error,
    },
}

/// One settings file, read into memory. `error` is set when the file exists but can't be used
/// (unreadable, not JSON, not an object); the values are then empty and nothing overrides.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Layer {
    pub values: Map<String, Value>,
    pub error: Option<String>,
}

fn syntax_message(err: &serde_json::Error) -> String {
    format!(
        "Not valid JSON (line {}, column {}): {err}",
        err.line(),
        err.column()
    )
}

/// Parses the text of a settings file. An empty file counts as `{}`.
pub fn parse_object(text: &str) -> Result<Map<String, Value>, String> {
    let trimmed = text.trim_start_matches('\u{feff}').trim();
    if trimmed.is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => {
            Err("The file must contain one JSON object, like { \"editor.fontSize\": 16 }.".into())
        }
        Err(err) => Err(syntax_message(&err)),
    }
}

/// Reads a settings file; a missing file is simply empty.
pub fn read_layer(path: &Path) -> Layer {
    match std::fs::read_to_string(path) {
        Ok(text) => match parse_object(&text) {
            Ok(values) => Layer {
                values,
                error: None,
            },
            Err(error) => Layer {
                values: Map::new(),
                error: Some(error),
            },
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Layer::default(),
        Err(err) => Layer {
            values: Map::new(),
            error: Some(format!("Couldn't read the file: {err}")),
        },
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EffectiveSetting {
    pub id: &'static str,
    pub value: Value,
    pub source: Source,
}

/// The value each setting has right now: a workspace value beats a user value beats the default.
/// A value that doesn't validate, or a workspace value for a user-only setting, is ignored here
/// (and reported by [`issues`]) — a broken file never breaks the app.
pub fn effective(user: &Layer, workspace: Option<&Layer>) -> Vec<EffectiveSetting> {
    schema::definitions()
        .into_iter()
        .map(|def| {
            let from_workspace = workspace
                .filter(|_| def.scope == SettingScope::Both)
                .and_then(|layer| accepted(&def, &layer.values));
            let from_user = accepted(&def, &user.values);
            let (value, source) = match (from_workspace, from_user) {
                (Some(value), _) => (value, Source::Workspace),
                (None, Some(value)) => (value, Source::User),
                (None, None) => (def.default.clone(), Source::Default),
            };
            EffectiveSetting {
                id: def.id,
                value,
                source,
            }
        })
        .collect()
}

fn accepted(def: &SettingDef, values: &Map<String, Value>) -> Option<Value> {
    values
        .get(def.id)
        .and_then(|value| schema::validate(def, value).ok())
}

/// Everything wrong with the contents of one settings file. `workspace` says which file it is,
/// because a user-only setting in a workspace file does nothing.
pub fn issues(values: &Map<String, Value>, workspace: bool) -> Vec<Issue> {
    values
        .iter()
        .filter_map(|(key, value)| match schema::find(key) {
            None => Some(Issue {
                key: Some(key.clone()),
                message: format!("Unknown setting \"{key}\"."),
                severity: Severity::Warning,
                line: None,
            }),
            Some(def) if workspace && def.scope == SettingScope::User => Some(Issue {
                key: Some(key.clone()),
                message: format!(
                    "\"{key}\" is a user setting and has no effect in workspace settings."
                ),
                severity: Severity::Warning,
                line: None,
            }),
            Some(def) => schema::validate(&def, value).err().map(|message| Issue {
                key: Some(key.clone()),
                message,
                severity: Severity::Error,
                line: None,
            }),
        })
        .collect()
}

/// The problems of a settings file's text, for the notice after saving it in the JSON editor.
/// Syntax errors carry a line number; per-setting problems point at the line of their key.
pub fn validate_text(text: &str, workspace: bool) -> Vec<Issue> {
    match parse_object(text) {
        Err(message) => vec![Issue {
            key: None,
            line: message
                .split("(line ")
                .nth(1)
                .and_then(|rest| rest.split(',').next())
                .and_then(|line| line.parse().ok()),
            message,
            severity: Severity::Error,
        }],
        Ok(values) => issues(&values, workspace)
            .into_iter()
            .map(|mut issue| {
                issue.line = issue.key.as_deref().and_then(|key| line_of(text, key));
                issue
            })
            .collect(),
    }
}

fn line_of(text: &str, key: &str) -> Option<usize> {
    let needle = format!("\"{key}\"");
    text.lines()
        .position(|line| line.contains(&needle))
        .map(|index| index + 1)
}

fn write_atomic(path: &Path, text: &str) -> Result<(), StoreError> {
    let fail = |source| StoreError::Write {
        path: path.to_path_buf(),
        source,
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(fail)?;
    }
    let mut temp = path.as_os_str().to_owned();
    temp.push(".tmp");
    let temp = PathBuf::from(temp);
    std::fs::write(&temp, text).map_err(fail)?;
    std::fs::rename(&temp, path).map_err(|source| {
        let _ = std::fs::remove_file(&temp);
        fail(source)
    })
}

fn to_text(values: &Map<String, Value>) -> String {
    let mut text = serde_json::to_string_pretty(values).unwrap_or_else(|_| "{}".into());
    text.push('\n');
    text
}

/// A file with a syntax error is never rewritten: that would throw away what the user typed.
fn editable(path: &Path) -> Result<Map<String, Value>, StoreError> {
    let layer = read_layer(path);
    match layer.error {
        Some(error) => Err(StoreError::Refused(format!(
            "{} has a problem, so it wasn't changed. {error}",
            path.display()
        ))),
        None => Ok(layer.values),
    }
}

/// Sets one setting in the file at `path`, keeping every other key (including ones this app
/// doesn't know) and their order. `workspace` marks the workspace file, where user-only settings
/// are refused.
pub fn set_value(
    path: &Path,
    id: &str,
    value: &Value,
    workspace: bool,
) -> Result<Value, StoreError> {
    let def = schema::find(id).ok_or_else(|| StoreError::Unknown(id.to_string()))?;
    if workspace && def.scope == SettingScope::User {
        return Err(StoreError::Invalid(format!(
            "{} can only be set in User settings.",
            def.title
        )));
    }
    let checked = schema::validate(&def, value).map_err(StoreError::Invalid)?;
    let mut values = editable(path)?;
    values.insert(id.to_string(), checked.clone());
    write_atomic(path, &to_text(&values))?;
    Ok(checked)
}

/// Removes one setting from the file at `path`, so the next layer (or the default) applies again.
pub fn reset_value(path: &Path, id: &str) -> Result<(), StoreError> {
    if schema::find(id).is_none() {
        return Err(StoreError::Unknown(id.to_string()));
    }
    let mut values = editable(path)?;
    if values.remove(id).is_some() {
        write_atomic(path, &to_text(&values))?;
    }
    Ok(())
}

/// Creates the file with `{}` when it doesn't exist yet, so the JSON editor has something to open.
pub fn ensure_file(path: &Path) -> Result<(), StoreError> {
    if path.exists() {
        return Ok(());
    }
    write_atomic(path, "{}\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn value_of(list: &[EffectiveSetting], id: &str) -> (Value, Source) {
        let found = list.iter().find(|entry| entry.id == id).expect("defined");
        (found.value.clone(), found.source)
    }

    #[test]
    fn a_saved_setting_survives_reading_the_file_again() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings").join("settings.json");

        set_value(&path, "editor.fontSize", &json!(18), false).expect("saved");
        set_value(&path, "workbench.colorTheme", &json!("light"), false).expect("saved");

        let layer = read_layer(&path);
        assert!(layer.error.is_none());
        let list = effective(&layer, None);
        assert_eq!(
            value_of(&list, "editor.fontSize"),
            (json!(18), Source::User)
        );
        assert_eq!(
            value_of(&list, "workbench.colorTheme"),
            (json!("light"), Source::User)
        );
        assert_eq!(
            value_of(&list, "editor.tabSize"),
            (json!(4), Source::Default)
        );
    }

    #[test]
    fn a_workspace_value_overrides_the_user_value_only_where_allowed() {
        let user = Layer {
            values: parse_object(r#"{"editor.fontSize": 16, "terminal.fontSize": 12}"#)
                .expect("json"),
            error: None,
        };
        let workspace = Layer {
            values: parse_object(r#"{"editor.fontSize": 20, "terminal.fontSize": 30}"#)
                .expect("json"),
            error: None,
        };
        let list = effective(&user, Some(&workspace));
        assert_eq!(
            value_of(&list, "editor.fontSize"),
            (json!(20), Source::Workspace)
        );
        // terminal.fontSize is user-only: the workspace file can't change it.
        assert_eq!(
            value_of(&list, "terminal.fontSize"),
            (json!(12), Source::User)
        );
        // Without a workspace the user value stands.
        let alone = effective(&user, None);
        assert_eq!(
            value_of(&alone, "editor.fontSize"),
            (json!(16), Source::User)
        );
    }

    #[test]
    fn an_invalid_value_in_a_file_is_ignored_and_reported() {
        let user = Layer {
            values: parse_object(r#"{"editor.fontSize": 500, "editor.tabSize": 2, "nonsense": 1}"#)
                .expect("json"),
            error: None,
        };
        let list = effective(&user, None);
        assert_eq!(
            value_of(&list, "editor.fontSize"),
            (json!(14), Source::Default)
        );
        assert_eq!(value_of(&list, "editor.tabSize"), (json!(2), Source::User));
        let found = issues(&user.values, false);
        assert!(found.iter().any(|i| i.severity == Severity::Error
            && i.key.as_deref() == Some("editor.fontSize")
            && i.message.contains("between 8 and 40")));
        assert!(found
            .iter()
            .any(|i| i.severity == Severity::Warning && i.key.as_deref() == Some("nonsense")));
    }

    #[test]
    fn set_refuses_bad_values_unknown_ids_and_user_settings_in_a_workspace() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("s.json");
        assert!(matches!(
            set_value(&path, "editor.fontSize", &json!(3), false),
            Err(StoreError::Invalid(_))
        ));
        assert!(matches!(
            set_value(&path, "no.such", &json!(1), false),
            Err(StoreError::Unknown(_))
        ));
        assert!(matches!(
            set_value(&path, "workbench.colorTheme", &json!("dark"), true),
            Err(StoreError::Invalid(_))
        ));
        assert!(!path.exists(), "a refused change must not create the file");
    }

    #[test]
    fn saving_keeps_unknown_keys_and_their_order_and_reset_removes_only_one() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("s.json");
        std::fs::write(
            &path,
            r#"{"zeta.custom": true, "editor.tabSize": 8, "alpha.custom": "x"}"#,
        )
        .expect("write");

        set_value(&path, "editor.fontSize", &json!(20), false).expect("saved");
        let text = std::fs::read_to_string(&path).expect("read");
        let keys: Vec<&str> = text
            .lines()
            .filter_map(|line| line.trim().strip_prefix('"'))
            .filter_map(|line| line.split('"').next())
            .collect();
        assert_eq!(
            keys,
            [
                "zeta.custom",
                "editor.tabSize",
                "alpha.custom",
                "editor.fontSize"
            ]
        );

        reset_value(&path, "editor.tabSize").expect("reset");
        let layer = read_layer(&path);
        assert!(!layer.values.contains_key("editor.tabSize"));
        assert!(layer.values.contains_key("zeta.custom"));
        assert!(layer.values.contains_key("editor.fontSize"));
    }

    #[test]
    fn a_file_with_a_syntax_error_is_reported_and_never_overwritten() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("s.json");
        std::fs::write(&path, "{ \"editor.fontSize\": 16,\n  oops }").expect("write");

        let layer = read_layer(&path);
        assert!(layer
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("line 2"));
        assert!(layer.values.is_empty());
        let result = set_value(&path, "editor.tabSize", &json!(2), false);
        assert!(matches!(result, Err(StoreError::Refused(_))));
        assert!(std::fs::read_to_string(&path)
            .expect("read")
            .contains("oops"));
    }

    #[test]
    fn json_text_is_validated_with_line_numbers() {
        let found = validate_text(
            "{\n  \"editor.fontSize\": 99,\n  \"editor.wordWrap\": true\n}",
            false,
        );
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].line, Some(2));
        assert_eq!(found[0].severity, Severity::Error);

        let syntax = validate_text("{ \"a\": }", false);
        assert_eq!(syntax.len(), 1);
        assert_eq!(syntax[0].line, Some(1));

        assert!(
            validate_text("  ", false).is_empty(),
            "an empty file is fine"
        );
        assert!(validate_text("[1]", false)[0]
            .message
            .contains("one JSON object"));
        let warn = validate_text("{\"terminal.fontSize\": 12}", true);
        assert_eq!(warn[0].severity, Severity::Warning);
    }

    #[test]
    fn ensure_file_creates_an_empty_object_once() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(".openmind").join("settings.json");
        ensure_file(&path).expect("created");
        assert_eq!(std::fs::read_to_string(&path).expect("read").trim(), "{}");
        set_value(&path, "editor.tabSize", &json!(2), true).expect("saved");
        ensure_file(&path).expect("second call keeps the file");
        assert!(read_layer(&path).values.contains_key("editor.tabSize"));
    }
}
