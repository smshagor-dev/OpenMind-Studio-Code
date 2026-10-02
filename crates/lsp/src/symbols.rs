//! `workspace/symbol` answers turned into the symbol hits the Search view and Ctrl+T show: the same shape as the
//! workspace index's own symbols (1-based line, 1-based UTF-16 column, a kind word), restricted to files inside the
//! open folder.

use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use crate::language::language_id;
use crate::uri::uri_to_path;

/// One symbol a language server found in the workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSymbol {
    pub name: String,
    pub kind: &'static str,
    pub line: u32,
    pub column: u32,
    pub container: Option<String>,
    pub path: String,
    pub relative_path: String,
    pub language: Option<String>,
    /// Higher is a better match for the query (an exact name first, then a prefix, then the rest).
    pub score: i32,
}

/// LSP `SymbolKind` numbers to the kind words the index uses (`function`, `module`, ...).
pub fn kind_word(kind: u64) -> &'static str {
    match kind {
        1..=4 => "module",
        5 => "class",
        6 | 9 => "method",
        10 => "enum",
        11 => "interface",
        12 => "function",
        14 | 22 => "constant",
        23 => "struct",
        26 => "type",
        _ => "variable",
    }
}

fn score(name: &str, query: &str) -> i32 {
    let (name, query) = (name.to_lowercase(), query.to_lowercase());
    if name == query {
        300
    } else if name.starts_with(&query) {
        200
    } else {
        100
    }
}

/// Reads a `SymbolInformation[]` or `WorkspaceSymbol[]` answer. Symbols without a file location, or in a file outside
/// `root`, are left out.
pub fn parse_workspace_symbols(answer: &Value, root: &Path, query: &str) -> Vec<WorkspaceSymbol> {
    let Some(items) = answer.as_array() else {
        return Vec::new();
    };
    let root_text = normalize(&root.to_string_lossy());
    items
        .iter()
        .filter_map(|item| {
            let name = item.get("name")?.as_str()?.to_string();
            let location = item.get("location")?;
            let path = uri_to_path(location.get("uri")?.as_str()?)?;
            let relative = normalize(&path)
                .strip_prefix(&format!("{root_text}/"))?
                .to_string();
            let start = location.pointer("/range/start");
            let at = |key: &str| {
                start
                    .and_then(|start| start.get(key))
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value + 1).ok())
                    .unwrap_or(1)
            };
            Some(WorkspaceSymbol {
                score: score(&name, query),
                kind: kind_word(item.get("kind").and_then(Value::as_u64).unwrap_or(13)),
                line: at("line"),
                column: at("character"),
                container: item
                    .get("containerName")
                    .and_then(Value::as_str)
                    .filter(|container| !container.is_empty())
                    .map(str::to_string),
                language: language_id(&path).map(str::to_string),
                relative_path: relative,
                path,
                name,
            })
        })
        .collect()
}

/// Some servers (fortls) report a symbol's range from the start of its line. When `line_text` holds the name as a
/// whole word (any case: Fortran ignores it), the hit points at the name instead, so opening it selects the name.
pub fn point_at_name(hit: &mut WorkspaceSymbol, line_text: &str) {
    let lower_line = line_text.to_lowercase();
    let lower_name = hit.name.to_lowercase();
    if lower_name.is_empty() || lower_line.len() != line_text.len() {
        return;
    }
    let word = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
    let mut from = 0;
    while let Some(found) = lower_line[from..].find(&lower_name) {
        let start = from + found;
        let end = start + lower_name.len();
        if !word(lower_line[..start].chars().last()) && !word(lower_line[end..].chars().next()) {
            let column = line_text[..start].encode_utf16().count() + 1;
            hit.column = u32::try_from(column).unwrap_or(hit.column);
            return;
        }
        from = end;
    }
}

