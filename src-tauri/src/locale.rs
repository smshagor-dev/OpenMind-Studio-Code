//! The PC's display language, for the UI language setting's "System Default". Read from Windows (the user's
//! preferred UI languages, in order); nothing is downloaded and nothing is written. The environment variable
//! `OPENMIND_UI_LOCALE` (comma-separated tags, e.g. `ru-RU`) replaces what Windows says — a testing aid for checking
//! a language without changing the PC's settings.

use openmind_core::locale::{pick_language, SUPPORTED_LANGUAGES};
use serde::Serialize;

const SIMULATED_LOCALE_VAR: &str = "OPENMIND_UI_LOCALE";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UiLanguage {
    /// The system's preferred UI languages, most preferred first (e.g. `["ru-RU", "en-US"]`).
    pub system_tags: Vec<String>,
    /// The bundled language System Default resolves to (`en` when none of the tags is bundled).
    pub system_language: &'static str,
    /// The user's setting: `system` or a bundled language.
    pub setting: String,
    /// What the UI uses now.
    pub language: String,
    pub supported: &'static [&'static str],
    /// The tags came from `OPENMIND_UI_LOCALE`, not from Windows.
    pub simulated: bool,
}

/// Builds the answer from already-read inputs (so it can be tested without Windows or a settings file).
pub fn describe(system_tags: Vec<String>, simulated: bool, setting: String) -> UiLanguage {
    let system_language = pick_language(&system_tags);
    let language = openmind_settings::language::effective_language(&setting, system_language);
    UiLanguage {
        system_tags,
        system_language,
        setting,
        language,
        supported: SUPPORTED_LANGUAGES,
        simulated,
    }
}

/// The simulated tags, when the variable is set to something.
fn simulated_tags(value: Option<String>) -> Option<Vec<String>> {
    let tags: Vec<String> = value?
        .split(',')
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .map(str::to_string)
        .collect();
    (!tags.is_empty()).then_some(tags)
}

#[cfg(windows)]
fn system_ui_tags() -> Vec<String> {
    use winapi::um::winnls::GetUserPreferredUILanguages;
    const MUI_LANGUAGE_NAME: u32 = 0x8;
    let mut count: u32 = 0;
    let mut len: u32 = 0;
    // SAFETY: the first call only asks for the buffer size (null buffer, valid out-pointers).
    let sized = unsafe {
        GetUserPreferredUILanguages(
            MUI_LANGUAGE_NAME,
            &mut count,
            std::ptr::null_mut(),
            &mut len,
        )
    };
    if sized == 0 || len == 0 {
        return Vec::new();
    }
    let mut buffer = vec![0u16; len as usize];
    // SAFETY: `buffer` holds exactly `len` UTF-16 units, as the first call asked for.
    let read = unsafe {
        GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, buffer.as_mut_ptr(), &mut len)
    };
    if read == 0 {
        return Vec::new();
    }
    // A double-NUL-terminated list of NUL-terminated names.
    buffer
        .split(|unit| *unit == 0)
        .filter(|name| !name.is_empty())
        .map(String::from_utf16_lossy)
        .collect()
}

#[cfg(not(windows))]
fn system_ui_tags() -> Vec<String> {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .filter_map(|name| std::env::var(name).ok())
        .filter(|value| !value.is_empty() && value != "C" && value != "POSIX")
        .take(1)
        .collect()
}

/// The UI language: works in every window, including the start-up error window (no database needed).
#[tauri::command]
pub fn ui_language() -> UiLanguage {
    let (tags, simulated) = match simulated_tags(std::env::var(SIMULATED_LOCALE_VAR).ok()) {
        Some(tags) => (tags, true),
        None => (system_ui_tags(), false),
    };
    let setting = openmind_core::AppPaths::resolve()
        .map(|paths| openmind_settings::language::language_setting(&paths.settings_file))
        .unwrap_or_else(|_| openmind_settings::language::SYSTEM.to_string());
    describe(tags, simulated, setting)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(list: &[&str]) -> Vec<String> {
        list.iter().map(|tag| (*tag).to_string()).collect()
    }

    #[test]
    fn system_default_follows_the_first_bundled_system_language() {
        let answer = describe(tags(&["ru-RU", "en-US"]), false, "system".into());
        assert_eq!(answer.system_language, "ru");
        assert_eq!(answer.language, "ru");
        let answer = describe(tags(&["hi-IN"]), false, "system".into());
        assert_eq!(answer.system_language, "en");
        assert_eq!(answer.language, "en");
    }

    #[test]
    fn a_manual_choice_beats_the_system_language() {
        let answer = describe(tags(&["ru-RU"]), false, "en".into());
        assert_eq!(answer.language, "en");
        assert_eq!(answer.system_language, "ru");
    }

    #[test]
    fn the_simulation_variable_is_a_comma_list_and_blank_means_windows() {
        assert_eq!(
            simulated_tags(Some(" ru-RU , en-US ".into())),
            Some(tags(&["ru-RU", "en-US"]))
        );
        assert_eq!(simulated_tags(Some(" , ".into())), None);
        assert_eq!(simulated_tags(None), None);
    }

    #[test]
    fn windows_reports_at_least_one_language() {
        let found = system_ui_tags();
        if cfg!(windows) {
            assert!(!found.is_empty(), "Windows always has a display language");
            assert!(
                found.iter().all(|tag| tag.contains('-') || tag.len() == 2),
                "{found:?}"
            );
        }
    }
}
