//! Formatting (Milestone 15.2): which formatters apply to a file and running one on the editor's text. The text
//! travels to the formatter and back as a string — nothing is written to disk here; the editor applies the answer as
//! one undoable edit. Tools are found (never installed) by `openmind-language` and run by `openmind-format` with a time
//! limit, in the nearest project folder, with portable-runtime folders in front of PATH for that child only.

use std::path::{Path, PathBuf};
use std::time::Duration;

use openmind_format::json::format_json;
use openmind_format::project::nearest_project_root;
use openmind_format::resolve::{
    candidates, choose, file_arg, FormatterInfo, FormatterSource, Mode, Policy, Resolved,
    BUILTIN_JSON,
};
use openmind_format::run::{run_stdin, Job};
use openmind_format::MAX_FORMAT_BYTES;
use openmind_language::{language_for, LanguageDef, LANGUAGES};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::app_state::AppState;

/// The registry language of a file: by its name when it has a path, else by the editor's language id.
fn language_of(path: Option<&str>, editor_language: &str) -> Option<&'static LanguageDef> {
    path.and_then(language_for).or_else(|| {
        LANGUAGES
            .iter()
            .find(|l| l.id == editor_language)
            .or_else(|| LANGUAGES.iter().find(|l| l.monaco == editor_language))
    })
}

fn checked_path(path: Option<&str>) -> Result<Option<PathBuf>, String> {
    match path {
        None => Ok(None),
        Some(p) if p.contains('\0') => Err("The file path is not valid.".into()),
        Some(p) if !Path::new(p).is_absolute() => Err("The file path must be absolute.".into()),
        Some(p) => Ok(Some(PathBuf::from(p))),
    }
}

/// Everything found out about one file's formatters.
struct Prepared {
    language: &'static LanguageDef,
    list: Vec<Resolved>,
    cwd: PathBuf,
    /// Bundled then portable-runtime folders: in front of PATH for the formatter's process only.
    path_prepend: Vec<PathBuf>,
}