/// Points every hit at its name, reading each file once (files over 2 MB are left as the server said).
pub fn point_hits_at_names(hits: &mut [WorkspaceSymbol]) {
    let mut lines: std::collections::HashMap<String, Option<Vec<String>>> =
        std::collections::HashMap::new();
    for hit in hits.iter_mut() {
        let text = lines.entry(hit.path.clone()).or_insert_with(|| {
            let path = Path::new(&hit.path);
            let small = std::fs::metadata(path).is_ok_and(|meta| meta.len() <= 2 * 1024 * 1024);
            small
                .then(|| std::fs::read(path).ok())
                .flatten()
                .map(|bytes| {
                    String::from_utf8_lossy(&bytes)
                        .lines()
                        .map(str::to_string)
                        .collect()
                })
        });
        let line = text
            .as_ref()
            .and_then(|lines| lines.get(usize::try_from(hit.line).unwrap_or(0).saturating_sub(1)));
        if let Some(line) = line {
            point_at_name(hit, line);
        }
    }
}

/// Forward slashes, no trailing slash, lower case on Windows (where paths ignore case).
fn normalize(path: &str) -> String {
    let path = path.replace('\\', "/").trim_end_matches('/').to_string();
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn symbol_information_becomes_index_shaped_hits_inside_the_folder_only() {
        let root = if cfg!(windows) {
            "C:\\Work\\My App"
        } else {
            "/work/My App"
        };
        let base = if cfg!(windows) {
            "file:///C:/Work/My%20App"
        } else {
            "file:///work/My%20App"
        };
        let answer = json!([
            { "name": "circle_area", "kind": 12, "containerName": "shapes",
              "location": { "uri": format!("{base}/src/shapes.f90"), "range": { "start": { "line": 6, "character": 24 } } } },
            { "name": "shapes", "kind": 2,
              "location": { "uri": format!("{base}/src/shapes.f90"), "range": { "start": { "line": 0, "character": 7 } } } },
            { "name": "elsewhere", "kind": 12,
              "location": { "uri": "file:///C:/Other/x.f90", "range": { "start": { "line": 0, "character": 0 } } } },
            { "name": "no location", "kind": 12 }
        ]);
        let hits = parse_workspace_symbols(&answer, Path::new(root), "circle");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].name, "circle_area");
        assert_eq!(hits[0].kind, "function");
        assert_eq!((hits[0].line, hits[0].column), (7, 25));
        assert_eq!(hits[0].container.as_deref(), Some("shapes"));
        assert_eq!(hits[0].relative_path.to_lowercase(), "src/shapes.f90");
        assert_eq!(hits[0].language.as_deref(), Some("fortran"));
        assert_eq!(hits[0].score, 200);
        assert_eq!(hits[1].kind, "module");
        assert!(parse_workspace_symbols(&json!(null), Path::new(root), "x").is_empty());
    }

    #[test]
    fn a_hit_at_the_start_of_its_line_points_at_the_name() {
        let mut hit = WorkspaceSymbol {
            name: "circle_area".into(),
            kind: "function",
            line: 7,
            column: 1,
            container: None,
            path: String::new(),
            relative_path: String::new(),
            language: None,
            score: 0,
        };
        point_at_name(
            &mut hit,
            "  pure real(8) function CIRCLE_AREA(r) ! circle_area_x",
        );
        assert_eq!(hit.column, 25);
        // A longer word that only contains the name doesn't count; no match keeps the server's column.
        hit.column = 1;
        point_at_name(&mut hit, "  call circle_area_x()");
        assert_eq!(hit.column, 1);
        // Columns are UTF-16, like the editor's.
        point_at_name(&mut hit, "! é\u{1F600} circle_area");
        assert_eq!(hit.column, 7);
    }

    #[test]
    fn symbol_kinds_map_to_the_index_words() {
        assert_eq!(kind_word(2), "module");
        assert_eq!(kind_word(5), "class");
        assert_eq!(kind_word(6), "method");
        assert_eq!(kind_word(12), "function");
        assert_eq!(kind_word(13), "variable");
        assert_eq!(kind_word(14), "constant");
        assert_eq!(kind_word(23), "struct");
        assert_eq!(kind_word(99), "variable");
    }
}
