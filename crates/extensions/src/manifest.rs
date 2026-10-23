//! `package.json` of an extension: the fields the app supports, validated. Anything malformed is refused
//! with a message that says which field is wrong, because a bad manifest must never half-install.

use serde::Serialize;
use serde_json::Value;

use crate::contributions::Contributions;
use crate::error::ExtensionError;
use crate::permissions::{self, Permission};

/// A parsed, validated manifest.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub name: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub version: String,
    pub publisher: String,
    pub engines_vscode: Option<String>,
    pub categories: Vec<String>,
    pub icon: Option<String>,
    /// The Node entry (`main`): what the extension host loads.
    pub main: Option<String>,
    /// A web-worker entry (`browser`): recorded, never run (there is no web extension host).
    pub browser: Option<String>,
    pub activation_events: Vec<ActivationEvent>,
    pub extension_dependencies: Vec<String>,
    pub extension_pack: Vec<String>,
    pub contributes: Contributions,
    /// `openmindPermissions`: what the extension asks for (the UI adds what its contributions imply).
    pub requested_permissions: Vec<Permission>,
}

/// Publisher used when a package has none (allowed by `vsce` for local packages).
pub const NO_PUBLISHER: &str = "local";

/// The compatibility surface exposed by the current extension host. This
/// checks the manifest's minimum VS Code engine, not API parity.
pub const EXTENSION_API_VERSION: &str = "1.85.0";

pub fn engine_compatible(manifest: &Manifest) -> bool {
    let Some(range) = manifest.engines_vscode.as_deref() else {
        return true;
    };
    let Ok(request) = semver::VersionReq::parse(range) else {
        return false;
    };
    request.matches(&semver::Version::new(1, 85, 0))
}


/// The command the app activates task providers with when the user opens Terminal > Run Task... (VS Code's name).
pub const RUN_TASK_COMMAND: &str = "workbench.action.tasks.runTask";

/// When an extension's code starts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum ActivationEvent {
    /// `*`: every start-up (may slow it down).
    Star,
    OnStartupFinished,
    OnCommand(String),
    OnLanguage(String),
    OnView(String),
    WorkspaceContains(String),
    /// Any other event (`onFileSystem:`, `onDebug`, ...): kept, never triggered.
    Unsupported(String),
}

impl ActivationEvent {
    pub fn parse(text: &str) -> Self {
        let text = text.trim();
        match text {
            "*" => return Self::Star,
            "onStartupFinished" => return Self::OnStartupFinished,
            _ => {}
        }
        for (prefix, make) in [
            ("onCommand:", Self::OnCommand as fn(String) -> Self),
            ("onLanguage:", Self::OnLanguage),
            ("onView:", Self::OnView),
            ("workspaceContains:", Self::WorkspaceContains),
        ] {
            if let Some(rest) = text.strip_prefix(prefix) {
                if !rest.is_empty() {
                    return make(rest.to_string());
                }
            }
        }
        Self::Unsupported(text.to_string())
    }

    /// The event as `package.json` spells it.
    pub fn text(&self) -> String {
        match self {
            Self::Star => "*".into(),
            Self::OnStartupFinished => "onStartupFinished".into(),
            Self::OnCommand(v) => format!("onCommand:{v}"),
            Self::OnLanguage(v) => format!("onLanguage:{v}"),
            Self::OnView(v) => format!("onView:{v}"),
            Self::WorkspaceContains(v) => format!("workspaceContains:{v}"),
            Self::Unsupported(v) => v.clone(),
        }
    }

    /// Whether something in the app can trigger it. `onView` triggers only for views in the extension's own
    /// activity bar containers (the store warns about the others).
    pub fn is_supported(&self) -> bool {
        !matches!(self, Self::Unsupported(_))
    }
}

