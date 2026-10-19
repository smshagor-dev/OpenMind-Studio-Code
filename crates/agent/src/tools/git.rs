//! Git as tools, as Claude Code works with a repository: `git_status` and `git_diff` look (no permission needed), and
//! `git_commit` records the named files — or what is already staged — with a message, asked about like any command. Git
//! runs as a program with an argument list (no shell, so a message needs no quoting), in the project folder, with the
//! app's environment (OpenMind's portable Git first on PATH), no prompt and no editor. A commit never adds every file by
//! itself, so nothing untracked (a secret, a build output) is swept in.

use std::process::{Command, Stdio};

use serde_json::Value;

use super::{arg_str, Op, Outcome, Prepared, ToolContext, ToolKind};

/// Characters of a diff the model reads.
const MAX_DIFF: usize = 16_000;

fn git(args: &[&str], ctx: &ToolContext<'_>) -> Result<(bool, String), String> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(ctx.ws.root())
        .stdin(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .env("GIT_PAGER", "cat");
    for (name, value) in &ctx.env.vars {
        command.env(name, value);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command
        .output()
        .map_err(|e| format!("Git could not start ({e}). Install Git from the Runtime Manager."))?;
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    let errors = String::from_utf8_lossy(&output.stderr);
    if !errors.trim().is_empty() {
        text.push_str(&errors);
    }
    Ok((output.status.success(), text.trim_end().to_string()))
}

fn looked(
    title: &str,
    target: String,
    result: Result<(bool, String), String>,
    empty: &str,
) -> Prepared {
    let outcome = match result {
        Ok((true, text)) if text.is_empty() => Outcome::done(empty.into(), empty.into()),
        Ok((true, text)) => {
            let lines = text.lines().count();
            Outcome::done(
                super::command::shorten(&text, MAX_DIFF),
                format!("{lines} lines"),
            )
        }
        Ok((false, text)) => Outcome::failed(text),
        Err(message) => Outcome::failed(message),
    };
    Prepared::finished(ToolKind::Read, title, target, outcome)
}

pub fn status(ctx: &ToolContext<'_>) -> Prepared {
    let result = git(&["status", "--short", "--branch"], ctx).and_then(|(ok, status)| {
        if !ok {
            return Ok((false, status));
        }
        let log = git(&["log", "--oneline", "-5"], ctx)
            .map(|(_, log)| log)
            .unwrap_or_default();
        Ok((true, format!("{status}\n\nLast commits:\n{log}")))
    });
    looked("Git status", String::new(), result, "No changes.")
}

pub fn diff(args: &Value, ctx: &ToolContext<'_>) -> Prepared {
    let staged = args["staged"].as_bool().unwrap_or(false);
    let path = args["path"]
        .as_str()
        .map(str::trim)
        .filter(|p| !p.is_empty());
    if let Some(path) = path {
        if let Err(e) = ctx.ws.resolve(path) {
            return Prepared::finished(ToolKind::Read, "Git diff", path.into(), Outcome::failed(e));
        }
    }
    let mut stat_args = vec!["--no-pager", "diff", "--stat"];
    let mut diff_args = vec!["--no-pager", "diff"];
    if staged {
        stat_args.push("--staged");
        diff_args.push("--staged");
    }
    if let Some(path) = path {
        for list in [&mut stat_args, &mut diff_args] {
            list.extend(["--", path]);
        }
    }
    let result = git(&stat_args, ctx).and_then(|(ok, stat)| {
        if !ok {
            return Ok((false, stat));
        }
        git(&diff_args, ctx).map(|(ok, diff)| {
            (
                ok,
                if diff.is_empty() {
                    String::new()
                } else {
                    format!("{stat}\n\n{diff}")
                },
            )
        })
    });
    let what = if staged { "staged" } else { "unstaged" };
    looked(
        "Git diff",
        path.unwrap_or(what).to_string(),
        result,
        &format!("No {what} changes."),
    )
}

/// A commit, prepared: checked here, run only after approval.
pub fn commit(args: &Value, ctx: &ToolContext<'_>) -> Prepared {
    let message = arg_str(args, "message").map(str::trim).unwrap_or("");
    let refused = |m: &str| {
        Prepared::finished(
            ToolKind::Command,
            "Git commit",
            String::new(),
            Outcome::failed(m),
        )
    };
    if message.is_empty() || message.len() > 10_000 || message.contains('\0') {
        return refused("git_commit needs a commit message.");
    }
    let mut paths = Vec::new();
    for value in args["paths"].as_array().into_iter().flatten() {
        let Some(path) = value.as_str().map(str::trim).filter(|p| !p.is_empty()) else {
            return refused("paths must be a list of file paths.");
        };
        match ctx.ws.resolve(path) {
            Ok(full) => paths.push(ctx.ws.relative(&full)),
            Err(e) => return refused(&e),
        }
    }
    let summary = message.lines().next().unwrap_or(message);
    let files = if paths.is_empty() {
        "the staged changes".to_string()
    } else {
        paths.join(", ")
    };
    Prepared {
        kind: ToolKind::Command,
        title: "Git commit".into(),
        target: format!("git commit {files}: {summary}"),
        diff: None,
        op: Op::GitCommit {
            message: message.to_string(),
            paths,
        },
    }
}

pub fn run_commit(message: &str, paths: &[String], ctx: &ToolContext<'_>) -> Outcome {
    if !paths.is_empty() {
        let mut add = vec!["add", "--"];
        add.extend(paths.iter().map(String::as_str));
        match git(&add, ctx) {
            Ok((true, _)) => {}
            Ok((false, text)) => return Outcome::failed(format!("git add failed: {text}")),
            Err(message) => return Outcome::failed(message),
        }
    }
    match git(&["diff", "--staged", "--quiet"], ctx) {
        Ok((true, _)) => {
            return Outcome::failed(
                "Nothing is staged to commit. Name the files to commit in paths.",
            );
        }
        Ok((false, _)) => {}
        Err(message) => return Outcome::failed(message),
    }
    match git(&["commit", "-m", message], ctx) {
        Ok((true, text)) => {
            let first = text.lines().next().unwrap_or("Committed").to_string();
            Outcome::done(text, first)
        }
        Ok((false, text)) => Outcome::failed(format!("git commit failed: {text}")),
        Err(message) => Outcome::failed(message),
    }
}
