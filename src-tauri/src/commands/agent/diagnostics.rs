//! `get_diagnostics`: the agent's "check", as Claude Code reads the IDE's problems. The language servers' latest
//! diagnostics per file are kept here as they are published (the same ones the Problems panel shows), and the agent
//! gets those of the files in its folder, errors first. Only files the servers analysed are covered (open in the editor
//! or opened by the language server), which the answer says, pointing at the project's own build or tests for the rest.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, PoisonError};

use openmind_agent::external::ExternalTool;
use openmind_agent::tools::{Outcome, ToolKind};
use openmind_lsp::{Diagnostic, PublishedDiagnostics};
use serde_json::{json, Value};

/// Diagnostics one answer lists at most.
const MAX_LISTED: usize = 200;

pub const TOOL: &str = "get_diagnostics";

/// (language server, file key) -> (the file's path as published, its diagnostics).
type Published = HashMap<(String, String), (String, Vec<Diagnostic>)>;

/// The latest diagnostics of each file, per language server (managed state, fed by the LSP event sink).
#[derive(Default)]
pub struct DiagnosticsCache {
    files: Mutex<Published>,
}

fn key(path: &str) -> String {
    let path = path.replace('\\', "/");
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path
    }
}

impl DiagnosticsCache {
    pub fn put(&self, server: &str, published: &PublishedDiagnostics) {
        let mut files = self.files.lock().unwrap_or_else(PoisonError::into_inner);
        let id = (server.to_string(), key(&published.path));
        if published.diagnostics.is_empty() {
            files.remove(&id);
        } else {
            files.insert(
                id,
                (
                    published.path.replace('\\', "/"),
                    published.diagnostics.clone(),
                ),
            );
        }
    }

    /// `(path relative to root, diagnostic)` for files inside `root`, optionally only `file` (relative or absolute).
    pub fn inside(&self, root: &Path, file: Option<&str>) -> Vec<(String, Diagnostic)> {
        let root_key = key(&root.to_string_lossy());
        let root_key = root_key.trim_end_matches('/').to_string();
        let wanted = file.map(|f| {
            let f = f.trim().replace('\\', "/");
            if Path::new(&f).is_absolute() {
                key(&f)
            } else {
                format!("{root_key}/{}", key(f.trim_start_matches("./")))
            }
        });
        let files = self.files.lock().unwrap_or_else(PoisonError::into_inner);
        let mut out = Vec::new();
        for ((_, path_key), (path, diagnostics)) in files.iter() {
            let Some(rel) = path_key.strip_prefix(&format!("{root_key}/")) else {
                continue;
            };
            if wanted.as_ref().is_some_and(|w| w != path_key) {
                continue;
            }
            let shown = path
                .get(path.len() - rel.len()..)
                .unwrap_or(rel)
                .to_string();
            out.extend(diagnostics.iter().map(|d| (shown.clone(), d.clone())));
        }
        out.sort_by(|a, b| {
            (a.1.severity.unwrap_or(4), &a.0, a.1.range.start.line).cmp(&(
                b.1.severity.unwrap_or(4),
                &b.0,
                b.1.range.start.line,
            ))
        });
        out
    }
}

pub fn spec() -> ExternalTool {
    ExternalTool {
        name: TOOL.into(),
        description: "Check the code: the errors and warnings the language servers report (what the editor's Problems panel shows), errors first. Use it after changing code. Pass path for one file; leave it out for the whole project. Only files the language servers analysed are covered, so also run the project's build, type check or tests.".into(),
        parameters: json!({"type": "object", "properties": {
            "path": {"type": "string", "description": "A file relative to the project folder (optional)"}
        }}),
        kind: ToolKind::Read,
        read_only: true,
    }
}

fn severity(value: Option<u8>) -> &'static str {
    match value {
        Some(1) => "error",
        Some(2) => "warning",
        Some(3) => "info",
        _ => "hint",
    }
}

