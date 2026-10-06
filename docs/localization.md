# Localization (UI language)

OpenMind Studio shows its own menus, dialogs, pages and messages in the language of the PC. Translations are JSON files
bundled with the app: nothing is downloaded, and nothing is translated by a service at run time.

## Languages

| Language | Code | State |
| --- | --- | --- |
| English | `en` | Source language and fallback |
| Russian | `ru` | Every key translated |
| Bangla | `bn` | Every key translated |

More languages are being added in steps (the global-languages work: about 30 more, including right-to-left
Arabic, Persian, Urdu and Hebrew). A language appears in this table and in Settings only when its catalog translates
every key. A PC in a language that isn't bundled gets English.

The translations were written without a translation service. They have **not been reviewed by native speakers yet**;
please report wording that reads wrong.

## Which language shows

1. The setting **Display Language** (`workbench.language`, Settings > Workbench), when it names a bundled language.
2. Otherwise (**System Default**, the default) the PC's display language: Windows' preferred UI languages in their
   order, each reduced to the id it would be bundled under (`ru-RU` -> `ru`, `bn-BD` / `bn-IN` -> `bn`, `en-GB` -> `en`;
   Chinese by script, then region: `zh-Hant`, `zh-TW`, `zh-HK`, `zh-MO` -> `zh-TW`, any other `zh` -> `zh-CN`; any Portuguese
   -> `pt-BR`; the older tags `tl` -> `fil`, `iw` -> `he`, `in` -> `id`). The first one the app bundles wins.
3. Otherwise English.

Inside a language, a key it lacks falls back to English, and a key English lacks shows the key itself. Tests keep both
from happening.

- **Detection**: `src-tauri/src/locale.rs` (`ui_language` command) reads `GetUserPreferredUILanguages` and the user's
  `settings.json` directly, so it works before and without the database, including in the start-up error window.
  Mapping: `openmind_core::locale` (Rust: `LANGUAGES`, `language_for_tag`) and `src/i18n/languages.ts` (`LANGUAGE_INFO`,
  `languageForTag`; tests keep the two equal). Detection failure means English.
- **Testing another language without changing Windows**: start the app with `OPENMIND_UI_LOCALE` set, for example
  `set OPENMIND_UI_LOCALE=ru-RU` (a comma-separated list is allowed). The answer is then marked `simulated`.
- **Changing the setting** applies at once: every screen re-renders in the new language, and no restart is needed. The Settings page's
  System Default option names the language it currently resolves to ("System Default — currently Русский").
- `main.tsx` asks for the language and loads its catalog before the first screen draws (the question waits at most 1.5 s,
  else English), so the UI never flashes English first.

## Files

- `src/i18n/languages.ts`: the bundled languages (`code`, own name, English name, right to left or not).
- `src/i18n/locales/<code>.json`: flat `key -> message` maps with stable, descriptive keys
  (`common.save`, `menu.file`, `command.file.save`, `tasks.confirm.title`, `databaseError.kind.locked.title` ...).
- A message is text with named placeholders (`"Found {count} results"`), or plural forms chosen by the `count`
  parameter with the language's rules (`{"one": "...", "few": "...", "many": "...", "other": "..."}`; `other` is required).
- `src/i18n/index.ts`: `t(key, params)`, `useT()`, `initLanguage`, `applyLanguageSetting`, `loadLanguage`. English is part of
  the main bundle; every other catalog is its own chunk of the app (`import.meta.glob`), parsed only when that language is
  shown. Switching loads the catalog first and then re-renders; when two switches overlap, the newer one wins. Components call `t`. The root screens
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
- Workloads (Milestone 22): `workloads.*` (page, states, warnings, sections), `workload.<id>.name|summary`,
  `workloadPack.<id>.name`, `workloadComponent.<id>.name|note` (catalog text; the backend's English is the fallback for an id without a
  key), `command.workloads.open`, `runtimes.tab.workloads`.
- Network (Milestone 21): `network.*` (window, card, labels, problem categories, offline import), `command.network.*` and
  `submenu.network` (Terminal > Network), `setting.network.*`. Network problem categories come from Rust as stable ids
  (`proxyAuthRequired`, `dns` ...) and are translated as `network.problem.<id>`; a tool's own output stays as printed.
- The start-up database error page gets a stable `failure.kind` (and migration version) from Rust and builds its text
  from `databaseError.kind.<kind>.*`. A Rust test keeps the English equal to `startup_error::explain`.

## Right-to-left languages

For Arabic, Persian, Urdu and Hebrew, `<html>` gets `data-ui-dir="rtl"` (and `lang`). The workbench keeps its layout,
as VS Code and JetBrains IDEs do (activity bar, side bar and editor stay where they are). Each piece of UI text runs in the
direction of its own script (`unicode-bidi: plaintext`, `src/styles/app.css`). A translated label therefore reads right to
left, while a file name, path or command inside it stays left to right. The editor (Monaco) and the terminal lay out
their own text.

## Adding a language

1. Add a row to `LANGUAGES` and its code to `SUPPORTED_LANGUAGES` in `crates/core/src/locale.rs` (`lang(...)`, or `rtl(...)`
   for a right-to-left script), and the same row to `LANGUAGE_INFO` in `src/i18n/languages.ts`. The Settings option of
   `workbench.language` is built from the table ("<own name> (<English name>)").
2. Add `setting.workbench.language.option.<code>` with that label to **every** catalog.
3. Create `src/i18n/locales/<code>.json` with **every** key of `en.json` (it is picked up as a lazily loaded chunk; no import
   to add).
4. Run `pnpm test` and `cargo test -p openmind-core -p openmind-settings`. They fail on a missing or extra key, a
   placeholder that differs from English, a plural message without `other`, a catalog file for a language that isn't
   listed, or a Rust table that differs from the TypeScript one.

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
