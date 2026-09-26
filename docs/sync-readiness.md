# Sync readiness

**There is no sync in OpenMind Studio**: no account, no login, no network call, no "Sync now" button. This page records
how the app-local data is laid out so a future sync can be added without reshuffling it, and what must never be synced.
The same table is data in `crates/settings/src/sync.rs`, and a test keeps it honest.

## Layout (everything is under the app folder, never AppData)

| Path | Holds | A future sync may |
| --- | --- | --- |
| `settings/settings.json` | user settings (no keys, no passwords) | sync |
| `settings/keybindings.json` | keyboard shortcuts | sync |
| `settings/profiles/*.json`, `active.json` | profiles | sync (path-free) |
| `themes/` | theme assets | sync |
| `extensions/installed/` | installed extensions | sync the *list*; code is fetched again |
| `extensions/storage/` | extension data | only if the user chooses |
| `data/ai/providers.json` | provider names/endpoints (no keys) | only if the user chooses |
| `data/ai/conversations.sqlite` | AI conversations | only if the user chooses |
| `data/openmind-studio.db` | window/session state, **DPAPI-encrypted keys and passwords**, this machine's paths | **never** |
| `data/search-index/`, `data/webview/`, `data/mariadb/` | project text, browser profile, database files | **never** |
| `runtimes/`, `tools/`, `language-servers/`, `cache/`, `logs/` | binaries, downloads, logs | **never** |

## Must never sync by default

API keys, database passwords, AI provider keys, absolute local paths (unless the user chooses), search-index content,
conversations (unless the user chooses), runtime and tool binaries.

## What is already sync-ready

- **Profiles and their export files** carry `format: "openmind-profile"`, `version: 1`, `createdAt` and `updatedAt`
  (seconds since 1970), a stable id and only the settings listed in `PROFILE_SETTINGS`. A newer `version` is refused, so an
  old app never half-reads a new file.
- **Export / import** (`profile_export` / `profile_import`) keep only valid values of those settings and drop any value that
  looks like a drive or UNC path; an import can't carry a key, a password or an unknown setting; damaged files fail safely.
- The settings schema is data (`schema.rs`) with one definition per setting id, so ids and value rules are stable.

## Not done

Conflict resolution, a remote, accounts, encryption in transit, per-device overrides. Those are a later milestone; nothing
here pretends otherwise.