async fn prepare(
    state: &AppState,
    window: &tauri::Window,
    path: Option<&str>,
    editor_language: &str,
    policy: &Policy,
) -> Result<Option<Prepared>, String> {
    let file = checked_path(path)?;
    let Some(language) = language_of(path, editor_language) else {
        return Ok(None);
    };
    let workspace = crate::windows::window_workspace(state, window.label())
        .await?
        .map(|w| PathBuf::from(w.path));
    let cwd = match &file {
        Some(file) => nearest_project_root(file, workspace.as_deref()),
        None => workspace.clone().unwrap_or_else(|| state.app_root.clone()),
    };
    super::language::unpack_offline_formatters(state).await;
    let env = super::language::tool_env(state).await.for_project(&cwd);
    let path_prepend: Vec<PathBuf> = env
        .bundled_dirs
        .iter()
        .chain(env.portable_dirs.iter())
        .cloned()
        .collect();
    let name = file_arg(file.as_deref(), language);
    let list = candidates(language, &name, &env, policy);
    Ok(Some(Prepared {
        language,
        list,
        cwd,
        path_prepend,
    }))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatOptionsAnswer {
    pub language_id: Option<String>,
    pub language_name: Option<String>,
    pub formatters: Vec<FormatterInfo>,
    /// The formatter that would be used now.
    pub selected: Option<String>,
    /// Why there is none.
    pub reason: Option<String>,
}

/// The formatters of a file, best first, and the one that would run.
#[tauri::command]
pub async fn format_options(
    path: Option<String>,
    language: String,
    preferred: Option<String>,
    policy: Policy,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<FormatOptionsAnswer, String> {
    let Some(prepared) = prepare(&state, &window, path.as_deref(), &language, &policy).await?
    else {
        return Ok(FormatOptionsAnswer {
            language_id: None,
            language_name: None,
            formatters: Vec::new(),
            selected: None,
            reason: Some("No formatter configured for this file type.".into()),
        });
    };
    let (selected, reason) =
        match choose(prepared.language.name, &prepared.list, preferred.as_deref()) {
            Ok(chosen) => (Some(chosen.info.id.clone()), None),
            Err(reason) => (None, Some(reason)),
        };
    Ok(FormatOptionsAnswer {
        language_id: Some(prepared.language.id.to_string()),
        language_name: Some(prepared.language.name.to_string()),
        formatters: prepared.list.into_iter().map(|r| r.info).collect(),
        selected,
        reason,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatRequest {
    pub path: Option<String>,
    pub language: String,
    pub text: String,
    /// A formatter id (Format Document With...); else the preferred one or the best available.
    pub tool_id: Option<String>,
    pub preferred: Option<String>,
    /// One indentation level (`"  "`, `"    "`, `"\t"`).
    pub indent: String,
    pub eol: String,
    pub timeout_ms: u64,
    pub policy: Policy,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatAnswer {
    pub text: String,
    pub formatter_id: String,
    pub formatter_name: String,
    pub source: Option<FormatterSource>,
}

fn pick<'a>(prepared: &'a Prepared, request: &FormatRequest) -> Result<&'a Resolved, String> {
    if let Some(id) = &request.tool_id {
        let chosen = prepared
            .list
            .iter()
            .find(|r| &r.info.id == id)
            .ok_or_else(|| format!("{id} is not a formatter for {}.", prepared.language.name))?;
        return if chosen.info.available {
            Ok(chosen)
        } else {
            Err(format!(
                "{} can't be used. {}",
                chosen.info.name,
                chosen.info.reason.clone().unwrap_or_default()
            ))
        };
    }
    choose(
        prepared.language.name,
        &prepared.list,
        request.preferred.as_deref(),
    )
}

/// Formats `request.text` with `chosen`. Pure of Tauri: this is what the tests call.
fn format_with(
    prepared: &Prepared,
    chosen: &Resolved,
    request: &FormatRequest,
) -> Result<String, String> {
    match chosen.info.mode {
        Mode::BuiltIn if chosen.info.id == BUILTIN_JSON => {
            format_json(&request.text, &request.indent, &request.eol)
                .map_err(|err| format!("The document is not valid JSON: {err}"))
        }
        Mode::Stdin => {
            let timeout = Duration::from_millis(request.timeout_ms.clamp(1000, 120_000));
            let text = request.text.replace("\r\n", "\n");
            let out = run_stdin(&Job {
                argv: &chosen.argv,
                cwd: &prepared.cwd,
                input: &text,
                timeout,
                path_prepend: &prepared.path_prepend,
            })
            .map_err(|err| err.to_string())?;
            Ok(if request.eol == "\n" {
                out.replace("\r\n", "\n")
            } else {
                out.replace("\r\n", "\n").replace('\n', &request.eol)
            })
        }
        _ => Err(format!(
            "{} can't format the editor's text.",
            chosen.info.name
        )),
    }
}

/// Formats the text of one document. The answer replaces the editor's text; a failure leaves it untouched.
#[tauri::command]
pub async fn format_run(
    request: FormatRequest,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<FormatAnswer, String> {
    if request.text.len() > MAX_FORMAT_BYTES {
        return Err(format!(
            "This file is too large to format ({:.1} MB; the limit is {:.0} MB).",
            request.text.len() as f64 / 1_000_000.0,
            MAX_FORMAT_BYTES as f64 / 1_000_000.0
        ));
    }
    let prepared = prepare(
        &state,
        &window,
        request.path.as_deref(),
        &request.language,
        &request.policy,
    )
    .await?
    .ok_or_else(|| "No formatter configured for this file type.".to_string())?;
    let chosen = pick(&prepared, &request)?.clone();
    tracing::info!(formatter = %chosen.info.id, language = prepared.language.id, "format document");
    let answer_info = chosen.info.clone();
    let text = tokio::task::spawn_blocking(move || format_with(&prepared, &chosen, &request))
        .await
        .map_err(|err| format!("The formatter stopped unexpectedly: {err}"))??;
    Ok(FormatAnswer {
        text,
        formatter_id: answer_info.id,
        formatter_name: answer_info.name,
        source: answer_info.source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(text: &str) -> FormatRequest {
        FormatRequest {
            path: None,
            language: "json".into(),
            text: text.into(),
            tool_id: None,
            preferred: None,
            indent: "  ".into(),
            eol: "\n".into(),
            timeout_ms: 5000,
            policy: Policy {
                project: true,
                bundled: true,
                system: false,
            },
        }
    }

    fn prepared_for(language: &str) -> Prepared {
        let lang = language_of(None, language).expect("language");
        let env = openmind_language::ToolEnv {
            os: openmind_language::Os::current(),
            project_dirs: vec![],
            bundled_dirs: vec![],
            portable_dirs: vec![],
            system_dirs: vec![],
            launchers: Default::default(),
            pathext: vec![],
            vars: Default::default(),
        };
        let req = request("");
        Prepared {
            language: lang,
            list: candidates(lang, "untitled.x", &env, &req.policy),
            cwd: std::env::temp_dir(),
            path_prepend: vec![],
        }
    }

    #[test]
    fn the_package_json_regression_formats_without_any_tool_or_server() {
        let prepared = prepared_for("json");
        let req = request(
            r#"{"name":"r","scripts":{"dev":"vite","build":"vite build"},"dependencies":{"react":"19.0.0"}}"#,
        );
        let chosen = pick(&prepared, &req).expect("built-in");
        assert_eq!(chosen.info.id, BUILTIN_JSON);
        let out = format_with(&prepared, chosen, &req).expect("formats");
        assert_eq!(
            out,
            "{\n  \"name\": \"r\",\n  \"scripts\": {\n    \"dev\": \"vite\",\n    \"build\": \"vite build\"\n  },\n  \"dependencies\": {\n    \"react\": \"19.0.0\"\n  }\n}"
        );
    }

    #[test]
    fn invalid_json_is_refused_with_a_position_and_the_text_is_not_returned() {
        let prepared = prepared_for("json");
        let req = request("{\"a\": 1,, }");
        let chosen = pick(&prepared, &req).expect("built-in");
        let err = format_with(&prepared, chosen, &req).expect_err("invalid");
        assert!(err.starts_with("The document is not valid JSON:"), "{err}");
        assert!(err.contains("line 1"), "{err}");
    }

    #[test]
    fn a_language_without_a_formatter_gets_a_clear_message_and_no_fake_success() {
        let prepared = prepared_for("typescript");
        let err = pick(&prepared, &request("const a=1")).expect_err("no tool on this env");
        assert!(
            err.starts_with("No formatter available for TypeScript."),
            "{err}"
        );
        assert!(prepared_for("plaintext").list.is_empty());
    }

    #[test]
    fn an_unknown_or_unavailable_formatter_id_is_refused() {
        let prepared = prepared_for("typescript");
        let mut req = request("x");
        req.tool_id = Some("prettier".into());
        assert!(pick(&prepared, &req)
            .expect_err("missing")
            .contains("can't be used"));
        req.tool_id = Some("black".into());
        assert!(pick(&prepared, &req)
            .expect_err("wrong language")
            .contains("not a formatter for TypeScript"));
    }

    #[test]
    fn paths_must_be_absolute_and_free_of_nul() {
        assert!(checked_path(Some("rel/a.ts")).is_err());
        assert!(checked_path(Some("C:\\a\0b.ts")).is_err());
        assert!(checked_path(None).expect("none").is_none());
    }

    #[test]
    fn a_file_is_matched_to_its_language_by_name_first_then_by_the_editor_language() {
        assert_eq!(
            language_of(Some("C:/w/a.py"), "plaintext").map(|l| l.id),
            Some("python")
        );
        assert_eq!(
            language_of(None, "typescript").map(|l| l.id),
            Some("typescript")
        );
        assert!(language_of(None, "no-such-language").is_none());
    }
}
