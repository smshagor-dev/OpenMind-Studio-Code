//! Problem matchers: turning a task's output into Problems. A small, safe subset — the built-in `$tsc`, `$gcc`,
//! `$msCompile`, `$eslint-compact` and `$rustc` matchers, and custom matchers with one pattern (or two lines: the
//! message line, then the location line). Anything else is reported as unsupported with its name, never ignored.

use regex::{Regex, RegexBuilder};
use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

/// A problem found in a task's output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub file: String,
    pub line: u32,
    pub column: u32,
    pub severity: Severity,
    pub message: String,
    pub code: Option<String>,
    /// The matcher's owner (`typescript`, `cpp`, `rustc` ...).
    pub source: String,
}

/// How a matcher entry of a task is handled.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatcherInfo {
    pub name: String,
    pub supported: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Location {
    Absolute,
    Relative,
    AutoDetect,
}

#[derive(Debug, Clone, Default)]
struct Groups {
    file: Option<usize>,
    line: Option<usize>,
    column: Option<usize>,
    severity: Option<usize>,
    code: Option<usize>,
    message: Option<usize>,
}

#[derive(Debug, Clone)]
struct Pattern {
    regex: Regex,
    groups: Groups,
}

/// A resolved matcher.
#[derive(Debug, Clone)]
pub struct Matcher {
    name: String,
    owner: String,
    default_severity: Severity,
    location: Location,
    /// One pattern, or two: the message line then the location line.
    patterns: Vec<Pattern>,
}

const MAX_PROBLEMS: usize = 1000;
const MAX_LINE: usize = 4000;

fn pattern(regex: &str, groups: Groups) -> Result<Pattern, String> {
    let regex = RegexBuilder::new(regex)
        .size_limit(1 << 20)
        .build()
        .map_err(|err| format!("its pattern can't be used ({err})"))?;
    Ok(Pattern { regex, groups })
}

fn built_in(name: &str) -> Option<Result<Matcher, String>> {
    let g = |file, line, column, severity, code, message| Groups {
        file: Some(file),
        line: Some(line),
        column,
        severity,
        code,
        message: Some(message),
    };
    let one = |owner: &str, location, regex: &str, groups| -> Result<Matcher, String> {
        Ok(Matcher {
            name: name.to_string(),
            owner: owner.to_string(),
            default_severity: Severity::Error,
            location,
            patterns: vec![pattern(regex, groups)?],
        })
    };
    let matcher = match name {
        "$tsc" => one(
            "typescript",
            Location::Relative,
            r"^([^\s].*)[\(:](\d+)[,:](\d+)(?:\):\s+|\s+-\s+)(error|warning|info)\s+(TS\d+)\s*:\s*(.*)$",
            g(1, 2, Some(3), Some(4), Some(5), 6),
        ),
        "$gcc" => one(
            "cpp",
            Location::AutoDetect,
            r"^(.*?):(\d+):(\d*):?\s+(?:fatal\s+)?(warning|error):\s+(.*)$",
            g(1, 2, Some(3), Some(4), None, 5),
        ),
        "$msCompile" => one(
            "msCompile",
            Location::Absolute,
            r"^(?:\s*\d+>)?(\S.*?)\((\d+)(?:,(\d+))?(?:,\d+,\d+)?\)\s*:\s+(?:fatal\s+)?(error|warning|info)\s+(\w+\d+)\s*:\s*(.*)$",
            g(1, 2, Some(3), Some(4), Some(5), 6),
        ),
        "$eslint-compact" => one(
            "eslint",
            Location::Relative,
            r"^(.+):\sline\s(\d+),\scol\s(\d+),\s(Error|Warning|Info)\s-\s(.+)\s\((.+)\)$",
            g(1, 2, Some(3), Some(4), Some(6), 5),
        ),
        "$rustc" => (|| {
            Ok(Matcher {
                name: name.to_string(),
                owner: "rustc".into(),
                default_severity: Severity::Error,
                location: Location::Relative,
                patterns: vec![
                    pattern(
                        r"^(warning|error)(?:\[(\w+)\])?:\s+(.*)$",
                        Groups {
                            severity: Some(1),
                            code: Some(2),
                            message: Some(3),
                            ..Groups::default()
                        },
                    )?,
                    pattern(
                        r"^\s*-->\s+(.*?):(\d+):(\d+)\s*$",
                        Groups {
                            file: Some(1),
                            line: Some(2),
                            column: Some(3),
                            ..Groups::default()
                        },
                    )?,
                ],
            })
        })(),
        _ => return None,
    };
    Some(matcher)
}

