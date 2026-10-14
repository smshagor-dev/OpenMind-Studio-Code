//! The looking tools. They run while the call is prepared (nothing to approve) and answer with compact text.

use std::fs;

use serde_json::Value;

use super::{arg_str, Outcome, Prepared, ToolContext, ToolKind};
use crate::textfile;

const DEFAULT_LINES: usize = 600;
const MAX_LINES: usize = 2_000;
/// A single very long line (minified code) is cut here.
const MAX_LINE_CHARS: usize = 2_000;
const MAX_ENTRIES: usize = 400;
const MAX_FOUND: usize = 200;
const MAX_MATCHES: usize = 100;
/// Folders the listing marks but never opens.
const HEAVY: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    ".venv",
    "venv",
    "__pycache__",
    "vendor",
];

fn finished(title: &str, target: String, outcome: Outcome) -> Prepared {
    Prepared::finished(ToolKind::Read, title, target, outcome)
}

fn cut_line(line: &str) -> String {
    if line.chars().count() <= MAX_LINE_CHARS {
        line.to_string()
    } else {
        let head: String = line.chars().take(MAX_LINE_CHARS).collect();
        format!("{head}… [line cut]")
    }
}

pub fn read_file(args: &Value, ctx: &ToolContext<'_>) -> Prepared {
    let path_arg = match arg_str(args, "path") {
        Ok(p) => p,
        Err(e) => return finished("Read", String::new(), Outcome::failed(e)),
    };
    let path = match ctx.ws.resolve(path_arg) {
        Ok(p) => p,
        Err(e) => return finished("Read", path_arg.into(), Outcome::failed(e)),
    };
    let rel = ctx.ws.relative(&path);
    let file = match textfile::read(&path) {
        Ok(f) => f,
        Err(e) => return finished("Read", rel, Outcome::failed(e)),
    };
    let lines: Vec<&str> = file.text.lines().collect();
    let offset = args["offset"].as_u64().unwrap_or(1).max(1) as usize;
    let limit =
        (args["limit"].as_u64().unwrap_or(DEFAULT_LINES as u64) as usize).clamp(1, MAX_LINES);
    if lines.is_empty() {
        return finished(
            "Read",
            rel,
            Outcome::done("(the file is empty)".into(), "Empty file".into()),
        );
    }
    if offset > lines.len() {
        return finished(
            "Read",
            rel,
            Outcome::failed(format!("The file has only {} lines.", lines.len())),
        );
    }
    let end = (offset - 1 + limit).min(lines.len());
    let mut out = String::new();
    for (i, line) in lines[offset - 1..end].iter().enumerate() {
        out.push_str(&format!("{:>6}\t{}\n", offset + i, cut_line(line)));
    }
    if end < lines.len() {
        out.push_str(&format!(
            "\n[{} more lines; read again with offset {} to continue]\n",
            lines.len() - end,
            end + 1
        ));
    }
    let summary = format!("Read {} lines", end + 1 - offset);
    finished("Read", rel, Outcome::done(out, summary))
}

pub fn list_dir(args: &Value, ctx: &ToolContext<'_>) -> Prepared {
    let path_arg = args["path"].as_str().unwrap_or("");
    let path = match ctx.ws.resolve(path_arg) {
        Ok(p) => p,
        Err(e) => return finished("List", path_arg.into(), Outcome::failed(e)),
    };
    let rel = ctx.ws.relative(&path);
    let entries = match fs::read_dir(&path) {
        Ok(entries) => entries,
        Err(_) => {
            return finished(
                "List",
                rel,
                Outcome::failed("That is not a folder that can be listed."),
            )
        }
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let dir = entry.file_type().is_ok_and(|t| t.is_dir());
            match (dir, HEAVY.contains(&name.as_str())) {
                (true, true) => format!("{name}/ (not opened: dependencies or build output)"),
                (true, false) => format!("{name}/"),
                _ => name,
            }
        })
        .collect();
    names.sort_by_key(|n| (!n.contains('/'), n.to_lowercase()));
    let total = names.len();
    names.truncate(MAX_ENTRIES);
    let mut out = names.join("\n");
    if total > MAX_ENTRIES {
        out.push_str(&format!("\n[{} more entries]", total - MAX_ENTRIES));
    }
    if out.is_empty() {
        out = "(the folder is empty)".into();
    }
    finished("List", rel, Outcome::done(out, format!("{total} entries")))
}

pub fn find_files(args: &Value, ctx: &ToolContext<'_>) -> Prepared {
    let pattern = match arg_str(args, "pattern") {
        Ok(p) => p.trim(),
        Err(e) => return finished("Find", String::new(), Outcome::failed(e)),
    };
    match openmind_search::find::find_files(
        ctx.ws.root(),
        pattern,
        None,
        Some(MAX_FOUND + 1),
        ctx.cancel,
    ) {
        Ok(found) => {
            let more = found.len() > MAX_FOUND;
            let mut lines: Vec<String> = found
                .iter()
                .take(MAX_FOUND)
                .map(|p| ctx.ws.relative(p))
                .collect();
            if more {
                lines.push(format!(
                    "[more than {MAX_FOUND} files; use a narrower pattern]"
                ));
            }
            let count = found.len().min(MAX_FOUND);
            let text = if lines.is_empty() {
                "No files match.".into()
            } else {
                lines.join("\n")
            };
            finished(
                "Find",
                pattern.into(),
                Outcome::done(text, format!("Found {count} files")),
            )
        }
        Err(err) => finished("Find", pattern.into(), Outcome::failed(err.to_string())),
    }
}

pub fn search(args: &Value, ctx: &ToolContext<'_>) -> Prepared {
    let query = match arg_str(args, "query") {
        Ok(q) => q,
        Err(e) => return finished("Search", String::new(), Outcome::failed(e)),
    };
    let include: Vec<String> = args["include"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(|s| vec![s.trim().to_string()])
        .unwrap_or_default();
    let request = openmind_search::query::SearchQuery {
        root: ctx.ws.root().to_path_buf(),
        text: query.to_string(),
        case_sensitive: false,
        whole_word: false,
        use_regex: args["regex"].as_bool().unwrap_or(false),
        include,
        exclude: Vec::new(),
        max_results: MAX_MATCHES,
    };
    match openmind_search::walk::search(&request, ctx.cancel) {
        Ok(outcome) => {
            let mut lines = Vec::new();
            for file in &outcome.files {
                for m in &file.matches {
                    lines.push(format!(
                        "{}:{}: {}",
                        file.relative_path,
                        m.line,
                        cut_line(m.preview.trim())
                    ));
                }
            }
            if outcome.truncated {
                lines.push(format!(
                    "[stopped at {MAX_MATCHES} matches; search for something more specific]"
                ));
            }
            let text = if lines.is_empty() {
                "No matches.".into()
            } else {
                lines.join("\n")
            };
            let summary = format!(
                "{} matches in {} files",
                outcome.total_matches,
                outcome.files.len()
            );
            finished("Search", query.into(), Outcome::done(text, summary))
        }
        Err(err) => finished("Search", query.into(), Outcome::failed(err.to_string())),
    }
}
