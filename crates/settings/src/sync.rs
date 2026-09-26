//! Sync readiness (Milestone 16). **There is no sync**: no account, no login, no network call, no "Sync now". This
//! only records, as data, what a future sync may carry and what must never leave the machine by default, so the
//! app-local layout can be checked against it by a test and the docs (`docs/sync-readiness.md`) stay true.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncClass {
    /// May be synced (no secret, no local path).
    Syncable,
    /// Only if the user chooses it (personal or path-bearing).
    UserChoice,
    /// Never, by default or by any setting in this app.
    Never,
}

/// A folder or file under the app root and what a sync may do with it.
pub const LAYOUT: &[(&str, SyncClass, &str)] = &[
    (
        "settings/settings.json",
        SyncClass::Syncable,
        "user settings (no keys, no passwords)",
    ),
    (
        "settings/keybindings.json",
        SyncClass::Syncable,
        "keyboard shortcuts",
    ),
    (
        "settings/profiles/",
        SyncClass::Syncable,
        "profiles: format + version + timestamps, path-free",
    ),
    ("themes/", SyncClass::Syncable, "theme assets"),
    (
        "extensions/installed/",
        SyncClass::UserChoice,
        "the list of extensions could sync; the code is fetched again",
    ),
    (
        "extensions/storage/",
        SyncClass::UserChoice,
        "extension data can hold anything",
    ),
    (
        "data/ai/providers.json",
        SyncClass::UserChoice,
        "provider names and endpoints, never keys",
    ),
    (
        "data/ai/conversations.sqlite",
        SyncClass::UserChoice,
        "conversations are personal",
    ),
    (
        "data/openmind-studio.db",
        SyncClass::Never,
        "holds DPAPI-encrypted keys and passwords and this machine's paths",
    ),
    ("data/search-index/", SyncClass::Never, "project text"),
    ("data/webview/", SyncClass::Never, "browser profile"),
    ("data/mariadb/", SyncClass::Never, "database files"),
    ("runtimes/", SyncClass::Never, "runtime binaries"),
    ("tools/", SyncClass::Never, "tool binaries"),
    ("language-servers/", SyncClass::Never, "installed servers"),
    ("cache/", SyncClass::Never, "downloads and staging"),
    ("logs/", SyncClass::Never, "logs"),
];

/// Settings that can hold a secret or a local path and are therefore never part of a profile or an export.
pub const NEVER_EXPORTED_SETTING_PREFIXES: &[&str] = &[
    "ai.key.",
    "mariadb.",
    "pma.",
    "git.allowSystem",
    "php.server",
    "run.configurations",
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::PROFILE_SETTINGS;

    #[test]
    fn anything_that_can_hold_a_secret_or_bulk_data_is_never_synced() {
        for (path, class, _) in LAYOUT {
            let sensitive = [
                "openmind-studio.db",
                "search-index",
                "runtimes",
                "tools/",
                "cache",
                "logs",
                "webview",
                "mariadb",
                "language-servers",
            ]
            .iter()
            .any(|needle| path.contains(needle));
            if sensitive {
                assert_eq!(*class, SyncClass::Never, "{path}");
            }
        }
        assert!(
            LAYOUT
                .iter()
                .all(|(path, _, _)| !path.starts_with('/') && !path.contains(':')),
            "paths are app-relative"
        );
    }

    #[test]
    fn no_profile_setting_is_on_the_never_exported_list() {
        for id in PROFILE_SETTINGS {
            assert!(
                !NEVER_EXPORTED_SETTING_PREFIXES
                    .iter()
                    .any(|prefix| id.starts_with(prefix)),
                "{id}"
            );
        }
    }
}
