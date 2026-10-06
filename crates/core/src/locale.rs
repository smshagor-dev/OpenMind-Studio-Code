//! Which of the app's bundled UI languages fits a system language. Pure: the tags come from the OS (read by the
//! app) and nothing here does I/O. The UI text itself lives in the frontend (`src/i18n/locales/*.json`).

/// One bundled UI language: its id (a BCP 47 tag, also the catalog's file name), its own name, its English name and
/// whether its script runs right to left.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LanguageInfo {
    pub code: &'static str,
    pub native: &'static str,
    pub english: &'static str,
    pub rtl: bool,
}

const fn lang(code: &'static str, native: &'static str, english: &'static str) -> LanguageInfo {
    LanguageInfo {
        code,
        native,
        english,
        rtl: false,
    }
}

/// Every bundled UI language, English first. A language is listed only once its catalog translates every key.
/// Mirrors `src/i18n/languages.ts` (a frontend test compares the two).
pub const LANGUAGES: &[LanguageInfo] = &[
    lang("en", "English", "English"),
    lang("ru", "Русский", "Russian"),
    lang("bn", "বাংলা", "Bangla"),
];

/// The bundled languages' ids, in the order of [`LANGUAGES`].
pub const SUPPORTED_LANGUAGES: &[&str] = &["en", "ru", "bn"];

/// The language used when nothing else fits.
pub const FALLBACK_LANGUAGE: &str = "en";

/// The bundled language for one locale tag, matched case-insensitively with `_` or `-` separators:
/// - the exact id (`pt-BR`, `zh-TW`) or its base (`ru-RU` -> `ru`, `bn-BD` / `bn-IN` -> `bn`, `en-GB` -> `en`);
/// - Chinese by script, then region: `zh-Hant` / `zh-TW` / `zh-HK` / `zh-MO` -> `zh-TW`, any other `zh` -> `zh-CN`;
/// - any Portuguese -> `pt-BR`, and the older tags `tl` -> `fil`, `iw` -> `he`, `in` -> `id`.
///
/// `None` when no bundled language fits (e.g. `de-DE` while German isn't bundled).
pub fn language_for_tag(tag: &str) -> Option<&'static str> {
    let candidate = canonical_tag(tag);
    SUPPORTED_LANGUAGES
        .iter()
        .copied()
        .find(|language| language.to_ascii_lowercase() == candidate)
}

/// The lower-case id a locale tag would be bundled under (`zh-Hant-HK` -> `zh-tw`, `ru_RU.UTF-8` -> `ru`).
fn canonical_tag(tag: &str) -> String {
    let lowered = tag.trim().to_ascii_lowercase().replace('_', "-");
    let lowered = lowered.split(['.', '@']).next().unwrap_or_default();
    let mut parts = lowered.split('-');
    let base = parts.next().unwrap_or_default();
    let rest: Vec<&str> = parts.collect();
    match base {
        "zh" if rest
            .iter()
            .any(|part| matches!(*part, "hant" | "tw" | "hk" | "mo")) =>
        {
            "zh-tw".to_string()
        }
        "zh" => "zh-cn".to_string(),
        "pt" => "pt-br".to_string(),
        "tl" => "fil".to_string(),
        "iw" => "he".to_string(),
        "in" => "id".to_string(),
        _ => base.to_string(),
    }
}

/// The bundled language with this id, if any.
pub fn language_info(code: &str) -> Option<&'static LanguageInfo> {
    LANGUAGES.iter().find(|language| language.code == code)
}

/// The first of the system's preferred languages (in the system's order) that the app bundles, else English.
pub fn pick_language<S: AsRef<str>>(tags: &[S]) -> &'static str {
    tags.iter()
        .find_map(|tag| language_for_tag(tag.as_ref()))
        .unwrap_or(FALLBACK_LANGUAGE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn region_and_script_variants_map_to_their_base_language() {
        for (tag, language) in [
            ("en-US", "en"),
            ("en-GB", "en"),
            ("EN_us", "en"),
            ("ru-RU", "ru"),
            ("ru", "ru"),
            ("ru-KZ", "ru"),
            ("bn-BD", "bn"),
            ("bn-IN", "bn"),
            ("bn_BD.UTF-8", "bn"),
        ] {
            assert_eq!(language_for_tag(tag), Some(language), "{tag}");
        }
    }

    #[test]
    fn languages_that_are_not_bundled_have_no_match() {
        for tag in [
            "hi-IN", "ur-PK", "ur-IN", "de-DE", "", "  ", "x-custom", "rus",
        ] {
            assert_eq!(language_for_tag(tag), None, "{tag}");
        }
    }

    #[test]
    fn the_first_bundled_language_in_system_order_wins_else_english() {
        assert_eq!(pick_language(&["ru-RU", "en-US"]), "ru");
        assert_eq!(pick_language(&["hi-IN", "bn-IN", "en-US"]), "bn");
        assert_eq!(pick_language(&["ur-PK", "de-DE"]), "en");
        assert_eq!(pick_language::<&str>(&[]), "en");
    }

    #[test]
    fn tags_are_reduced_to_the_id_they_would_be_bundled_under() {
        for (tag, id) in [
            ("zh-Hant-TW", "zh-tw"),
            ("zh-TW", "zh-tw"),
            ("zh_HK", "zh-tw"),
            ("zh-MO", "zh-tw"),
            ("zh-Hans-CN", "zh-cn"),
            ("zh-CN", "zh-cn"),
            ("zh-SG", "zh-cn"),
            ("zh", "zh-cn"),
            ("pt-PT", "pt-br"),
            ("pt-BR", "pt-br"),
            ("tl-PH", "fil"),
            ("fil-PH", "fil"),
            ("iw-IL", "he"),
            ("in-ID", "id"),
            ("ar-SA", "ar"),
            ("de_DE.UTF-8", "de"),
            ("  ", ""),
        ] {
            assert_eq!(canonical_tag(tag), id, "{tag}");
        }
    }

    #[test]
    fn the_language_table_and_the_id_list_agree() {
        let codes: Vec<&str> = LANGUAGES.iter().map(|language| language.code).collect();
        assert_eq!(codes, SUPPORTED_LANGUAGES);
        for language in LANGUAGES {
            assert!(!language.native.is_empty() && !language.english.is_empty());
            assert_eq!(language_for_tag(language.code), Some(language.code));
            assert_eq!(language_info(language.code), Some(language));
        }
    }

    #[test]
    fn english_is_bundled_and_the_fallback() {
        assert!(SUPPORTED_LANGUAGES.contains(&FALLBACK_LANGUAGE));
        assert_eq!(SUPPORTED_LANGUAGES[0], "en");
    }
}