/// What a manifest must get right about its contributions: every command has an id and a title (and the
/// ids are unique), and every setting's default is a valid value for the setting.
fn validate_contributions(contributes: &Contributions) -> Result<(), ExtensionError> {
    let mut seen = std::collections::BTreeSet::new();
    for (index, command) in contributes.commands.iter().enumerate() {
        if command.title.trim().is_empty() {
            return Err(ExtensionError::Manifest(format!(
                "contributes.commands[{index}] (\"{}\") has no title",
                command.command
            )));
        }
        if !seen.insert(command.command.as_str()) {
            return Err(ExtensionError::Manifest(format!(
                "contributes.commands lists \"{}\" twice",
                command.command
            )));
        }
    }
    for property in &contributes.configuration {
        let definition = crate::settings::setting(property, "");
        if let Err(reason) = openmind_settings::schema::validate(&definition, &property.default) {
            return Err(ExtensionError::Manifest(format!(
                "the default of setting \"{}\" is invalid: {reason}",
                property.key
            )));
        }
    }
    Ok(())
}

fn bad(field: &str, why: &str) -> ExtensionError {
    ExtensionError::Manifest(format!("\"{field}\" {why}"))
}

fn optional_text(root: &Value, field: &str) -> Result<Option<String>, ExtensionError> {
    match root.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.trim().to_string()).filter(|t| !t.is_empty())),
        Some(_) => Err(bad(field, "must be a string")),
    }
}

fn string_list(root: &Value, field: &str) -> Result<Vec<String>, ExtensionError> {
    match root.get(field) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_string)
                    .ok_or_else(|| bad(field, "must be a list of strings"))
            })
            .collect(),
        Some(_) => Err(bad(field, "must be a list of strings")),
    }
}

/// A path inside the extension (`main`, `icon`): relative, no `..`, no drive letters.
fn inside_path(field: &str, value: &str) -> Result<(), ExtensionError> {
    let normalized = value.replace('\\', "/");
    let bad_path = normalized.starts_with('/')
        || normalized.contains(':')
        || normalized.contains('\0')
        || normalized.split('/').any(|part| part == "..");
    if bad_path || normalized.is_empty() {
        return Err(bad(field, "must be a path inside the extension"));
    }
    Ok(())
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
}

fn valid_version(version: &str) -> bool {
    let core = version.split(['-', '+']).next().unwrap_or_default();
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
}

impl Manifest {
    /// The extension's id, `publisher.name` in lower case, as VS Code writes it.
    pub fn id(&self) -> String {
        format!("{}.{}", self.publisher, self.name).to_lowercase()
    }

    /// Whether the extension has code the host would run.
    pub fn has_code(&self) -> bool {
        self.main.is_some()
    }

    /// Parses and validates the text of a `package.json`.
    pub fn parse(text: &str) -> Result<Self, ExtensionError> {
        Self::parse_localized(text, None)
    }

