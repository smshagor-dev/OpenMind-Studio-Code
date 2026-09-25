//! What enabled extensions add to the Settings: their configuration properties (in a category named after
//! the extension) and their colour themes (extra choices of the Color Theme setting).

use openmind_settings::{EnumOption, Extras, SettingDef, SettingKind, SettingScope};

use crate::contributions::{ConfigurationKind, ConfigurationProperty};
use crate::store::InstalledExtension;

/// The id a colour theme has as a value of `workbench.colorTheme`.
pub fn theme_value(extension_id: &str, label: &str) -> String {
    format!("extension:{extension_id}/{label}")
}

/// Settings and themes of the enabled extensions, in a stable order.
pub fn extras_for(extensions: &[InstalledExtension]) -> Extras {
    let mut enabled: Vec<&InstalledExtension> = extensions
        .iter()
        .filter(|extension| extension.enabled)
        .collect();
    enabled.sort_by(|a, b| a.id.cmp(&b.id));
    let mut extras = Extras::default();
    for extension in enabled {
        let category = extension
            .manifest
            .display_name
            .clone()
            .unwrap_or_else(|| extension.manifest.name.clone());
        for property in &extension.manifest.contributes.configuration {
            extras.settings.push(setting(property, &category));
        }
        for theme in &extension.manifest.contributes.themes {
            extras.themes.push(EnumOption {
                value: theme_value(&extension.id, &theme.label),
                label: theme.label.clone(),
            });
        }
    }
    extras
}

pub(crate) fn setting(property: &ConfigurationProperty, category: &str) -> SettingDef {
    let kind = match &property.kind {
        ConfigurationKind::Boolean => SettingKind::Bool,
        ConfigurationKind::Integer { minimum, maximum } => SettingKind::Int {
            min: *minimum,
            max: *maximum,
        },
        ConfigurationKind::String { max_length } => SettingKind::Text {
            max_length: *max_length,
        },
        ConfigurationKind::Enum { options } => SettingKind::Enum {
            options: options
                .iter()
                .map(|value| EnumOption {
                    value: value.clone(),
                    label: value.clone(),
                })
                .collect(),
        },
    };
    SettingDef {
        id: property.key.clone(),
        category: property
            .title
            .clone()
            .unwrap_or_else(|| category.to_string()),
        title: humanize(&property.key),
        description: property.description.clone(),
        kind,
        default: property.default.clone(),
        scope: SettingScope::Both,
    }
}

/// `sampleConfig.greeting` -> `Greeting`; `a.b.maxLineLength` -> `Max Line Length`.
fn humanize(key: &str) -> String {
    let last = key.rsplit('.').next().unwrap_or(key);
    let mut out = String::new();
    for (index, ch) in last.chars().enumerate() {
        if ch == '-' || ch == '_' {
            out.push(' ');
        } else if ch.is_uppercase() && index > 0 {
            out.push(' ');
            out.push(ch);
        } else if index == 0 || out.ends_with(' ') {
            out.extend(ch.to_uppercase());
        } else {
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::Manifest;
    use crate::store::describe_for_tests;

    fn extension(json: &str, enabled: bool) -> InstalledExtension {
        describe_for_tests(Manifest::parse(json).expect("valid"), enabled)
    }

    const CONFIG: &str = r#"{"name":"cfg","displayName":"Sample Configuration","version":"1.0.0","publisher":"acme",
        "contributes":{"configuration":{"properties":{
            "sampleConfig.greeting":{"type":"string","default":"Hello","description":"Says hi."},
            "sampleConfig.maxLineLength":{"type":"integer","default":80,"minimum":10,"maximum":200},
            "sampleConfig.mode":{"type":"string","enum":["a","b"],"default":"a"},
            "sampleConfig.on":{"type":"boolean","default":true}}},
          "themes":[{"label":"Night","uiTheme":"vs-dark","path":"./t.json"}]}}"#;

    #[test]
    fn humanize_makes_readable_titles() {
        assert_eq!(humanize("sampleConfig.greeting"), "Greeting");
        assert_eq!(humanize("a.b.maxLineLength"), "Max Line Length");
        assert_eq!(humanize("x.some-thing_else"), "Some Thing Else");
    }

    #[test]
    fn configuration_properties_become_settings_in_the_extensions_category() {
        let extras = extras_for(&[extension(CONFIG, true)]);
        let ids: Vec<&str> = extras.settings.iter().map(|def| def.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "sampleConfig.greeting",
                "sampleConfig.maxLineLength",
                "sampleConfig.mode",
                "sampleConfig.on"
            ]
        );
        assert!(extras
            .settings
            .iter()
            .all(|def| def.category == "Sample Configuration"));
        let length = extras
            .settings
            .iter()
            .find(|def| def.id == "sampleConfig.maxLineLength")
            .expect("length");
        assert_eq!(length.kind, SettingKind::Int { min: 10, max: 200 });
        assert_eq!(length.title, "Max Line Length");
        let greeting = &extras.settings[0];
        assert_eq!(greeting.description, "Says hi.");
        assert_eq!(greeting.default, serde_json::json!("Hello"));
    }

    #[test]
    fn themes_are_offered_as_extension_values() {
        let extras = extras_for(&[extension(CONFIG, true)]);
        assert_eq!(
            extras.themes,
            vec![EnumOption {
                value: "extension:acme.cfg/Night".to_string(),
                label: "Night".to_string()
            }]
        );
    }

    #[test]
    fn disabled_extensions_add_nothing() {
        let extras = extras_for(&[extension(CONFIG, false)]);
        assert!(extras.settings.is_empty());
        assert!(extras.themes.is_empty());
    }
}
