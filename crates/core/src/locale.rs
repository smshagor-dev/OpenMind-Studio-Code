//! Which of the app's bundled UI languages fits a system language. Pure: the tags come from the OS (read by the
//! app) and nothing here does I/O. The UI text itself lives in the frontend (`src/i18n/locales/*.json`).

/// The UI languages bundled with the app (BCP 47 base tags). English is the source and the fallback.
pub const SUPPORTED_LANGUAGES: &[&str] = &["en", "ru"];

/// The language used when nothing else fits.
pub const FALLBACK_LANGUAGE: &str = "en";

/// The bundled language for one locale tag: the exact base tag (`ru-RU` -> `ru`, `ru-KZ` -> `ru`,
/// `en-GB` -> `en`), matched case-insensitively and with `_` or `-` separators. `None` when no bundled language
/// has that base (e.g. `hi-IN`, `ur-PK`, `de-DE` today).
pub fn language_for_tag(tag: &str) -> Option<&'static str> {
    let base = tag
        .trim()
        .split(['-', '_', '.', '@'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    SUPPORTED_LANGUAGES
        .iter()
        .copied()
        .find(|language| *language == base)
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
            ("ru_RU.UTF-8", "ru"),
        ] {
            assert_eq!(language_for_tag(tag), Some(language), "{tag}");
        }
    }

    #[test]
    fn languages_that_are_not_bundled_have_no_match() {
        for tag in [
            "hi-IN", "ur-PK", "ur-IN", "de-DE", "bn-BD", "bn-IN", "", "  ", "x-custom", "rus",
        ] {
            assert_eq!(language_for_tag(tag), None, "{tag}");
        }
    }

    #[test]
    fn the_first_bundled_language_in_system_order_wins_else_english() {
        assert_eq!(pick_language(&["ru-RU", "en-US"]), "ru");
        assert_eq!(pick_language(&["hi-IN", "ru-RU", "en-US"]), "ru");
        assert_eq!(pick_language(&["ur-PK", "de-DE"]), "en");
        assert_eq!(pick_language::<&str>(&[]), "en");
    }

    #[test]
    fn english_is_bundled_and_the_fallback() {
        assert!(SUPPORTED_LANGUAGES.contains(&FALLBACK_LANGUAGE));
        assert_eq!(SUPPORTED_LANGUAGES[0], "en");
    }
}
