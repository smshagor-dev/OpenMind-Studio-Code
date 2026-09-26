//! Which formatter a file gets. Candidates come from the built-in formatters and from the language registry's
//! formatter tools (found by `openmind-language`: the project's own copy first, then bundled app-local tools, then
//! OpenMind's portable runtimes, then the machine's PATH). The order is: the user's chosen default, the project's own
//! tool, a bundled tool, a built-in formatter, a portable runtime tool, the system PATH (only when allowed), and
//! otherwise a clear reason. Nothing here runs or installs anything.

use std::path::Path;

use openmind_language::commands::Category;
use openmind_language::format::{options, FormatOption};
use openmind_language::tools::{Source, ToolEnv};
use openmind_language::LanguageDef;
use serde::{Deserialize, Serialize};

/// The id of the built-in JSON formatter.
pub const BUILTIN_JSON: &str = "builtin.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FormatterSource {
    BuiltIn,
    Project,
    Bundled,
    Portable,
    System,
}

impl FormatterSource {
    fn rank(self) -> u8 {
        match self {
            Self::Project => 1,
            Self::Bundled => 2,
            Self::BuiltIn => 3,
            Self::Portable => 4,
            Self::System => 5,
        }
    }
}

/// Which kinds of tool may be used (the `formatter.use*Tools` settings). OpenMind's portable runtimes always may.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub project: bool,
    pub bundled: bool,
    pub system: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    /// Runs inside this app.
    BuiltIn,
    /// Text goes through the tool's stdin/stdout.
    Stdin,
    /// The tool only works on files on disk (Format Document can't use it).
    File,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatterInfo {
    pub id: String,
    pub name: String,
    pub source: Option<FormatterSource>,
    pub mode: Mode,
    pub available: bool,
    /// Why it can't be used right now.
    pub reason: Option<String>,
    /// Where the tool was found.
    pub path: Option<String>,
}

/// A candidate with what is needed to run it.
#[derive(Debug, Clone)]
pub struct Resolved {
    pub info: FormatterInfo,
    /// Program first (only for [`Mode::Stdin`]).
    pub argv: Vec<String>,
}

fn source_of(source: Source) -> FormatterSource {
    match source {
        Source::Project => FormatterSource::Project,
        Source::Bundled => FormatterSource::Bundled,
        Source::Portable => FormatterSource::Portable,
        Source::System | Source::Env => FormatterSource::System,
    }
}

fn blocked_by_policy(source: FormatterSource, policy: &Policy) -> Option<&'static str> {
    match source {
        FormatterSource::Project if !policy.project => {
            Some("Project tools are turned off (setting formatter.useProjectLocalTools).")
        }
        FormatterSource::Bundled if !policy.bundled => {
            Some("Bundled tools are turned off (setting formatter.useBundledTools).")
        }
        FormatterSource::System if !policy.system => Some(
            "A tool found on the system PATH is not used unless you allow it (setting formatter.useSystemTools).",
        ),
        _ => None,
    }
}

fn builtin_for(language: &LanguageDef) -> Option<Resolved> {
    matches!(language.id, "json" | "jsonc").then(|| Resolved {
        info: FormatterInfo {
            id: BUILTIN_JSON.into(),
            name: "Built-in JSON formatter".into(),
            source: Some(FormatterSource::BuiltIn),
            mode: Mode::BuiltIn,
            available: true,
            reason: None,
            path: None,
        },
        argv: Vec::new(),
    })
}

fn from_option(option: FormatOption, policy: &Policy, turned_off: Option<&str>) -> Resolved {
    let stdin = !option.stdin_argv.is_empty();
    let source = option.found.as_ref().map(|found| source_of(found.source));
    let path = option.found.as_ref().map(|found| found.path.clone());
    let blocked = source.and_then(|s| blocked_by_policy(s, policy));
    let (available, reason) = if source.is_none() {
        let reason = match turned_off {
            Some(text) => format!(
                "{} is only available from a source that is turned off. {text}",
                option.name
            ),
            None => format!("{} not found. {}", option.name, option.hint),
        };
        (false, Some(reason))
    } else if let Some(text) = blocked {
        (false, Some(text.to_string()))
    } else if !stdin {
        (
            false,
            Some(format!(
                "{} formats files on disk, not the text in the editor. Save the file and use Format Saved File With Tool.",
                option.name
            )),
        )
    } else {
        (true, None)
    };
    Resolved {
        info: FormatterInfo {
            id: option.tool,
            name: option.name,
            source,
            mode: if stdin { Mode::Stdin } else { Mode::File },
            available,
            reason,
            path,
        },
        argv: option.stdin_argv,
    }
}