fn group_index(map: &Map<String, Value>, key: &str) -> Option<usize> {
    map.get(key)
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
}

fn custom_pattern(value: &Value) -> Result<Pattern, String> {
    let map = value.as_object().ok_or("its pattern must be an object")?;
    if map.contains_key("loop") {
        return Err("patterns with \"loop\" are not supported".into());
    }
    let regex = map
        .get("regexp")
        .and_then(Value::as_str)
        .ok_or("its pattern has no regexp")?;
    let groups = Groups {
        file: group_index(map, "file"),
        line: group_index(map, "line"),
        column: group_index(map, "column"),
        severity: group_index(map, "severity"),
        code: group_index(map, "code"),
        message: group_index(map, "message"),
    };
    pattern(regex, groups)
}

fn custom(map: &Map<String, Value>) -> Result<Matcher, String> {
    for unsupported in ["background", "base", "watching"] {
        if map.contains_key(unsupported) {
            return Err(format!("\"{unsupported}\" is not supported"));
        }
    }
    let patterns = match map.get("pattern") {
        Some(Value::Array(items)) if (1..=2).contains(&items.len()) => items
            .iter()
            .map(custom_pattern)
            .collect::<Result<Vec<_>, _>>()?,
        Some(Value::Array(_)) => return Err("only one- or two-line patterns are supported".into()),
        Some(Value::String(name)) => {
            return Err(format!("the named pattern {name} is not supported"))
        }
        Some(other) => vec![custom_pattern(other)?],
        None => return Err("it has no pattern".into()),
    };
    let location = match map.get("fileLocation") {
        Some(Value::String(s)) if s == "absolute" => Location::Absolute,
        Some(Value::String(s)) if s == "autoDetect" => Location::AutoDetect,
        Some(Value::Array(parts)) if parts.first().and_then(Value::as_str) == Some("absolute") => {
            Location::Absolute
        }
        _ => Location::Relative,
    };
    let owner = map
        .get("owner")
        .and_then(Value::as_str)
        .unwrap_or("task")
        .to_string();
    Ok(Matcher {
        name: owner.clone(),
        owner: map
            .get("source")
            .and_then(Value::as_str)
            .map_or(owner, str::to_string),
        default_severity: match map.get("severity").and_then(Value::as_str) {
            Some("warning") => Severity::Warning,
            Some("info") => Severity::Info,
            _ => Severity::Error,
        },
        location,
        patterns,
    })
}

/// Resolves one `problemMatcher` entry.
pub fn resolve(entry: &Value) -> Result<Matcher, (String, String)> {
    match entry {
        Value::String(name) => built_in(name)
            .unwrap_or_else(|| Err("OpenMind Studio doesn't know this problem matcher yet".into()))
            .map_err(|reason| (name.clone(), reason)),
        Value::Object(map) => {
            let name = map
                .get("owner")
                .and_then(Value::as_str)
                .unwrap_or("custom matcher")
                .to_string();
            custom(map).map_err(|reason| (name, reason))
        }
        _ => Err((
            "?".into(),
            "a problem matcher must be a name or an object".into(),
        )),
    }
}

/// How each entry of a task's `problemMatcher` is handled (shown before the task runs).
pub fn describe(entries: &[Value]) -> Vec<MatcherInfo> {
    entries
        .iter()
        .map(|entry| match resolve(entry) {
            Ok(matcher) => MatcherInfo {
                name: matcher.name,
                supported: true,
                reason: None,
            },
            Err((name, reason)) => MatcherInfo {
                reason: Some(format!(
                    "Problem matcher {name} is not supported: {reason}."
                )),
                name,
                supported: false,
            },
        })
        .collect()
}

