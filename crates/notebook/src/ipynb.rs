//! Jupyter notebooks (`.ipynb`, nbformat 4). Reading gives the cells the editor shows; saving starts from the
//! original document and changes only what the user changed — cell order, types, sources, outputs and execution
//! counts — so notebook, cell and output metadata OpenMind doesn't know about stay exactly as they were (key order
//! included) and the file keeps its indentation.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CellKind {
    Code,
    Markdown,
    Raw,
}

impl CellKind {
    fn name(self) -> &'static str {
        match self {
            CellKind::Code => "code",
            CellKind::Markdown => "markdown",
            CellKind::Raw => "raw",
        }
    }
}

/// A cell as the editor shows it. `outputs` are the notebook's own output objects (rendered safely by the UI).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellModel {
    /// Its position in the file (the key that keeps its metadata when saving).
    pub index: usize,
    pub id: Option<String>,
    pub kind: CellKind,
    pub source: String,
    pub execution_count: Option<i64>,
    pub outputs: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookModel {
    pub nbformat: u64,
    pub nbformat_minor: u64,
    /// The notebook's language (`language_info.name`, else the kernelspec's language), e.g. `python`.
    pub language: String,
    /// The kernel it was written with (`kernelspec.display_name`), for information.
    pub kernel_name: Option<String>,
    pub cells: Vec<CellModel>,
}

/// A cell to save: `origin` is its index in the file it was read from (`None` for a new cell).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellEdit {
    pub origin: Option<usize>,
    pub kind: CellKind,
    pub source: String,
    #[serde(default)]
    pub execution_count: Option<i64>,
    #[serde(default)]
    pub outputs: Option<Vec<Value>>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NotebookError {
    #[error("The notebook is not valid JSON (line {0}, column {1}).")]
    Json(usize, usize),
    #[error("This is not a Jupyter notebook: {0}")]
    NotANotebook(String),
    #[error("nbformat {0} notebooks are not supported (only version 4). Open it as text instead.")]
    OldFormat(u64),
}

/// A string or a list of lines (Jupyter's multi-line text) as one string.
pub fn joined(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(lines)) => lines.iter().filter_map(Value::as_str).collect(),
        _ => String::new(),
    }
}

/// Jupyter's way of storing text: one string per line, each keeping its line break.
fn split_lines(text: &str) -> Value {
    if text.is_empty() {
        return json!([]);
    }
    Value::Array(
        text.split_inclusive('\n')
            .map(|line| Value::String(line.to_string()))
            .collect(),
    )
}

fn kind_of(cell: &Value) -> CellKind {
    match cell.get("cell_type").and_then(Value::as_str) {
        Some("markdown") => CellKind::Markdown,
        Some("raw") => CellKind::Raw,
        _ => CellKind::Code,
    }
}

fn root_of(text: &str) -> Result<Map<String, Value>, NotebookError> {
    let root: Value =
        serde_json::from_str(text).map_err(|err| NotebookError::Json(err.line(), err.column()))?;
    let root = match root {
        Value::Object(map) => map,
        _ => {
            return Err(NotebookError::NotANotebook(
                "it is not a JSON object".into(),
            ))
        }
    };
    let version = root
        .get("nbformat")
        .and_then(Value::as_u64)
        .ok_or_else(|| NotebookError::NotANotebook("it has no nbformat version".into()))?;
    if version < 4 {
        return Err(NotebookError::OldFormat(version));
    }
    if !root.get("cells").is_some_and(Value::is_array) {
        return Err(NotebookError::NotANotebook("it has no cells list".into()));
    }
    Ok(root)
}

