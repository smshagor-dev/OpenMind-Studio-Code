//! The rest of Claude Code's file and terminal tools: several replacements in one file as one change (`multi_edit`),
//! moving or renaming a file (`move_file`), and reading or stopping a background command. A move is prepared like any
//! change (paths inside the folder, never over an existing file, never a file with unsaved editor changes), checked
//! again after approval, and recorded as two changes so Undo can put the file back.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;

use super::change::{planned_write, refused, replace_text, validate_now, UNSAVED};
use super::{arg_str, Change, ChangeKind, Op, Outcome, Prepared, ToolContext, ToolKind};
use crate::textfile;

/// Edits one `multi_edit` call may make.
const MAX_EDITS: usize = 50;
/// A file moved in one step is read into memory (for Undo); bigger files are refused.
const MAX_MOVE_BYTES: u64 = 32 * 1024 * 1024;

pub fn multi_edit(args: &Value, ctx: &ToolContext<'_>) -> Prepared {
    let (Ok(path_arg), Some(edits)) = (arg_str(args, "path"), args["edits"].as_array()) else {
        return refused(
            "Update",
            String::new(),
            "multi_edit needs path and a list of edits.",
        );
    };
    let path = match ctx.ws.resolve_for_change(path_arg) {
        Ok(p) => p,
        Err(e) => return refused("Update", path_arg.into(), e),
    };
    let rel = ctx.ws.relative(&path);
    if edits.is_empty() || edits.len() > MAX_EDITS {
        return refused(
            "Update",
            rel,
            format!("multi_edit needs between 1 and {MAX_EDITS} edits."),
        );
    }
    if !path.is_file() {
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
    let mut text = file.text.clone();
    for (index, edit) in edits.iter().enumerate() {
        let (Ok(old), Ok(new)) = (arg_str(edit, "old_string"), arg_str(edit, "new_string")) else {
            return refused(
                "Update",
                rel,
                format!("Edit {} needs old_string and new_string.", index + 1),
            );
        };
        let replace_all = edit["replace_all"].as_bool().unwrap_or(false);
        text = match replace_text(&text, old, new, replace_all) {
            Ok(next) => next,
            Err(message) => {
                return refused(
                    "Update",
                    rel,
                    format!(
                        "Edit {} of {}: {message} Nothing was changed.",
                        index + 1,
                        edits.len()
                    ),
                )
            }
        };
    }
    planned_write(path, rel, Some(file), text, "Update")
}

pub fn move_file(args: &Value, ctx: &ToolContext<'_>) -> Prepared {
    let (Ok(from_arg), Ok(to_arg)) = (arg_str(args, "from"), arg_str(args, "to")) else {
        return refused("Move", String::new(), "move_file needs from and to.");
    };
    let target = format!("{} → {}", from_arg.trim(), to_arg.trim());
    let from = match ctx.ws.resolve_for_change(from_arg) {
        Ok(p) => p,
        Err(e) => return refused("Move", target, e),
    };
    let to = match ctx.ws.resolve_for_change(to_arg) {
        Ok(p) => p,
        Err(e) => return refused("Move", target, e),
    };
    let target = format!("{} → {}", ctx.ws.relative(&from), ctx.ws.relative(&to));
    match fs::symlink_metadata(&from) {
        Ok(meta) if meta.is_file() && meta.len() <= MAX_MOVE_BYTES => {}
        Ok(meta) if meta.is_file() => {
            return refused("Move", target, "The file is too big to move in one step.")
        }
        Ok(_) => {
            return refused(
                "Move",
                target,
                "Only files can be moved (not folders or links). Use run_command for a folder.",
            )
        }
        Err(_) => return refused("Move", target, "The file to move does not exist."),
    }
    if from == to {
        return refused("Move", target, "The old and the new place are the same.");
    }
    if to.exists() {
        return refused(
            "Move",
            target,
            "Something already exists at the new place; it is never overwritten.",
        );
    }
    if ctx.is_unsaved(&from) {
        return refused("Move", target, UNSAVED);
    }
    let bytes = match fs::read(&from) {
        Ok(bytes) => bytes,
        Err(e) => return refused("Move", target, e.to_string()),
    };
    Prepared {
        kind: ToolKind::Edit,
        title: "Move".into(),
        target,
        diff: None,
        op: Op::Move { from, to, bytes },
    }
}

pub fn apply_move(ctx: &ToolContext<'_>, from: PathBuf, to: PathBuf, bytes: Vec<u8>) -> Outcome {
    if let Err(e) = validate_now(ctx, &from).and_then(|()| validate_now(ctx, &to)) {
        return Outcome::failed(e);
    }
    let (from_rel, to_rel) = (ctx.ws.relative(&from), ctx.ws.relative(&to));
    if fs::read(&from).ok().as_deref() != Some(bytes.as_slice()) {
        return Outcome::failed(format!(
            "{from_rel} changed after the move was prepared. Look at it again."
        ));
    }
    if to.exists() {
        return Outcome::failed(format!(
            "Something now exists at {to_rel}; it is never overwritten."
        ));
    }
    if let Some(parent) = to.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            return Outcome::failed(format!("The folder for {to_rel} could not be created: {e}"));
        }
    }
    if let Err(e) = fs::rename(&from, &to) {
        return Outcome::failed(format!("{from_rel} could not be moved: {e}"));
    }
    let root = ctx.ws.root().to_path_buf();
    Outcome {
        ok: true,
        for_model: format!("Moved {from_rel} to {to_rel}."),
        summary: format!("Moved to {to_rel}"),
        change: Some(Change {
            root: root.clone(),
            path: to,
            rel: to_rel,
            kind: ChangeKind::Created,
            before: None,
            after: Some(bytes.clone()),
        }),
        more_changes: vec![Change {
            root,
            path: from,
            rel: from_rel,
            kind: ChangeKind::Deleted,
            before: Some(bytes),
            after: None,
        }],
        ..Outcome::default()
    }
}

/// `command_output` (`kill: false`) and `kill_command` (`kill: true`) for a background command.
pub fn background(args: &Value, ctx: &ToolContext<'_>, kill: bool) -> Prepared {
    let title = if kill { "Stop" } else { "Output" };
    let id = match arg_str(args, "id") {
        Ok(id) => id.trim().to_string(),
        Err(e) => {
            return Prepared::finished(ToolKind::Read, title, String::new(), Outcome::failed(e))
        }
    };
    let outcome = if kill {
        ctx.shell.kill(&id)
    } else {
        ctx.shell.output(&id)
    };
    Prepared::finished(ToolKind::Read, title, id, outcome)
}
