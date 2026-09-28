//! The Settings page shows a built-in setting translated only when the UI catalog's English is exactly what this
//! schema says (otherwise it falls back to the schema's English). This keeps the two from drifting apart.

use openmind_settings::schema::{definitions, Extras};
use openmind_settings::SettingKind;
use serde_json::Value;

fn english_catalog() -> serde_json::Map<String, Value> {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/i18n/locales/en.json");
    let text = std::fs::read_to_string(&path).expect("the UI's English catalog");
    match serde_json::from_str(&text).expect("valid JSON") {
        Value::Object(map) => map,
        _ => panic!("en.json must be an object"),
    }
}

#[test]
fn every_built_in_setting_is_in_the_english_ui_catalog_word_for_word() {
    let catalog = english_catalog();
    let text = |key: String| {
        catalog
            .get(&key)
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    for def in definitions(&Extras::default()) {
        assert_eq!(
            text(format!("setting.{}.title", def.id)),
            Some(def.title.clone()),
            "{}",
            def.id
        );
        assert_eq!(
            text(format!("setting.{}.description", def.id)),
            Some(def.description.clone()),
            "{}",
            def.id
        );
        if let SettingKind::Enum { options } = &def.kind {
            for option in options {
                assert_eq!(
                    text(format!("setting.{}.option.{}", def.id, option.value)),
                    Some(option.label.clone()),
                    "{} = {}",
                    def.id,
                    option.value
                );
            }
        }
    }
}

#[test]
fn the_language_setting_offers_system_default_and_every_bundled_language() {
    let def =
        openmind_settings::schema::find("workbench.language", &Extras::default()).expect("defined");
    assert_eq!(def.default, serde_json::json!("system"));
    assert_eq!(def.scope, openmind_settings::SettingScope::User);
    let SettingKind::Enum { options } = def.kind else {
        panic!("an enum");
    };
    let values: Vec<&str> = options.iter().map(|o| o.value.as_str()).collect();
    let mut expected = vec!["system"];
    expected.extend(openmind_core::locale::SUPPORTED_LANGUAGES);
    assert_eq!(values, expected);
}