/// Every formatter that could apply to `file`, best first. Tools that only sort imports are not document formatters.
pub fn candidates(
    language: &LanguageDef,
    file: &str,
    env: &ToolEnv,
    policy: &Policy,
) -> Vec<Resolved> {
    let mut list: Vec<Resolved> = builtin_for(language).into_iter().collect();
    // A source that is turned off is not searched, so the next source can supply the tool; the full search only
    // explains why a tool looks missing.
    let mut restricted = env.clone();
    if !policy.project {
        restricted.project_dirs.clear();
    }
    if !policy.bundled {
        restricted.bundled_dirs.clear();
    }
    let full = options(language, Category::Format, file, env);
    list.extend(
        options(language, Category::Format, file, &restricted)
            .into_iter()
            .filter(|option| option.tool != "isort")
            .map(|option| {
                let turned_off = full
                    .iter()
                    .find(|f| f.tool == option.tool)
                    .and_then(|f| f.found.as_ref())
                    .filter(|_| option.found.is_none())
                    .and_then(|found| blocked_by_policy(source_of(found.source), policy));
                from_option(option, policy, turned_off)
            }),
    );
    // Stable: equal ranks keep the registry's order.
    list.sort_by_key(|r| match (r.info.available, r.info.source) {
        (true, Some(source)) => source.rank(),
        _ => 9,
    });
    list
}

/// What to use: the user's `preferred` formatter when it is one of the candidates, else the best available. `Err` is
/// the sentence to show the user.
pub fn choose<'a>(
    language_name: &str,
    list: &'a [Resolved],
    preferred: Option<&str>,
) -> Result<&'a Resolved, String> {
    if let Some(chosen) = preferred.and_then(|id| list.iter().find(|r| r.info.id == id)) {
        return if chosen.info.available {
            Ok(chosen)
        } else {
            Err(format!(
                "Your default formatter for {language_name} ({}) can't be used. {} Choose another with Format Document With.",
                chosen.info.name,
                chosen.info.reason.clone().unwrap_or_default()
            ))
        };
    }
    if let Some(best) = list.iter().find(|r| r.info.available) {
        return Ok(best);
    }
    match list.first() {
        None => Err(format!("No formatter configured for {language_name}.")),
        Some(first) => Err(format!(
            "No formatter available for {language_name}. {}",
            first.info.reason.clone().unwrap_or_default()
        )),
    }
}

