//! `notebook_edit`: change a Jupyter notebook cell by cell, as Claude Code's NotebookEdit does — replace a cell's source,
//! insert a cell, or delete one. The notebook stays a notebook: only nbformat 4 files are changed, the source is stored in
//! Jupyter's list-of-lines form, a code cell whose source changes loses its old outputs (they no longer match it), new
//! cells get an id when the format wants one, and the file's own key order and indentation are kept. The change goes
//! through the ordinary write path, so it is shown as a diff, asked about, re-checked and undoable.

use serde_json::{json, Map, Value};

use super::change::{planned_write, refused, UNSAVED};
use super::{arg_str, Prepared, ToolContext};
use crate::textfile;

pub fn notebook_edit(args: &Value, ctx: &ToolContext<'_>) -> Prepared {
    let Ok(path_arg) = arg_str(args, "path") else {
        return refused(
            "Update",
            String::new(),
            "notebook_edit needs the notebook's path.",
        );
    };
    let path = match ctx.ws.resolve_for_change(path_arg) {
        Ok(p) => p,
        Err(e) => return refused("Update", path_arg.into(), e),
    };
    let rel = ctx.ws.relative(&path);
    if !rel.to_ascii_lowercase().ends_with(".ipynb") || !path.is_file() {
        return refused(
            "Update",
            rel,
            "notebook_edit changes an existing .ipynb notebook.",
        );
    }
    if ctx.is_unsaved(&path) {
        return refused("Update", rel, UNSAVED);
    }
    let file = match textfile::read(&path) {
        Ok(f) => f,
        Err(e) => return refused("Update", rel, e),
    };
    match edited(&file.text, args) {
        Ok(text) => planned_write(path, rel, Some(file), text, "Update"),
        Err(message) => refused("Update", rel, message),
    }
}

/// The notebook text after the edit `args` asks for (`mode`: replace | insert | delete).
pub(crate) fn edited(text: &str, args: &Value) -> Result<String, String> {
    let mut notebook: Value =
        serde_json::from_str(text).map_err(|e| format!("The notebook is not valid JSON: {e}"))?;
    if notebook["nbformat"].as_u64() != Some(4) {
        return Err("Only nbformat 4 notebooks can be edited.".into());
    }
    let minor = notebook["nbformat_minor"].as_u64().unwrap_or(0);
    let cells = notebook["cells"]
        .as_array_mut()
        .ok_or("The notebook has no cell list.")?;
    let mode = args["mode"].as_str().unwrap_or("replace");
    let index = args["cell"]
        .as_u64()
        .map(|i| i as usize)
        .ok_or("cell (the cell's number, counting from 0) is required.")?;
    let source = args["new_source"].as_str();
    let cell_type = args["cell_type"].as_str();
    if let Some(kind) = cell_type {
        if !matches!(kind, "code" | "markdown" | "raw") {
            return Err("cell_type is code, markdown or raw.".into());
        }
    }
    match mode {
        "delete" => {
            if index >= cells.len() {
                return Err(format!(
                    "There is no cell {index}; the notebook has {} cells.",
                    cells.len()
                ));
            }
            cells.remove(index);
        }
        "insert" => {
            if index > cells.len() {
                return Err(format!("A cell can be inserted at 0..={}.", cells.len()));
            }
            let source = source.ok_or("new_source is required to insert a cell.")?;
            let kind = cell_type.unwrap_or("code");
            let mut cell = Map::new();
            cell.insert("cell_type".into(), json!(kind));
            if minor >= 5 {
                cell.insert("id".into(), json!(cell_id(text, index, cells.len())));
            }
            cell.insert("metadata".into(), json!({}));
            cell.insert("source".into(), lines(source));
            if kind == "code" {
                cell.insert("execution_count".into(), Value::Null);
                cell.insert("outputs".into(), json!([]));
            }
            cells.insert(index, Value::Object(cell));
        }
        "replace" => {
            if source.is_none() && cell_type.is_none() {
                return Err("replace needs new_source, cell_type or both.".into());
            }
            let count = cells.len();
            let cell = cells
                .get_mut(index)
                .and_then(Value::as_object_mut)
                .ok_or(format!(
                    "There is no cell {index}; the notebook has {count} cells."
                ))?;
            if let Some(source) = source {
                cell.insert("source".into(), lines(source));
            }
            if let Some(kind) = cell_type {
                cell.insert("cell_type".into(), json!(kind));
            }
            if cell.get("cell_type").and_then(Value::as_str) == Some("code") {
                // Outputs of the old source no longer belong to it.
                cell.insert("execution_count".into(), Value::Null);
                cell.insert("outputs".into(), json!([]));
            } else {
                cell.remove("execution_count");
                cell.remove("outputs");
            }
        }
        other => return Err(format!("mode is replace, insert or delete (not {other}).")),
    }
    Ok(serialize(&notebook, text))
}

