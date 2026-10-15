//! The tools that change the project. Preparing one computes the exact new text and its diff; running it checks the
//! file is still what was shown (nothing else changed it in between), then writes — keeping the file's encoding and
//! line endings — or moves the file to the Recycle Bin. Each change records what was there before, for Undo.

use std::fs;
use std::path::PathBuf;

/// Checked again after approval. Directory traversal is bounded and never follows links.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DeleteSnapshot(Vec<(PathBuf, u64, Option<std::time::SystemTime>, bool)>);

fn snapshot(path: &std::path::Path) -> Result<DeleteSnapshot, String> {
    let mut pending = vec![path.to_path_buf()];
    let mut rows = Vec::new();
    while let Some(path) = pending.pop() {
        if rows.len() >= 10_000 {
            return Err("This folder is too large to delete safely in one action.".into());
        }
        let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink()
            || path
                .file_name()
                .is_some_and(|n| n.eq_ignore_ascii_case(".git"))
        {
            return Err("Deletion of links or Git internals is refused.".into());
        }
        if meta.is_dir() {
            for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
                pending.push(entry.map_err(|e| e.to_string())?.path());
            }
        }
        rows.push((path, meta.len(), meta.modified().ok(), meta.is_dir()));
    }
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(DeleteSnapshot(rows))
}

fn validate_now(ctx: &ToolContext<'_>, path: &std::path::Path) -> Result<(), String> {
    let resolved = ctx.ws.resolve_for_change(&path.to_string_lossy())?;
    if resolved != path {
        return Err("The path changed after preparation. Read it again.".into());
    }
    if ctx.is_unsaved(path) {
        return Err(UNSAVED.into());
    }
    if ctx.cancel.load(std::sync::atomic::Ordering::Relaxed) {
        return Err("Stopped.".into());
    }
    Ok(())
}

use serde_json::Value;

use super::{arg_str, Change, ChangeKind, Op, Outcome, Prepared, ToolContext, ToolKind};
use crate::diff::{diff, FileDiff};
use crate::textfile::{self, TextFile, MAX_TEXT_BYTES};

fn refused(title: &str, target: String, message: impl Into<String>) -> Prepared {
    Prepared::finished(ToolKind::Edit, title, target, Outcome::failed(message))
}

const UNSAVED: &str =
    "The file has unsaved changes in the editor. Ask the user to save or discard them first.";

fn plural(n: usize, word: &str) -> String {
    if n == 1 {
        format!("1 {word}")
    } else {
        format!("{n} {word}s")
    }
}

fn change_summary(d: &FileDiff) -> String {
    match (d.added, d.removed) {
        (0, 0) => "No lines changed".into(),
        (a, 0) => format!("Added {}", plural(a, "line")),
        (0, r) => format!("Removed {}", plural(r, "line")),
        (a, r) => format!("Added {}, removed {}", plural(a, "line"), plural(r, "line")),
    }
}

pub fn edit_file(args: &Value, ctx: &ToolContext<'_>) -> Prepared {
    let (Ok(path_arg), Ok(old), Ok(new)) = (
        arg_str(args, "path"),
        arg_str(args, "old_string"),
        arg_str(args, "new_string"),
    ) else {
        return refused(
            "Update",
            String::new(),
            "edit_file needs path, old_string and new_string.",
        );
    };
    let path = match ctx.ws.resolve_for_change(path_arg) {
        Ok(p) => p,
        Err(e) => return refused("Update", path_arg.into(), e),
    };
    let rel = ctx.ws.relative(&path);
    if !path.exists() {
        return refused(
            "Update",
            rel,
            "The file does not exist. Use write_file to create it.",
        );
    }
    if ctx.is_unsaved(&path) {
        return refused("Update", rel, UNSAVED);
    }
    let file = match textfile::read(&path) {
        Ok(f) => f,
        Err(e) => return refused("Update", rel, e),
    };
    let old = old.replace("\r\n", "\n");
    let new = new.replace("\r\n", "\n");
    if old.is_empty() {
        return refused(
            "Update",
            rel,
            "old_string is empty. Use write_file to replace a whole file.",
        );
    }
    if old == new {
        return refused(
            "Update",
            rel,
            "old_string and new_string are the same; nothing would change.",
        );
    }
    let count = file.text.matches(old.as_str()).count();
    let replace_all = args["replace_all"].as_bool().unwrap_or(false);
    let text = match (count, replace_all) {
        (0, _) => {
            return refused(
                "Update",
                rel,
                "old_string was not found in the file. Read the file again and copy the text exactly, with its indentation.",
            )
        }
        (1, _) | (_, true) => file.text.replace(old.as_str(), &new),
        (n, false) => {
            return refused(
                "Update",
                rel,
                format!("old_string appears {n} times. Add more surrounding lines so it is unique, or set replace_all."),
            )
        }
    };
    planned_write(path, rel, Some(file), text, "Update")
}

pub fn write_file(args: &Value, ctx: &ToolContext<'_>) -> Prepared {
    let (Ok(path_arg), Ok(content)) = (arg_str(args, "path"), arg_str(args, "content")) else {
        return refused("Write", String::new(), "write_file needs path and content.");
    };
    let path = match ctx.ws.resolve_for_change(path_arg) {
        Ok(p) => p,
        Err(e) => return refused("Write", path_arg.into(), e),
    };
    let rel = ctx.ws.relative(&path);
    if content.len() as u64 > MAX_TEXT_BYTES {
        return refused("Write", rel, "The content is too big for one file write.");
    }
    if path.is_dir() {
        return refused("Write", rel, "A folder has that name.");
    }
    if ctx.is_unsaved(&path) {
        return refused("Write", rel, UNSAVED);
    }
    let before = if path.exists() {
        match textfile::read(&path) {
            Ok(f) => Some(f),
            Err(e) => return refused("Write", rel, e),
        }
    } else {
        None
    };
    let title = if before.is_some() { "Write" } else { "Create" };
    planned_write(path, rel, before, content.replace("\r\n", "\n"), title)
}