/// Reads a notebook.
pub fn load(text: &str) -> Result<NotebookModel, NotebookError> {
    let root = root_of(text)?;
    let metadata = root.get("metadata");
    let language = metadata
        .and_then(|m| m.get("language_info"))
        .and_then(|l| l.get("name"))
        .or_else(|| {
            metadata
                .and_then(|m| m.get("kernelspec"))
                .and_then(|k| k.get("language"))
        })
        .and_then(Value::as_str)
        .unwrap_or("python")
        .to_string();
    let kernel_name = metadata
        .and_then(|m| m.get("kernelspec"))
        .and_then(|k| k.get("display_name"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let cells = root
        .get("cells")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .enumerate()
        .map(|(index, cell)| CellModel {
            index,
            id: cell.get("id").and_then(Value::as_str).map(str::to_string),
            kind: kind_of(cell),
            source: joined(cell.get("source")),
            execution_count: cell.get("execution_count").and_then(Value::as_i64),
            outputs: cell
                .get("outputs")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        })
        .collect();
    Ok(NotebookModel {
        nbformat: root.get("nbformat").and_then(Value::as_u64).unwrap_or(4),
        nbformat_minor: root
            .get("nbformat_minor")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        language,
        kernel_name,
        cells,
    })
}

/// The indentation the file uses (Jupyter writes one space).
fn indent_of(text: &str) -> usize {
    text.lines()
        .nth(1)
        .map(|line| line.len() - line.trim_start_matches(' ').len())
        .filter(|&n| n > 0 && n <= 8)
        .unwrap_or(1)
}

fn new_cell_id(position: usize, source: &str) -> String {
    let digest = Sha256::digest(format!("{position}:{source}").as_bytes());
    digest.iter().take(4).map(|b| format!("{b:02x}")).collect()
}

fn saved_cell(edit: &CellEdit, original: Option<&Value>, position: usize, with_ids: bool) -> Value {
    let mut cell = match original {
        Some(Value::Object(map)) => map.clone(),
        _ => {
            let mut map = Map::new();
            if with_ids {
                map.insert(
                    "id".into(),
                    Value::String(new_cell_id(position, &edit.source)),
                );
            }
            map.insert("metadata".into(), json!({}));
            map
        }
    };
    cell.insert("cell_type".into(), Value::String(edit.kind.name().into()));
    let keeps_string = matches!(cell.get("source"), Some(Value::String(_)));
    let source = if keeps_string {
        Value::String(edit.source.clone())
    } else {
        split_lines(&edit.source)
    };
    cell.insert("source".into(), source);
    if edit.kind == CellKind::Code {
        let outputs = match &edit.outputs {
            Some(outputs) => Value::Array(outputs.clone()),
            None => cell.get("outputs").cloned().unwrap_or_else(|| json!([])),
        };
        cell.insert("outputs".into(), outputs);
        cell.insert(
            "execution_count".into(),
            edit.execution_count.map_or(Value::Null, Value::from),
        );
    } else {
        cell.remove("outputs");
        cell.remove("execution_count");
    }
    Value::Object(cell)
}

/// The notebook `original` with `cells` as its new cells, as text ready to write.
pub fn save(original: &str, cells: &[CellEdit]) -> Result<String, NotebookError> {
    let mut root = root_of(original)?;
    let old: Vec<Value> = root
        .get("cells")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let with_ids = root
        .get("nbformat_minor")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        >= 5;
    let saved: Vec<Value> = cells
        .iter()
        .enumerate()
        .map(|(position, edit)| {
            saved_cell(
                edit,
                edit.origin.and_then(|i| old.get(i)),
                position,
                with_ids,
            )
        })
        .collect();
    root.insert("cells".into(), Value::Array(saved));
    let indent = " ".repeat(indent_of(original));
    let formatter = serde_json::ser::PrettyFormatter::with_indent(indent.as_bytes());
    let mut out = Vec::new();
    let mut serializer = serde_json::Serializer::with_formatter(&mut out, formatter);
    Value::Object(root)
        .serialize(&mut serializer)
        .map_err(|err| NotebookError::NotANotebook(err.to_string()))?;
    let mut text =
        String::from_utf8(out).map_err(|err| NotebookError::NotANotebook(err.to_string()))?;
    if original.ends_with('\n') {
        text.push('\n');
    }
    Ok(text)
}

/// The SHA-256 of a notebook's text (its trust is tied to exactly this content).
pub fn fingerprint(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r##"{
 "cells": [
  {
   "cell_type": "markdown",
   "id": "a1",
   "metadata": {"tags": ["intro"]},
   "source": ["# Title\n", "Some *text*"]
  },
  {
   "cell_type": "code",
   "execution_count": 3,
   "id": "b2",
   "metadata": {"collapsed": false, "custom": {"keep": true}},
   "outputs": [{"output_type": "stream", "name": "stdout", "text": ["hi\n"]}],
   "source": "print('hi')"
  }
 ],
 "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"}, "zzz_unknown": 1, "aaa": 2},
 "nbformat": 4,
 "nbformat_minor": 5
}
"##;

    #[test]
    fn a_notebook_reads_into_cells() {
        let model = load(SAMPLE).unwrap();
        assert_eq!(model.language, "python");
        assert_eq!(model.kernel_name.as_deref(), Some("Python 3"));
        assert_eq!(model.cells.len(), 2);
        assert_eq!(model.cells[0].kind, CellKind::Markdown);
        assert_eq!(model.cells[0].source, "# Title\nSome *text*");
        assert_eq!(model.cells[1].execution_count, Some(3));
        assert_eq!(model.cells[1].outputs.len(), 1);
    }

    #[test]
    fn saving_unchanged_cells_gives_back_the_same_document() {
        let model = load(SAMPLE).unwrap();
        let edits: Vec<CellEdit> = model
            .cells
            .iter()
            .map(|c| CellEdit {
                origin: Some(c.index),
                kind: c.kind,
                source: c.source.clone(),
                execution_count: c.execution_count,
                outputs: None,
            })
            .collect();
        let saved = save(SAMPLE, &edits).unwrap();
        let before: Value = serde_json::from_str(SAMPLE).unwrap();
        let after: Value = serde_json::from_str(&saved).unwrap();
        assert_eq!(before, after);
        assert!(
            saved.starts_with("{\n \"cells\""),
            "keeps the one-space indent"
        );
        let keys: Vec<&String> = after["metadata"].as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            ["kernelspec", "zzz_unknown", "aaa"],
            "key order is kept"
        );
        assert!(saved.ends_with("}\n"));
    }

    #[test]
    fn edits_keep_cell_metadata_and_new_cells_get_ids() {
        let edits = vec![
            CellEdit {
                origin: Some(1),
                kind: CellKind::Code,
                source: "x = 1\nx".into(),
                execution_count: Some(4),
                outputs: Some(vec![
                    json!({"output_type": "execute_result", "data": {"text/plain": "1"}, "metadata": {}, "execution_count": 4}),
                ]),
            },
            CellEdit {
                origin: None,
                kind: CellKind::Code,
                source: "".into(),
                execution_count: None,
                outputs: None,
            },
            CellEdit {
                origin: Some(0),
                kind: CellKind::Code,
                source: "# now code".into(),
                execution_count: None,
                outputs: None,
            },
        ];
        let saved: Value = serde_json::from_str(&save(SAMPLE, &edits).unwrap()).unwrap();
        let cells = saved["cells"].as_array().unwrap();
        assert_eq!(cells[0]["metadata"]["custom"]["keep"], true);
        assert_eq!(
            cells[0]["source"], "x = 1\nx",
            "a string source stays a string"
        );
        assert_eq!(cells[0]["execution_count"], 4);
        assert_eq!(cells[0]["outputs"][0]["output_type"], "execute_result");
        assert_eq!(cells[1]["id"].as_str().map(str::len), Some(8));
        assert_eq!(cells[1]["outputs"], json!([]));
        assert_eq!(cells[2]["cell_type"], "code");
        assert_eq!(cells[2]["metadata"]["tags"][0], "intro");
        assert_eq!(cells[2]["source"], json!(["# now code"]));
        assert_eq!(saved["metadata"]["zzz_unknown"], 1);
        let markdown = save(
            SAMPLE,
            &[CellEdit {
                origin: Some(1),
                kind: CellKind::Markdown,
                source: "text".into(),
                execution_count: Some(1),
                outputs: None,
            }],
        )
        .unwrap();
        let cell = &serde_json::from_str::<Value>(&markdown).unwrap()["cells"][0];
        assert!(cell.get("outputs").is_none() && cell.get("execution_count").is_none());
    }

    #[test]
    fn broken_and_old_notebooks_say_why() {
        assert!(matches!(load("{"), Err(NotebookError::Json(..))));
        assert!(matches!(load("[]"), Err(NotebookError::NotANotebook(_))));
        assert!(matches!(
            load(r#"{"nbformat": 3, "worksheets": []}"#),
            Err(NotebookError::OldFormat(3))
        ));
        assert!(matches!(
            load(r#"{"nbformat": 4}"#),
            Err(NotebookError::NotANotebook(_))
        ));
        assert_eq!(fingerprint("a").len(), 64);
        assert_ne!(fingerprint("a"), fingerprint("b"));
    }
}