/// The file name a tool is told (for its config and language): the real path, or a name made from the language.
pub fn file_arg(path: Option<&Path>, language: &LanguageDef) -> String {
    match path {
        Some(path) => path.to_string_lossy().into_owned(),
        None => format!(
            "untitled{}",
            language.extensions.first().copied().unwrap_or(".txt")
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openmind_language::registry::by_id;
    use openmind_language::tools::Os;
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn env(
        project: &Path,
        bundled: Option<&Path>,
        portable: Option<&Path>,
        system: &Path,
    ) -> ToolEnv {
        ToolEnv {
            os: Os::Linux,
            project_dirs: vec![project.to_path_buf()],
            bundled_dirs: bundled.map(Path::to_path_buf).into_iter().collect(),
            portable_dirs: portable.map(Path::to_path_buf).into_iter().collect(),
            system_dirs: vec![system.to_path_buf()],
            pathext: vec![],
            vars: HashMap::new(),
        }
    }

    const ALL: Policy = Policy {
        project: true,
        bundled: true,
        system: true,
    };

    fn touch(dir: &Path, name: &str) {
        std::fs::write(dir.join(name), "").expect("file");
    }

    fn dirs() -> [tempfile::TempDir; 4] {
        [(); 4].map(|()| tempfile::tempdir().expect("tmp"))
    }

    #[test]
    fn project_beats_bundled_beats_builtin_beats_portable_beats_system() {
        let [project, bundled, portable, system] = dirs();
        for d in [&project, &bundled, &portable, &system] {
            touch(d.path(), "prettier");
        }
        let ts = by_id("typescript").expect("ts");
        let e = env(
            project.path(),
            Some(bundled.path()),
            Some(portable.path()),
            system.path(),
        );
        let list = candidates(ts, "/w/a.ts", &e, &ALL);
        assert_eq!(list[0].info.source, Some(FormatterSource::Project));
        let no_project = Policy {
            project: false,
            ..ALL
        };
        let list = candidates(ts, "/w/a.ts", &e, &no_project);
        assert_eq!(list[0].info.source, Some(FormatterSource::Bundled));
        // JSON: the built-in one sits between the bundled and the portable/system tools.
        let json = by_id("json").expect("json");
        let only_portable = env(project.path(), None, Some(portable.path()), system.path());
        let list = candidates(json, "/w/a.json", &only_portable, &no_project);
        assert_eq!(list[0].info.id, BUILTIN_JSON);
        assert_eq!(list[1].info.source, Some(FormatterSource::Portable));
        let with_bundled = env(
            project.path(),
            Some(bundled.path()),
            Some(portable.path()),
            system.path(),
        );
        let list = candidates(json, "/w/a.json", &with_bundled, &no_project);
        assert_eq!(list[0].info.source, Some(FormatterSource::Bundled));
    }

    #[test]
    fn system_tools_are_refused_unless_allowed_and_say_so() {
        let [project, _b, _p, system] = dirs();
        touch(system.path(), "prettier");
        let ts = by_id("typescript").expect("ts");
        let e = env(project.path(), None, None, system.path());
        let off = Policy {
            system: false,
            ..ALL
        };
        let list = candidates(ts, "/w/a.ts", &e, &off);
        let err = choose("TypeScript", &list, None).expect_err("nothing usable");
        assert!(err.contains("formatter.useSystemTools"), "{err}");
        assert!(choose("TypeScript", &candidates(ts, "/w/a.ts", &e, &ALL), None).is_ok());
    }

    #[test]
    fn a_missing_formatter_has_a_reason_and_a_language_without_any_says_so() {
        let [project, _b, _p, system] = dirs();
        let e = env(project.path(), None, None, system.path());
        let py = by_id("python").expect("py");
        let list = candidates(py, "/w/a.py", &e, &ALL);
        let err = choose("Python", &list, None).expect_err("none");
        assert!(
            err.starts_with("No formatter available for Python."),
            "{err}"
        );
        assert!(err.contains("not found"), "{err}");
        let txt = by_id("plaintext").expect("txt");
        assert_eq!(
            choose("Plain Text", &candidates(txt, "/w/a.txt", &e, &ALL), None).expect_err("none"),
            "No formatter configured for Plain Text."
        );
    }

    #[test]
    fn the_users_default_is_used_when_available_and_never_silently_replaced() {
        let [project, _b, _p, system] = dirs();
        touch(project.path(), "prettier");
        let json = by_id("json").expect("json");
        let e = env(project.path(), None, None, system.path());
        let list = candidates(json, "/w/a.json", &e, &ALL);
        assert_eq!(
            choose("JSON", &list, None).expect("best").info.id,
            "prettier"
        );
        assert_eq!(
            choose("JSON", &list, Some(BUILTIN_JSON))
                .expect("chosen")
                .info
                .id,
            BUILTIN_JSON
        );
        let err = choose("JSON", &list, Some("biome")).expect_err("biome is missing");
        assert!(
            err.contains("Biome") && err.contains("Format Document With"),
            "{err}"
        );
        // An id that isn't a candidate for this language (a global default) is ignored.
        assert_eq!(
            choose("JSON", &list, Some("black"))
                .expect("ignored")
                .info
                .id,
            "prettier"
        );
    }

    #[test]
    fn file_only_tools_are_not_offered_for_format_document() {
        let [project, _b, _p, system] = dirs();
        touch(project.path(), "pint");
        let php = by_id("php").expect("php");
        let e = env(project.path(), None, None, system.path());
        let list = candidates(php, "/w/a.php", &e, &ALL);
        let pint = list.iter().find(|r| r.info.id == "pint").expect("pint");
        assert_eq!(pint.info.mode, Mode::File);
        assert!(!pint.info.available);
        assert!(pint
            .info
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("Format Saved File"));
    }

    #[test]
    fn stdin_tools_get_their_argument_list() {
        let [project, _b, _p, system] = dirs();
        touch(project.path(), "ruff");
        let py = by_id("python").expect("py");
        let e = env(project.path(), None, None, system.path());
        let list = candidates(py, "/w/a b.py", &e, &ALL);
        let ruff = list.iter().find(|r| r.info.id == "ruff").expect("ruff");
        assert!(ruff.info.available);
        assert_eq!(
            ruff.argv[1..],
            ["format", "--stdin-filename", "/w/a b.py", "-"]
        );
    }

    #[test]
    fn an_unsaved_file_gets_a_name_from_its_language() {
        let ts = by_id("typescript").expect("ts");
        assert_eq!(file_arg(None, ts), "untitled.ts");
        assert_eq!(file_arg(Some(&PathBuf::from("/w/x.ts")), ts), "/w/x.ts");
    }
}
