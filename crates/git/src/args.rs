//! Builds the argument lists for every Git command the client runs. Nothing
//! here touches a shell: each command is a `Vec<String>` handed to the process
//! API, so a file name or message can never become part of a command line.
//! Paths always come after `--` (with `--literal-pathspecs` in front),
//! so a name like `*.txt` or `-rf` is a file, not a pattern or an option.

use crate::error::GitError;

const LITERAL: &str = "--literal-pathspecs";

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_string()).collect()
}

/// Paths are literal file names, never patterns (`*.txt`, `:(top)`): the global
/// flag goes first, the paths after `--`. (Not an environment variable: that
/// would also break `git stash --include-untracked`, which builds its own pathspecs.)
fn with_paths(mut args: Vec<String>, paths: &[String]) -> Vec<String> {
    args.insert(0, LITERAL.to_string());
    args.push("--".to_string());
    args.extend(paths.iter().cloned());
    args
}

pub fn rev_parse_toplevel() -> Vec<String> {
    strings(&["rev-parse", "--show-toplevel"])
}

pub fn init() -> Vec<String> {
    strings(&["init"])
}

pub fn status() -> Vec<String> {
    strings(&[
        "-c",
        "core.quotepath=off",
        "status",
        "--porcelain=v2",
        "-z",
        "--branch",
        "--untracked-files=all",
    ])
}

pub fn stage(paths: &[String]) -> Vec<String> {
    with_paths(strings(&["add"]), paths)
}

pub fn stage_all() -> Vec<String> {
    strings(&["add", "-A"])
}

/// Unstage paths. Before the first commit there is no HEAD to restore from,
/// so the index entry is removed instead (the file itself is kept).
pub fn unstage(paths: &[String], has_head: bool) -> Vec<String> {
    if has_head {
        with_paths(strings(&["restore", "--staged"]), paths)
    } else {
        with_paths(strings(&["rm", "--cached", "-r", "-q"]), paths)
    }
}

pub fn unstage_all(has_head: bool) -> Vec<String> {
    if has_head {
        strings(&["reset", "-q"])
    } else {
        strings(&["rm", "--cached", "-r", "-q", "--", "."])
    }
}

/// Restores tracked files from the index (throws away working-tree edits).
pub fn discard(paths: &[String]) -> Vec<String> {
    with_paths(strings(&["restore", "--worktree"]), paths)
}

pub fn discard_all_tracked() -> Vec<String> {
    strings(&["restore", "--worktree", "--", "."])
}

pub fn commit(message: &str) -> Vec<String> {
    vec!["commit".to_string(), "-m".to_string(), message.to_string()]
}

/// Prints a blob: `:<path>` is the staged version, `HEAD:<path>` the committed one.
pub fn cat_blob(spec: &str) -> Vec<String> {
    vec!["cat-file".to_string(), "blob".to_string(), spec.to_string()]
}

pub fn has_head() -> Vec<String> {
    strings(&["rev-parse", "--verify", "-q", "HEAD"])
}

pub fn list_branches() -> Vec<String> {
    strings(&[
        "for-each-ref",
        "--format=%(HEAD)%09%(refname:short)%09%(upstream:short)",
        "refs/heads",
    ])
}

pub fn check_branch_name(name: &str) -> Vec<String> {
    vec![
        "check-ref-format".to_string(),
        "--branch".to_string(),
        name.to_string(),
    ]
}

pub fn switch_branch(name: &str) -> Vec<String> {
    vec!["switch".to_string(), name.to_string()]
}

pub fn create_branch(name: &str) -> Vec<String> {
    vec!["switch".to_string(), "-c".to_string(), name.to_string()]
}

/// A safe delete: Git itself refuses branches with unmerged commits.
pub fn delete_branch(name: &str) -> Vec<String> {
    vec!["branch".to_string(), "-d".to_string(), name.to_string()]
}

pub fn config_get(key: &str) -> Vec<String> {
    vec!["config".to_string(), "--get".to_string(), key.to_string()]
}

pub fn config_set(key: &str, value: &str) -> Vec<String> {
    vec!["config".to_string(), key.to_string(), value.to_string()]
}

/// Clones `url` into `dest` (both already validated). `--` keeps a URL from being read as an option.
pub fn clone(url: &str, dest: &str) -> Vec<String> {
    vec![
        "clone".to_string(),
        "--progress".to_string(),
        "--".to_string(),
        url.to_string(),
        dest.to_string(),
    ]
}

