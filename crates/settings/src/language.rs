//! The UI language setting (`workbench.language`): `system` (the default: follow the PC's language) or one of the
//! bundled languages. Read straight from the user's `settings.json`, so it works before (and without) the database.

use std::path::Path;

use crate::schema::Extras;
use crate::store::{self, Layer};

pub const LANGUAGE_SETTING: &str = "workbench.language";

/// The value that means "follow the system language".
pub const SYSTEM: &str = "system";

/// The user's language choice: a bundled language id, or `system` when unset, invalid or the file is broken.
pub fn language_setting(user_settings_file: &Path) -> String {
    let user: Layer = store::read_layer(user_settings_file);
    store::effective(&user, None, &Extras::default())
        .into_iter()
        .find(|setting| setting.id == LANGUAGE_SETTING)
        .and_then(|setting| setting.value.as_str().map(str::to_string))
        .unwrap_or_else(|| SYSTEM.to_string())
}

/// What the UI shows: the chosen language, or the system's when the choice is `system`.
pub fn effective_language(setting: &str, system_language: &'static str) -> String {
    if setting == SYSTEM || openmind_core::locale::language_for_tag(setting).is_none() {
        system_language.to_string()
    } else {
        setting.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unset_missing_or_broken_files_mean_system() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("settings.json");
        assert_eq!(language_setting(&file), SYSTEM);
        std::fs::write(&file, "{ broken").expect("write");
        assert_eq!(language_setting(&file), SYSTEM);
        std::fs::write(&file, r#"{"workbench.language": "klingon"}"#).expect("write");
        assert_eq!(
            language_setting(&file),
            SYSTEM,
            "an invalid value is ignored"
        );
    }

    #[test]
    fn a_manual_choice_is_persisted_and_read_back() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("settings.json");
        std::fs::write(&file, r#"{"editor.fontSize": 18}"#).expect("write");
        store::set_value(
            &file,
            LANGUAGE_SETTING,
            &json!("bn"),
            false,
            &Extras::default(),
        )
        .expect("set");
        assert_eq!(language_setting(&file), "bn");
        let text = std::fs::read_to_string(&file).expect("read");
        assert!(
            text.contains("\"editor.fontSize\": 18"),
            "other settings are kept: {text}"
        );
        assert!(
            store::set_value(
                &file,
                LANGUAGE_SETTING,
                &json!("bn"),
                true,
                &Extras::default()
            )
            .is_err(),
            "the language is a user setting, not a workspace one"
        );
    }

    #[test]
    fn fallback_chain_setting_then_system_then_english() {
        assert_eq!(effective_language("ru", "bn"), "ru");
        assert_eq!(effective_language(SYSTEM, "bn"), "bn");
        assert_eq!(
            effective_language(SYSTEM, openmind_core::locale::pick_language(&["hi-IN"])),
            "en"
        );
        assert_eq!(effective_language("xx", "ru"), "ru");
    }
}