    /// Parses `package.json`, first replacing its `%key%` strings from `package.nls.json` (when given).
    pub fn parse_localized(text: &str, nls: Option<&str>) -> Result<Self, ExtensionError> {
        let mut root: Value =
            serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|err| {
                ExtensionError::Manifest(format!("package.json is not valid JSON: {err}"))
            })?;
        if let Some(nls) = nls {
            crate::nls::localize(&mut root, &crate::nls::parse_bundle(nls));
        }
        if !root.is_object() {
            return Err(ExtensionError::Manifest(
                "package.json must contain one JSON object".into(),
            ));
        }
        let name = optional_text(&root, "name")?
            .ok_or_else(|| ExtensionError::Manifest("\"name\" is required".into()))?;
        if !valid_name(&name) {
            return Err(bad(
                "name",
                "may only contain letters, digits, '.', '-' and '_' (no spaces)",
            ));
        }
        let version = optional_text(&root, "version")?
            .ok_or_else(|| ExtensionError::Manifest("\"version\" is required".into()))?;
        if !valid_version(&version) {
            return Err(bad(
                "version",
                "must look like 1.2.3 (optionally with -beta.1)",
            ));
        }
        let publisher = optional_text(&root, "publisher")?.unwrap_or_else(|| NO_PUBLISHER.into());
        if !valid_name(&publisher) {
            return Err(bad(
                "publisher",
                "may only contain letters, digits, '.', '-' and '_'",
            ));
        }
        let engines_vscode = match root.get("engines") {
            None | Some(Value::Null) => None,
            Some(engines @ Value::Object(_)) => match engines.get("vscode") {
                None | Some(Value::Null) => None,
                Some(Value::String(range)) if !range.trim().is_empty() => {
                    Some(range.trim().to_string())
                }
                Some(_) => return Err(bad("engines.vscode", "must be a version range string")),
            },
            Some(_) => return Err(bad("engines", "must be an object")),
        };
        let main = optional_text(&root, "main")?;
        if let Some(main) = &main {
            inside_path("main", main)?;
        }
        let browser = optional_text(&root, "browser")?;
        if let Some(browser) = &browser {
            inside_path("browser", browser)?;
        }
        let icon = optional_text(&root, "icon")?;
        if let Some(icon) = &icon {
            inside_path("icon", icon)?;
        }
        let activation_events = string_list(&root, "activationEvents")?
            .iter()
            .map(|event| ActivationEvent::parse(event))
            .collect();
        let contributes = match root.get("contributes") {
            None | Some(Value::Null) => Contributions::default(),
            Some(value @ Value::Object(_)) => Contributions::from_value(value),
            Some(_) => return Err(bad("contributes", "must be an object")),
        };
        validate_contributions(&contributes)?;
        let requested_permissions = permissions::parse_requested(root.get("openmindPermissions"))?;
        Ok(Manifest {
            name,
            display_name: optional_text(&root, "displayName")?,
            description: optional_text(&root, "description")?,
            version,
            publisher,
            engines_vscode,
            categories: string_list(&root, "categories")?,
            icon,
            main,
            browser,
            activation_events,
            extension_dependencies: string_list(&root, "extensionDependencies")?,
            extension_pack: string_list(&root, "extensionPack")?,
            contributes,
            requested_permissions,
        })
    }

    /// The activation events in force: the declared ones plus, like VS Code, an `onCommand` for each
    /// contributed command, an `onLanguage` for each contributed language, an `onView` for each view and, for an
    /// extension with `taskDefinitions`, `onCommand:workbench.action.tasks.runTask`.
    pub fn effective_activation(&self) -> Vec<ActivationEvent> {
        let mut events = self.activation_events.clone();
        for command in &self.contributes.commands {
            let event = ActivationEvent::OnCommand(command.command.clone());
            if !events.contains(&event) {
                events.push(event);
            }
        }
        for language in &self.contributes.languages {
            let event = ActivationEvent::OnLanguage(language.id.clone());
            if !events.contains(&event) {
                events.push(event);
            }
        }
        // A task provider is woken when the user opens the task list (Terminal > Run Task...).
        if !self.contributes.task_definitions.is_empty() {
            let event = ActivationEvent::OnCommand(RUN_TASK_COMMAND.to_string());
            if !events.contains(&event) {
                events.push(event);
            }
        }
        // Opening a contributed view wakes its extension (VS Code implies `onView:<id>` too).
        for view in self.contributes.views.view_ids() {
            let event = ActivationEvent::OnView(view.to_string());
            if !events.contains(&event) {
                events.push(event);
            }
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = r#"{ "name": "hello", "version": "1.0.0", "publisher": "acme" }"#;

    #[test]
    fn a_minimal_manifest_parses_and_has_an_id() {
        let manifest = Manifest::parse(MINIMAL).expect("valid");
        assert_eq!(manifest.id(), "acme.hello");
        assert!(!manifest.has_code());
        assert!(manifest.activation_events.is_empty());
    }

    #[test]
    fn every_supported_field_is_read() {
        let manifest = Manifest::parse(
            r#"{
              "name": "full", "displayName": "Full One", "description": "d", "version": "2.3.4-beta.1",
              "publisher": "Acme", "engines": { "vscode": "^1.80.0" }, "categories": ["Other"],
              "icon": "images/icon.png", "main": "./out/extension.js", "browser": "./web.js",
              "activationEvents": ["onCommand:full.go", "onLanguage:full", "*", "onStartupFinished", "onFileSystem:x"],
              "contributes": { "commands": [{ "command": "full.go", "title": "Go" }] },
              "extensionDependencies": ["acme.base"], "extensionPack": ["acme.a", "acme.b"]
            }"#,
        )
        .expect("valid");
        assert_eq!(manifest.id(), "acme.full");
        assert_eq!(manifest.display_name.as_deref(), Some("Full One"));
        assert_eq!(manifest.engines_vscode.as_deref(), Some("^1.80.0"));
        assert_eq!(manifest.main.as_deref(), Some("./out/extension.js"));
        assert_eq!(manifest.browser.as_deref(), Some("./web.js"));
        assert_eq!(manifest.extension_dependencies, ["acme.base"]);
        assert_eq!(manifest.extension_pack.len(), 2);
        assert_eq!(manifest.contributes.commands.len(), 1);
        assert!(manifest.has_code());
    }

    #[test]
    fn a_missing_publisher_is_allowed_and_named_local() {
        let manifest = Manifest::parse(r#"{ "name": "x", "version": "0.0.1" }"#).expect("valid");
        assert_eq!(manifest.publisher, "local");
        assert_eq!(manifest.id(), "local.x");
    }

    #[test]
    fn invalid_manifests_are_refused_with_the_field_named() {
        let cases: [(&str, &str); 12] = [
            ("not json", "not valid JSON"),
            ("[1]", "one JSON object"),
            (r#"{ "version": "1.0.0" }"#, "\"name\" is required"),
            (
                r#"{ "name": "a b", "version": "1.0.0" }"#,
                "\"name\" may only contain",
            ),
            (r#"{ "name": "a" }"#, "\"version\" is required"),
            (
                r#"{ "name": "a", "version": "one" }"#,
                "\"version\" must look like",
            ),
            (
                r#"{ "name": "a", "version": "1.0.0", "publisher": "no/slash" }"#,
                "\"publisher\"",
            ),
            (
                r#"{ "name": "a", "version": "1.0.0", "engines": { "vscode": 5 } }"#,
                "engines.vscode",
            ),
            (
                r#"{ "name": "a", "version": "1.0.0", "main": "../evil.js" }"#,
                "\"main\" must be a path inside",
            ),
            (
                r#"{ "name": "a", "version": "1.0.0", "main": "C:/x.js" }"#,
                "\"main\" must be a path inside",
            ),
            (
                r#"{ "name": "a", "version": "1.0.0", "activationEvents": "*" }"#,
                "\"activationEvents\"",
            ),
            (
                r#"{ "name": "a", "version": "1.0.0", "contributes": [] }"#,
                "\"contributes\" must be an object",
            ),
        ];
        for (text, expected) in cases {
            let error = Manifest::parse(text).expect_err(text).to_string();
            assert!(error.contains(expected), "{text}: {error}");
        }
    }

    #[test]
    fn activation_events_are_parsed_and_unknown_ones_kept_as_unsupported() {
        assert_eq!(ActivationEvent::parse("*"), ActivationEvent::Star);
        assert_eq!(
            ActivationEvent::parse("onStartupFinished"),
            ActivationEvent::OnStartupFinished
        );
        assert_eq!(
            ActivationEvent::parse("onCommand:a.b"),
            ActivationEvent::OnCommand("a.b".into())
        );
        assert_eq!(
            ActivationEvent::parse("onLanguage:python"),
            ActivationEvent::OnLanguage("python".into())
        );
        assert_eq!(
            ActivationEvent::parse("onView:explorer"),
            ActivationEvent::OnView("explorer".into())
        );
        assert_eq!(
            ActivationEvent::parse("workspaceContains:**/*.rs"),
            ActivationEvent::WorkspaceContains("**/*.rs".into())
        );
        let other = ActivationEvent::parse("onDebug");
        assert_eq!(other, ActivationEvent::Unsupported("onDebug".into()));
        assert!(!other.is_supported());
        assert_eq!(ActivationEvent::parse("onCommand:").text(), "onCommand:");
        assert_eq!(
            ActivationEvent::OnCommand("x.y".into()).text(),
            "onCommand:x.y"
        );
    }

    #[test]
    fn contributed_commands_and_languages_activate_lazily_without_being_declared() {
        let manifest = Manifest::parse(
            r#"{ "name": "a", "version": "1.0.0", "main": "m.js", "activationEvents": ["onCommand:a.go"],
                 "contributes": { "commands": [{"command":"a.go","title":"Go"},{"command":"a.two","title":"Two"}],
                                  "languages": [{"id":"alang","extensions":[".al"]}] } }"#,
        )
        .expect("valid");
        let events = manifest.effective_activation();
        assert_eq!(
            events
                .iter()
                .filter(|e| **e == ActivationEvent::OnCommand("a.go".into()))
                .count(),
            1
        );
        assert!(events.contains(&ActivationEvent::OnCommand("a.two".into())));
        assert!(events.contains(&ActivationEvent::OnLanguage("alang".into())));
    }
}