/// Up to `limit` commits of the current branch, newest first, NUL-separated records.
pub fn log(limit: u32) -> Vec<String> {
    vec![
        "log".to_string(),
        format!("--max-count={limit}"),
        "-z".to_string(),
        "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s".to_string(),
    ]
}

/// The files one commit changed (first parent for merges; renames detected).
pub fn show_files(hash: &str) -> Vec<String> {
    vec![
        "show".to_string(),
        "--name-status".to_string(),
        "-z".to_string(),
        "-M".to_string(),
        "--diff-merges=first-parent".to_string(),
        "--format=".to_string(),
        hash.to_string(),
    ]
}

pub fn blame(path: &str) -> Vec<String> {
    vec![
        LITERAL.to_string(),
        "blame".to_string(),
        "--porcelain".to_string(),
        "--".to_string(),
        path.to_string(),
    ]
}

pub fn ls_files(path: &str) -> Vec<String> {
    vec![
        LITERAL.to_string(),
        "ls-files".to_string(),
        "--error-unmatch".to_string(),
        "--".to_string(),
        path.to_string(),
    ]
}

pub fn stash_list() -> Vec<String> {
    strings(&["stash", "list", "-z", "--format=%gd%x1f%gs%x1f%aI"])
}

/// `git stash push`, optionally with a message and untracked files.
pub fn stash_push(message: &str, include_untracked: bool) -> Vec<String> {
    let mut args = strings(&["stash", "push"]);
    if include_untracked {
        args.push("--include-untracked".to_string());
    }
    if !message.is_empty() {
        args.push("-m".to_string());
        args.push(message.to_string());
    }
    args
}

pub fn stash_apply(reference: &str) -> Vec<String> {
    vec![
        "stash".to_string(),
        "apply".to_string(),
        reference.to_string(),
    ]
}

pub fn stash_pop(reference: &str) -> Vec<String> {
    vec![
        "stash".to_string(),
        "pop".to_string(),
        reference.to_string(),
    ]
}

pub fn stash_drop(reference: &str) -> Vec<String> {
    vec![
        "stash".to_string(),
        "drop".to_string(),
        reference.to_string(),
    ]
}

pub fn fetch() -> Vec<String> {
    strings(&["fetch"])
}

/// Fast-forward only: never creates a merge commit or rewrites history.
pub fn pull() -> Vec<String> {
    strings(&["pull", "--ff-only"])
}

pub fn push() -> Vec<String> {
    strings(&["push"])
}

/// A branch name that is safe to hand to Git as a positional argument.
/// (`check-ref-format` is asked as well; this catches what must never reach it.)
pub fn validate_branch_syntax(name: &str) -> Result<&str, GitError> {
    let bad = name.is_empty()
        || name.starts_with('-')
        || name.chars().any(|c| c.is_whitespace() || c.is_control());
    if bad {
        Err(GitError::InvalidBranchName(name.to_string()))
    } else {
        Ok(name)
    }
}