/// The tool's answer for the folder `root`.
pub fn answer(cache: &DiagnosticsCache, root: Option<&Path>, arguments: &str) -> Outcome {
    let Some(root) = root else {
        return Outcome::failed("No project folder is open.");
    };
    let args: Value = serde_json::from_str(arguments).unwrap_or(Value::Null);
    let file = args
        .get("path")
        .and_then(Value::as_str)
        .filter(|p| !p.trim().is_empty());
    let found = cache.inside(root, file);
    let scope = file.map_or_else(|| "the project".to_string(), str::to_string);
    if found.is_empty() {
        return Outcome {
            ok: true,
            for_model: format!(
                "No errors or warnings reported for {scope}. Language servers only check files they analysed (open in \
                 the editor, with the language's server installed); run the project's build, type check or tests with \
                 run_command to check everything."
            ),
            summary: "No problems reported".into(),
            ..Outcome::default()
        };
    }
    let errors = found.iter().filter(|(_, d)| d.severity == Some(1)).count();
    let warnings = found.iter().filter(|(_, d)| d.severity == Some(2)).count();
    let mut lines: Vec<String> = found
        .iter()
        .take(MAX_LISTED)
        .map(|(path, d)| {
            let source = d
                .source
                .as_deref()
                .map(|s| format!(" [{s}]"))
                .unwrap_or_default();
            format!(
                "{path}:{}:{}: {}{source}: {}",
                d.range.start.line + 1,
                d.range.start.character + 1,
                severity(d.severity),
                d.message.lines().next().unwrap_or("")
            )
        })
        .collect();
    if found.len() > MAX_LISTED {
        lines.push(format!("… and {} more.", found.len() - MAX_LISTED));
    }
    Outcome {
        ok: true,
        for_model: format!(
            "{errors} errors, {warnings} warnings in {scope}:\n{}",
            lines.join("\n")
        ),
        summary: format!("{errors} errors, {warnings} warnings"),
        ..Outcome::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openmind_lsp::protocol::{Position, Range};

    fn diagnostic(line: u32, severity: u8, message: &str) -> Diagnostic {
        Diagnostic {
            range: Range {
                start: Position { line, character: 4 },
                end: Position { line, character: 9 },
            },
            severity: Some(severity),
            code: None,
            source: Some("ts".into()),
            message: message.into(),
            tags: None,
        }
    }

    fn published(path: &str, diagnostics: Vec<Diagnostic>) -> PublishedDiagnostics {
        PublishedDiagnostics {
            path: path.into(),
            version: None,
            diagnostics,
        }
    }

    #[test]
    fn the_folders_problems_come_errors_first_and_a_cleared_file_drops_out() {
        let cache = DiagnosticsCache::default();
        cache.put(
            "ts",
            &published(
                "C:/Work/App/src/a.ts",
                vec![
                    diagnostic(2, 2, "unused x"),
                    diagnostic(9, 1, "Cannot find name 'y'."),
                ],
            ),
        );
        cache.put(
            "ts",
            &published("C:/Work/Other/b.ts", vec![diagnostic(0, 1, "elsewhere")]),
        );
        let root = Path::new("C:/Work/App");
        let out = answer(&cache, Some(root), "{}");
        assert_eq!(out.summary, "1 errors, 1 warnings");
        let lines: Vec<&str> = out.for_model.lines().collect();
        assert_eq!(lines[1], "src/a.ts:10:5: error [ts]: Cannot find name 'y'.");
        assert_eq!(lines[2], "src/a.ts:3:5: warning [ts]: unused x");
        assert!(
            !out.for_model.contains("elsewhere"),
            "another folder's file is not listed"
        );
        assert_eq!(
            answer(&cache, Some(root), r#"{"path":"src/b.ts"}"#).summary,
            "No problems reported"
        );
        assert!(answer(&cache, Some(root), r#"{"path":"src\\a.ts"}"#)
            .summary
            .starts_with("1 errors"));
        cache.put("ts", &published("C:/Work/App/src/a.ts", vec![]));
        assert_eq!(
            answer(&cache, Some(root), "{}").summary,
            "No problems reported"
        );
        assert!(!answer(&cache, None, "{}").ok);
    }
}