fn planned_write(
    path: PathBuf,
    rel: String,
    before: Option<TextFile>,
    text: String,
    title: &str,
) -> Prepared {
    let old_text = before.as_ref().map_or("", |f| f.text.as_str());
    let file_diff = diff(old_text, &text);
    let before_bytes = before.as_ref().and_then(|_| fs::read(&path).ok());
    Prepared {
        kind: ToolKind::Edit,
        title: title.into(),
        target: rel,
        diff: Some(file_diff),
        op: Op::Write {
            path,
            before,
            before_bytes,
            text,
        },
    }
}

pub fn apply_write(
    ctx: &ToolContext<'_>,
    path: PathBuf,
    before: Option<TextFile>,
    before_bytes: Option<Vec<u8>>,
    text: &str,
    file_diff: Option<FileDiff>,
) -> Outcome {
    let rel = ctx.ws.relative(&path);
    if let Err(e) = validate_now(ctx, &path) {
        return Outcome::failed(e);
    }
    let now = fs::read(&path).ok();
    if now != before_bytes {
        return Outcome::failed(format!(
            "{rel} changed after the edit was prepared (it was saved from the editor or another program). Read it again and redo the edit."
        ));
    }
    let like = before.clone().unwrap_or_else(TextFile::new_file);
    let after = textfile::encoded_bytes(text, &like);
    if let Err(e) = textfile::write(&path, text, &like) {
        return Outcome::failed(e);
    }
    let file_diff =
        file_diff.unwrap_or_else(|| diff(before.as_ref().map_or("", |f| &f.text), text));
    let created = before.is_none();
    let summary = if created {
        format!("Created with {}", plural(text.lines().count(), "line"))
    } else {
        change_summary(&file_diff)
    };
    let for_model = if created {
        format!("Created {rel}.")
    } else {
        format!("Updated {rel} ({}).", summary.to_lowercase())
    };
    Outcome {
        ok: true,
        for_model,
        summary,
        diff: Some(file_diff),
        change: Some(Change {
            root: ctx.ws.root().to_path_buf(),
            path,
            rel,
            kind: if created {
                ChangeKind::Created
            } else {
                ChangeKind::Modified
            },
            before: before_bytes,
            after: Some(after),
        }),
        todos: None,
    }
}

pub fn delete_file(args: &Value, ctx: &ToolContext<'_>) -> Prepared {
    let path_arg = match arg_str(args, "path") {
        Ok(p) => p,
        Err(e) => return refused("Delete", String::new(), e),
    };
    let path = match ctx.ws.resolve_for_change(path_arg) {
        Ok(p) => p,
        Err(e) => return refused("Delete", path_arg.into(), e),
    };
    let rel = ctx.ws.relative(&path);
    let Ok(meta) = fs::symlink_metadata(&path) else {
        return refused("Delete", rel, "There is nothing with that name.");
    };
    if ctx.is_unsaved(&path) {
        return refused("Delete", rel, UNSAVED);
    }
    let before_bytes = (meta.is_file() && meta.len() <= MAX_TEXT_BYTES)
        .then(|| fs::read(&path).ok())
        .flatten();
    let file_diff = before_bytes
        .as_ref()
        .and_then(|bytes| String::from_utf8(bytes.clone()).ok())
        .map(|text| diff(&text.replace("\r\n", "\n"), ""));
    let snapshot = match snapshot(&path) {
        Ok(s) => s,
        Err(e) => return refused("Delete", rel, e),
    };
    Prepared {
        kind: ToolKind::Delete,
        title: "Delete".into(),
        target: if meta.is_dir() {
            format!("{rel}/")
        } else {
            rel
        },
        diff: file_diff,
        op: Op::Delete {
            path,
            before_bytes,
            snapshot,
        },
    }
}

pub fn apply_delete(
    ctx: &ToolContext<'_>,
    path: PathBuf,
    before_bytes: Option<Vec<u8>>,
    approved: DeleteSnapshot,
) -> Outcome {
    let rel = ctx.ws.relative(&path);
    if let Err(e) = validate_now(ctx, &path) {
        return Outcome::failed(e);
    }
    if snapshot(&path).as_ref() != Ok(&approved)
        || before_bytes
            .as_ref()
            .is_some_and(|before| fs::read(&path).ok().as_ref() != Some(before))
    {
        return Outcome::failed("The target changed after deletion was prepared. Read it again and request a new approval.");
    }
    if !path.exists() {
        return Outcome::failed(format!("{rel} is already gone."));
    }
    if let Err(err) = trash::delete(&path) {
        return Outcome::failed(format!(
            "{rel} could not be moved to the Recycle Bin ({err}); it was not deleted."
        ));
    }
    Outcome {
        ok: true,
        for_model: format!("Deleted {rel} (moved to the Recycle Bin)."),
        summary: "Moved to the Recycle Bin".into(),
        diff: None,
        change: Some(Change {
            root: ctx.ws.root().to_path_buf(),
            path,
            rel,
            kind: ChangeKind::Deleted,
            before: before_bytes,
            after: None,
        }),
        todos: None,
    }
}