/// Removes terminal colour/cursor sequences.
pub fn strip_ansi(text: &str) -> String {
    static ANSI: std::sync::OnceLock<Option<(Regex, Regex)>> = std::sync::OnceLock::new();
    let patterns = ANSI.get_or_init(|| {
        // A terminal (ConPTY) moves the cursor to the next line instead of printing a line break: those moves
        // (cursor position `H`/`f`, next line `E`) become line breaks; every other sequence is removed.
        let moves = Regex::new(r"\x1b\[[0-9]*(?:;[0-9]*)?[HfE]").ok()?;
        let others = Regex::new(
            r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]",
        )
        .ok()?;
        Some((moves, others))
    });
    match patterns {
        Some((moves, others)) => {
            let lines = moves.replace_all(text, "\n");
            others.replace_all(&lines, "").into_owned()
        }
        None => text.to_string(),
    }
}

fn severity_of(text: Option<&str>, default: Severity) -> Severity {
    match text.map(str::to_ascii_lowercase).as_deref() {
        Some(s) if s.contains("warn") => Severity::Warning,
        Some(s) if s.contains("info") || s.contains("note") || s.contains("hint") => Severity::Info,
        Some(s) if s.contains("err") || s.contains("fatal") => Severity::Error,
        _ => default,
    }
}

fn place(file: &str, location: Location, base: &str) -> String {
    let file = file.trim();
    let absolute = std::path::Path::new(file).is_absolute() || file.starts_with(['/', '\\']);
    match location {
        Location::Absolute => file.to_string(),
        Location::AutoDetect if absolute => file.to_string(),
        _ if absolute => file.to_string(),
        _ => openmind_core::vars::absolute(file, base),
    }
}

impl Matcher {
    fn read(
        &self,
        first: &regex::Captures,
        second: Option<&regex::Captures>,
        base: &str,
    ) -> Option<Diagnostic> {
        // With two patterns the first line has the message, the second the location.
        let (location_caps, location) = match second {
            Some(caps) => (caps, &self.patterns[1].groups),
            None => (first, &self.patterns[0].groups),
        };
        let at = |index: Option<usize>| location_caps.get(index?).map(|m| m.as_str().to_string());
        let head = &self.patterns[0].groups;
        let text = |index: Option<usize>| first.get(index?).map(|m| m.as_str());
        let file = at(location.file)?;
        let line: u32 = at(location.line).and_then(|l| l.parse().ok()).unwrap_or(1);
        let column: u32 = at(location.column)
            .and_then(|c| c.parse().ok())
            .unwrap_or(1);
        Some(Diagnostic {
            file: place(&file, self.location, base),
            line: line.max(1),
            column: column.max(1),
            severity: severity_of(text(head.severity), self.default_severity),
            message: text(head.message)?.trim().to_string(),
            code: text(head.code)
                .filter(|c| !c.is_empty())
                .map(str::to_string),
            source: self.owner.clone(),
        })
    }

    /// The problems in `output`; relative file names are resolved against `base` (the task's folder).
    pub fn problems(&self, output: &str, base: &str) -> Vec<Diagnostic> {
        let text = strip_ansi(output);
        let lines: Vec<&str> = text.lines().map(|l| l.trim_end_matches('\r')).collect();
        let mut found = Vec::new();
        let mut index = 0;
        while index < lines.len() && found.len() < MAX_PROBLEMS {
            let line = lines[index];
            index += 1;
            // OpenMind's own "Executing task" line repeats the command, which may look like a problem.
            if line.len() > MAX_LINE || line.trim_start().starts_with(crate::plan::ECHO_PREFIX) {
                continue;
            }
            let Some(first) = self.patterns[0].regex.captures(line) else {
                continue;
            };
            if self.patterns.len() == 1 {
                found.extend(self.read(&first, None, base));
                continue;
            }
            // The location line follows within the next few lines (rustc prints it right after).
            let next = lines
                .iter()
                .skip(index)
                .take(3)
                .find_map(|l| self.patterns[1].regex.captures(l));
            if let Some(second) = next {
                found.extend(self.read(&first, Some(&second), base));
            }
        }
        found
    }
}