/// The label logged for a command: the sub-command and flags, with paths
/// counted rather than listed and a commit message elided.
pub fn label(args: &[String]) -> String {
    let mut shown: Vec<&str> = vec!["git"];
    let mut iter = args.iter().peekable();
    while let Some(arg) = iter.next() {
        if arg == "-c" {
            iter.next();
            continue;
        }
        if arg == LITERAL {
            continue;
        }
        if arg == "--" {
            let count = iter.count();
            shown.push("--");
            return format!(
                "{} {} path{}",
                shown.join(" "),
                count,
                if count == 1 { "" } else { "s" }
            );
        }
        if arg == "-m" {
            iter.next();
            shown.push("-m <message>");
            continue;
        }
        shown.push(arg);
    }
    shown.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_string()).collect()
    }

    #[test]
    fn stage_and_discard_put_paths_after_the_separator_untouched() {
        let files = paths(&["my folder/a b.txt", "-rf", "*.txt"]);
        assert_eq!(
            stage(&files),
            [
                "--literal-pathspecs",
                "add",
                "--",
                "my folder/a b.txt",
                "-rf",
                "*.txt"
            ]
        );
        assert_eq!(
            discard(&files),
            [
                "--literal-pathspecs",
                "restore",
                "--worktree",
                "--",
                "my folder/a b.txt",
                "-rf",
                "*.txt"
            ]
        );
    }

    #[test]
    fn unstage_restores_from_head_or_removes_from_the_index_before_the_first_commit() {
        let files = paths(&["a b.txt"]);
        assert_eq!(
            unstage(&files, true),
            [
                "--literal-pathspecs",
                "restore",
                "--staged",
                "--",
                "a b.txt"
            ]
        );
        assert_eq!(
            unstage(&files, false),
            [
                "--literal-pathspecs",
                "rm",
                "--cached",
                "-r",
                "-q",
                "--",
                "a b.txt"
            ]
        );
        assert_eq!(unstage_all(true), ["reset", "-q"]);
        assert_eq!(
            unstage_all(false),
            ["rm", "--cached", "-r", "-q", "--", "."]
        );
    }

    #[test]
    fn commit_passes_the_message_as_one_argument() {
        let message = "fix: it's \"quoted\"\n\n- second line; & more $(x)";
        assert_eq!(commit(message), ["commit", "-m", message]);
    }

    #[test]
    fn blobs_are_read_by_index_or_head_spec() {
        assert_eq!(cat_blob(":a b.txt"), ["cat-file", "blob", ":a b.txt"]);
        assert_eq!(
            cat_blob("HEAD:a b.txt"),
            ["cat-file", "blob", "HEAD:a b.txt"]
        );
    }

    #[test]
    fn status_is_machine_readable_and_lists_untracked_files() {
        let args = status();
        assert!(args.contains(&"--porcelain=v2".to_string()));
        assert!(args.contains(&"-z".to_string()));
        assert!(args.contains(&"--untracked-files=all".to_string()));
    }

    #[test]
    fn pull_never_merges_or_rebases_and_branch_delete_is_the_safe_one() {
        assert_eq!(pull(), ["pull", "--ff-only"]);
        assert_eq!(delete_branch("x"), ["branch", "-d", "x"]);
        assert_eq!(switch_branch("x"), ["switch", "x"]);
        assert_eq!(create_branch("x"), ["switch", "-c", "x"]);
    }

    #[test]
    fn branch_names_that_look_like_options_or_contain_spaces_are_refused() {
        for bad in ["", "-D", "--force", "a b", "a\tb", "a\nb"] {
            assert!(validate_branch_syntax(bad).is_err(), "{bad:?}");
        }
        assert_eq!(
            validate_branch_syntax("feature/x-1").unwrap(),
            "feature/x-1"
        );
    }

    #[test]
    fn clone_puts_the_address_after_the_separator() {
        assert_eq!(
            clone("https://x/y.git", "C:/my dir/y"),
            [
                "clone",
                "--progress",
                "--",
                "https://x/y.git",
                "C:/my dir/y"
            ]
        );
    }

    #[test]
    fn history_commands_are_bounded_and_machine_readable() {
        let log = log(50);
        assert!(log.contains(&"--max-count=50".to_string()) && log.contains(&"-z".to_string()));
        let show = show_files("abc1234");
        assert_eq!(show.last().map(String::as_str), Some("abc1234"));
        assert!(show.contains(&"--name-status".to_string()) && show.contains(&"-z".to_string()));
        assert_eq!(
            blame("a b.txt"),
            [
                "--literal-pathspecs",
                "blame",
                "--porcelain",
                "--",
                "a b.txt"
            ]
        );
    }

    #[test]
    fn stash_commands_are_built_from_options_and_numbered_references() {
        assert_eq!(stash_push("", false), ["stash", "push"]);
        assert_eq!(
            stash_push("my work; & more", true),
            [
                "stash",
                "push",
                "--include-untracked",
                "-m",
                "my work; & more"
            ]
        );
        assert_eq!(stash_apply("stash@{2}"), ["stash", "apply", "stash@{2}"]);
        assert_eq!(stash_pop("stash@{0}"), ["stash", "pop", "stash@{0}"]);
        assert_eq!(stash_drop("stash@{1}"), ["stash", "drop", "stash@{1}"]);
        assert_eq!(stash_list()[..2], ["stash", "list"]);
    }

    #[test]
    fn labels_count_paths_and_hide_messages() {
        assert_eq!(label(&stage(&paths(&["a", "b"]))), "git add -- 2 paths");
        assert_eq!(label(&stage(&paths(&["a"]))), "git add -- 1 path");
        assert_eq!(label(&commit("secret text")), "git commit -m <message>");
        assert_eq!(
            label(&status()),
            "git status --porcelain=v2 -z --branch --untracked-files=all"
        );
    }
}
