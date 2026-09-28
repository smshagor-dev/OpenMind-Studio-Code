# Localization (UI language)

OpenMind Studio shows its own menus, dialogs, pages and messages in the language of the PC. Translations are JSON files
bundled with the app: nothing is downloaded, and nothing is translated by a service at run time.

## Languages

| Language | Code | State |
| --- | --- | --- |
| English | `en` | Source language and fallback |
| Russian | `ru` | Every key translated |
| Bangla | `bn` | Every key translated |

Hindi, Urdu and German are not bundled. A PC in one of them gets English.

The Russian and Bangla text was written for this milestone without a translation service. It has **not been reviewed
by native speakers yet**; please report wording that reads wrong.

## Which language shows

1. The setting **Display Language** (`workbench.language`, Settings > Workbench), when it names a bundled language.
2. Otherwise (**System Default**, the default) the PC's display language: Windows' preferred UI languages in their
   order, each reduced to its base (`ru-RU` -> `ru`, `bn-BD` / `bn-IN` -> `bn`, `en-GB` -> `en`). The first one the app
   bundles wins.
3. Otherwise English.

Inside a language, a key it lacks falls back to English, and a key English lacks shows the key itself. Tests keep both
from happening.

- **Detection**: `src-tauri/src/locale.rs` (`ui_language` command) reads `GetUserPreferredUILanguages` and the user's
  `settings.json` directly, so it works before and without the database, including in the start-up error window.
  Mapping: `openmind_core::locale` (Rust) and `src/i18n/i18n.ts` (`languageForTag`, `resolveLanguage`). Detection
  failure means English.
- **Testing another language without changing Windows**: start the app with `OPENMIND_UI_LOCALE` set, for example
  `set OPENMIND_UI_LOCALE=ru-RU` (a comma-separated list is allowed). The answer is then marked `simulated`.
- **Changing the setting** applies at once: every screen re-renders in the new language, and no restart is needed. The Settings page's
  System Default option names the language it currently resolves to ("System Default — currently Русский").
- `main.tsx` asks for the language before the first screen draws (at most 1.5 s, else English), so the UI never flashes
  English first.

## Files

- `src/i18n/locales/en.json`, `ru.json`, `bn.json`: flat `key -> message` maps with stable, descriptive keys
  (`common.save`, `menu.file`, `command.file.save`, `tasks.confirm.title`, `databaseError.kind.locked.title` ...).
- A message is text with named placeholders (`"Found {count} results"`), or plural forms chosen by the `count`
  parameter with the language's rules (`{"one": "...", "few": "...", "many": "...", "other": "..."}`; `other` is required).
- `src/i18n/index.ts`: `t(key, params)`, `useT()`, `initLanguage`, `applyLanguageSetting`. Components call `t`. The root screens
  (`App`, the PHP window, the start-up error page) subscribe, so a language change re-renders everything under them.
- `src/i18n/menuLabels.ts`: the title-bar menus stay English data in `menus.ts` and are translated when a menu opens
  (`command.<id>`, `command.<id>.alt`, `command.<id>.toggled`, `submenu.<name>`, `menu.<id>`). A row is translated only
  when its label is the English text of its key, so rows that carry data (a recent folder's path, a shell's name, a project
  command) keep their text.
- `src/i18n/settingsText.ts`: setting titles, descriptions, options and categories come from the backend in English and
  are translated when the catalog's English matches (a Rust test keeps `en.json` equal to the schema). An extension's
  settings keep the extension's text. Settings search matches both languages.
- `src/i18n/backendText.ts`: a short list of English sentences the backend sends that matter for a decision (a task's
  risks, the notebook save conflict, the debugger's "not installed" reasons), matched exactly.
- The start-up database error page gets a stable `failure.kind` (and migration version) from Rust and builds its text
  from `databaseError.kind.<kind>.*`. A Rust test keeps the English equal to `startup_error::explain`.

## Adding a language

1. Add its code to `SUPPORTED_LANGUAGES` in `crates/core/src/locale.rs`, to `LANGUAGES` and `LANGUAGE_NAMES` in
   `src/i18n/i18n.ts`, and an option to `workbench.language` in `crates/settings/src/schema.rs` (its own name and the
   English name in brackets). Add `setting.workbench.language.option.<code>` to every catalog.
2. Create `src/i18n/locales/<code>.json` with **every** key of `en.json`, import it in `src/i18n/index.ts`, and add it to
   the `I18n` constructor.
3. Run `pnpm test`: the catalog test fails on a missing or extra key, a placeholder that differs from English, or a plural
   message without `other`.

## What stays English, on purpose

- Code, file paths, command ids, extension ids, language ids, setting ids, JSON keys, log lines and Output channel lines
  (logs are for reports).
- Extensions' own text: their names, descriptions, commands, settings, webviews and messages (an extension can localize
  itself with `package.nls.json`).
- Text that comes from outside the app: language server and debugger messages, compiler and tool output, Git output,
  Open VSX data, runtime descriptions and notes (from the runtime manifests), and most backend error messages (only the
  sentences listed in `backendText.ts` are translated).
- **Monaco's own UI**: the find/replace box, the F1 command palette and editor context-menu actions, hovers' chrome.
  Monaco's ESM build has no bundled translations. The Settings page notes this under Display Language.
- The copied **error details** of the start-up error page stay English, so bug reports are readable.
- Native dialogs (Open/Save file, folder pickers) are drawn by Windows in the Windows language. The window title stays
  "OpenMind Studio".
- The installers (NSIS/MSI) are English: the build scripts don't configure installer languages yet.
- Not every screen is converted yet: parts of Source Control (Git), the PHP window's Web Root/Ports/PHP-version/Composer/Laravel
  cards, the About window, formatter and language-status dialogs, and several services' notices are still English. They
  use the same mechanism when converted.