/// Problems from every supported matcher of a task.
pub fn problems(entries: &[Value], output: &str, base: &str) -> Vec<Diagnostic> {
    entries
        .iter()
        .filter_map(|entry| resolve(entry).ok())
        .flat_map(|matcher| matcher.problems(output, base))
        .take(MAX_PROBLEMS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn typescript_output_becomes_problems_with_files_made_absolute() {
        let out = "\x1b[96msrc/app.ts\x1b[0m(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n\
                   src/b.ts:10:2 - warning TS6133: 'x' is declared but never used.\nFound 2 errors.";
        let found = problems(&[json!("$tsc")], out, "C:/My Work");
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].file, "C:/My Work/src/app.ts");
        assert_eq!((found[0].line, found[0].column), (3, 7));
        assert_eq!(found[0].severity, Severity::Error);
        assert_eq!(found[0].code.as_deref(), Some("TS2322"));
        assert_eq!(found[1].severity, Severity::Warning);
        assert_eq!(found[1].source, "typescript");
    }

    #[test]
    fn terminal_cursor_moves_separate_lines() {
        let out = "\x1b[2J\x1b[H * Executing task: echo 'src/err.ts@9: fake'\x1b[3;1Hsrc/err.ts@1: bad\x1b[K\r\n";
        let custom = json!({"owner": "demo", "pattern": {"regexp": "^(.*)@(\\d+): (.*)$", "file": 1, "line": 2, "message": 3}});
        let found = problems(std::slice::from_ref(&custom), out, "C:/w");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].file, "C:/w/src/err.ts");
        assert_eq!(found[0].message, "bad");
    }

    #[test]
    fn gcc_msbuild_eslint_and_rustc_styles() {
        let gcc = problems(
            &[json!("$gcc")],
            "C:/w/main.c:4:9: error: expected ';'\nmain.c:7:1: warning: unused",
            "C:/w",
        );
        assert_eq!(gcc.len(), 2);
        assert_eq!(gcc[0].file, "C:/w/main.c");
        assert_eq!(gcc[1].file, "C:/w/main.c");
        let ms = problems(
            &[json!("$msCompile")],
            r"  1>C:\w\a.cs(12,5): error CS1002: ; expected",
            "C:/w",
        );
        assert_eq!(
            (ms[0].file.as_str(), ms[0].line, ms[0].column),
            (r"C:\w\a.cs", 12, 5)
        );
        let eslint = problems(
            &[json!("$eslint-compact")],
            "src/a.js: line 2, col 3, Warning - Unexpected var (no-var)",
            "C:/w",
        );
        assert_eq!(eslint[0].code.as_deref(), Some("no-var"));
        assert_eq!(eslint[0].severity, Severity::Warning);
        let rust = problems(
            &[json!("$rustc")],
            "error[E0308]: mismatched types\n --> src/main.rs:2:18\n  |\nwarning: unused variable: `x`\n --> src/lib.rs:5:9\n",
            "C:/w",
        );
        assert_eq!(rust.len(), 2);
        assert_eq!(rust[0].file, "C:/w/src/main.rs");
        assert_eq!((rust[0].line, rust[0].column), (2, 18));
        assert_eq!(rust[0].code.as_deref(), Some("E0308"));
        assert_eq!(rust[0].message, "mismatched types");
        assert_eq!(rust[1].severity, Severity::Warning);
    }

    #[test]
    fn a_custom_regex_matcher_works_and_unsupported_ones_say_so() {
        let custom = json!({"owner": "lint", "fileLocation": ["relative", "${workspaceFolder}"],
            "pattern": {"regexp": "^(.*)@(\\d+): (.*)$", "file": 1, "line": 2, "message": 3}});
        let found = problems(std::slice::from_ref(&custom), "x.py@4: bad thing", "C:/w");
        assert_eq!(found[0].file, "C:/w/x.py");
        assert_eq!(found[0].source, "lint");
        let info = describe(&[
            json!("$tsc"),
            json!("$tsc-watch"),
            json!({"owner": "b", "background": {}, "pattern": {}}),
            custom,
        ]);
        assert!(info[0].supported);
        assert!(!info[1].supported);
        assert!(info[1]
            .reason
            .as_deref()
            .is_some_and(|r| r.contains("$tsc-watch")));
        assert!(info[2]
            .reason
            .as_deref()
            .is_some_and(|r| r.contains("background")));
        assert!(info[3].supported);
        let bad = describe(&[
            json!({"owner": "x", "pattern": {"regexp": "(?<=a)b", "file": 1, "line": 1, "message": 1}}),
        ]);
        assert!(!bad[0].supported);
    }
}