/// Jupyter's form of a cell source: lines that keep their "\n", the last one without.
fn lines(source: &str) -> Value {
    let source = source.replace("\r\n", "\n");
    Value::Array(
        source
            .split_inclusive('\n')
            .map(|line| Value::String(line.to_string()))
            .collect(),
    )
}

fn cell_id(text: &str, index: usize, count: usize) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    (text.len(), index, count, std::time::SystemTime::now()).hash(&mut hasher);
    format!("{:016x}", hasher.finish())[..8].to_string()
}

/// Pretty JSON with the original file's indentation and final newline.
fn serialize(notebook: &Value, original: &str) -> String {
    let indent = original
        .lines()
        .nth(1)
        .map(|line| line.len() - line.trim_start_matches(' ').len())
        .filter(|n| *n > 0)
        .unwrap_or(1);
    let spaces = " ".repeat(indent);
    let mut out = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(spaces.as_bytes());
    let mut serializer = serde_json::Serializer::with_formatter(&mut out, formatter);
    if serde::Serialize::serialize(notebook, &mut serializer).is_err() {
        return original.to_string();
    }
    let mut text = String::from_utf8(out).unwrap_or_else(|_| original.to_string());
    if original.ends_with('\n') {
        text.push('\n');
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTEBOOK: &str = "{\n \"cells\": [\n  {\n   \"cell_type\": \"code\",\n   \"execution_count\": 3,\n   \"id\": \"a1\",\n   \"metadata\": {},\n   \"outputs\": [{\"output_type\": \"stream\", \"name\": \"stdout\", \"text\": [\"1\\n\"]}],\n   \"source\": [\"x = 1\\n\", \"print(x)\"]\n  },\n  {\n   \"cell_type\": \"markdown\",\n   \"id\": \"b2\",\n   \"metadata\": {},\n   \"source\": [\"# Title\"]\n  }\n ],\n \"metadata\": {\"kernelspec\": {\"name\": \"python3\"}},\n \"nbformat\": 4,\n \"nbformat_minor\": 5\n}\n";

    fn edit(args: Value) -> Result<Value, String> {
        edited(NOTEBOOK, &args).map(|text| serde_json::from_str(&text).expect("json"))
    }

    #[test]
    fn replacing_code_sets_jupyter_lines_and_drops_stale_outputs() {
        let nb = edit(json!({"cell": 0, "new_source": "x = 2\nprint(x * 2)"})).expect("edit");
        let cell = &nb["cells"][0];
        assert_eq!(cell["source"], json!(["x = 2\n", "print(x * 2)"]));
        assert_eq!(cell["outputs"], json!([]));
        assert!(cell["execution_count"].is_null());
        assert_eq!(cell["id"], "a1", "other fields are kept");
        assert_eq!(nb["metadata"]["kernelspec"]["name"], "python3");
    }

    #[test]
    fn inserting_and_deleting_cells() {
        let nb = edit(json!({"mode": "insert", "cell": 1, "new_source": "Some notes", "cell_type": "markdown"})).expect("insert");
        assert_eq!(nb["cells"].as_array().map(Vec::len), Some(3));
        assert_eq!(nb["cells"][1]["cell_type"], "markdown");
        assert!(
            nb["cells"][1]["id"]
                .as_str()
                .is_some_and(|id| id.len() == 8),
            "nbformat 4.5 cells get an id"
        );
        assert!(nb["cells"][1].get("outputs").is_none());
        let nb = edit(json!({"mode": "delete", "cell": 0})).expect("delete");
        assert_eq!(nb["cells"].as_array().map(Vec::len), Some(1));
        assert_eq!(nb["cells"][0]["id"], "b2");
    }

    #[test]
    fn the_files_order_indentation_and_final_newline_are_kept() {
        let text =
            edited(NOTEBOOK, &json!({"cell": 1, "new_source": "# New title"})).expect("edit");
        assert!(
            text.starts_with("{\n \"cells\": [\n  {"),
            "one-space indent kept: {text}"
        );
        assert!(text.ends_with("}\n"));
        let keys: Vec<&str> = text
            .lines()
            .filter(|l| l.starts_with(" \""))
            .map(|l| l.trim())
            .collect();
        assert!(
            keys[0].starts_with("\"cells\"")
                && keys
                    .last()
                    .is_some_and(|k| k.starts_with("\"nbformat_minor\""))
        );
    }

    #[test]
    fn bad_requests_change_nothing() {
        assert!(edit(json!({"cell": 9, "new_source": "x"})).is_err());
        assert!(edit(json!({"mode": "insert", "cell": 5, "new_source": "x"})).is_err());
        assert!(edit(json!({"cell": 0, "cell_type": "sql"})).is_err());
        assert!(edit(json!({"mode": "move", "cell": 0})).is_err());
        assert!(
            edit(json!({"new_source": "x"})).is_err(),
            "cell is required"
        );
        assert!(edited(
            "{\"nbformat\": 3, \"cells\": []}",
            &json!({"cell": 0, "new_source": "x"})
        )
        .is_err());
        assert!(edited("not json", &json!({"cell": 0})).is_err());
    }
}
