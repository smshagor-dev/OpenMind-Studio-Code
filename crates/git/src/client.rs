//! The Git client: every operation the Source Control view needs, built on
//! [`crate::exec::run`] and the argument builders in [`crate::args`]. It runs
//! blocking (callers put it on a worker thread) and never decides anything the
//! user didn't ask for: nothing is staged, committed, discarded or pushed on
//! its own, and every destructive call must be told it was `confirmed`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

use crate::args;
use crate::error::GitError;
use crate::exe::GitExecutable;
use crate::exec::{self, GitRegistry, Output};
use crate::path::{absolute_in, crosses_symlink, is_lexically_inside, repo_relative};
use crate::status::{parse_status, ChangeKind, FileChange, RepoStatus};

const QUICK: Duration = Duration::from_secs(30);
const REMOTE: Duration = Duration::from_secs(120);
/// Bigger than this is not diffed (the editor would stall).
const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;

/// One command as the Git output channel shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub label: String,
    pub cwd: String,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// The original and modified bytes of a diff (`None` = absent on that side).
type Sides = (Option<Vec<u8>>, Option<Vec<u8>>);

pub type LogSink = Arc<dyn Fn(LogEntry) + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub current: bool,
    pub upstream: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub name: Option<String>,
    pub email: Option<String>,
}

/// Both sides of a file's diff. `None` = the file doesn't exist on that side
/// (added or deleted). `binary` files carry no text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSides {
    pub path: String,
    pub original: Option<String>,
    pub modified: Option<String>,
    pub binary: bool,
}

/// Refuses a destructive action the user hasn't confirmed.
pub fn require_confirmed(confirmed: bool, what: &'static str) -> Result<(), GitError> {
    if confirmed {
        Ok(())
    } else {
        Err(GitError::NotConfirmed(what))
    }
}

pub struct GitClient {
    exe: GitExecutable,
    sink: LogSink,
    registry: GitRegistry,
}

impl GitClient {
    pub fn new(exe: GitExecutable, sink: LogSink, registry: GitRegistry) -> Self {
        Self {
            exe,
            sink,
            registry,
        }
    }

    pub fn executable(&self) -> &GitExecutable {
        &self.exe
    }

    // --- Running commands ---

    fn run(
        &self,
        cwd: &Path,
        args: &[String],
        timeout: Duration,
        log_stdout: bool,
    ) -> Result<Output, GitError> {
        let output = exec::run(&self.exe.path, cwd, args, timeout, &self.registry)?;
        let stdout = if log_stdout {
            // `git status -z` separates records with NUL: show them as lines.
            shorten(&output.stdout_text().replace('\0', "\n"), 4000)
        } else {
            String::new()
        };
        (self.sink)(LogEntry {
            label: args::label(args),
            cwd: cwd.display().to_string(),
            code: output.code,
            stdout: stdout.trim_end().to_string(),
            stderr: output.stderr.clone(),
        });
        Ok(output)
    }

    /// Runs a command that must succeed; Git's own message is the error.
    fn ok(&self, cwd: &Path, args: &[String], timeout: Duration) -> Result<Output, GitError> {
        let output = self.run(cwd, args, timeout, true)?;
        if output.success() {
            Ok(output)
        } else {
            Err(failure(&output))
        }
    }

    // --- Repository ---

    /// The root of the repository `workspace` is in.
    pub fn find_root(&self, workspace: &Path) -> Result<PathBuf, GitError> {
        let output = self.run(workspace, &args::rev_parse_toplevel(), QUICK, true)?;
        if output.success() {
            let root = output.stdout_text().trim().to_string();
            return Ok(PathBuf::from(root));
        }
        Err(failure(&output))
    }

    /// `git init` in the workspace folder.
    pub fn init(&self, workspace: &Path) -> Result<PathBuf, GitError> {
        self.ok(workspace, &args::init(), QUICK)?;
        Ok(workspace.to_path_buf())
    }

    pub fn status(&self, root: &Path) -> Result<RepoStatus, GitError> {
        let output = self.ok(root, &args::status(), QUICK)?;
        Ok(parse_status(&output.stdout))
    }

    // --- Staging ---

    pub fn stage(&self, root: &Path, paths: &[String]) -> Result<(), GitError> {
        let paths = checked(paths)?;
        self.ok(root, &args::stage(&paths), QUICK).map(drop)
    }

    pub fn stage_all(&self, root: &Path) -> Result<(), GitError> {
        self.ok(root, &args::stage_all(), QUICK).map(drop)
    }

    pub fn unstage(&self, root: &Path, paths: &[String]) -> Result<(), GitError> {
        let paths = checked(paths)?;
        let has_head = self.status(root)?.has_head();
        self.ok(root, &args::unstage(&paths, has_head), QUICK)
            .map(drop)
    }

    pub fn unstage_all(&self, root: &Path) -> Result<(), GitError> {
        let has_head = self.status(root)?.has_head();
        self.ok(root, &args::unstage_all(has_head), QUICK).map(drop)
    }

    // --- Destructive: only with confirmation ---

    /// Throws away working-tree edits of tracked files. Untracked files are
    /// never touched here (see [`Self::delete_untracked`]).
    pub fn discard(&self, root: &Path, paths: &[String], confirmed: bool) -> Result<(), GitError> {
        require_confirmed(confirmed, "Discarding changes")?;
        let paths = checked(paths)?;
        let status = self.status(root)?;
        for path in &paths {
            let discardable = status
                .changes
                .iter()
                .any(|change| change.path == *path && change.is_unstaged());
            if !discardable {
                return Err(GitError::NothingToDiscard(path.clone()));
            }
        }
        self.ok(root, &args::discard(&paths), QUICK).map(drop)
    }

    pub fn discard_all(&self, root: &Path, confirmed: bool) -> Result<(), GitError> {
        require_confirmed(confirmed, "Discarding all changes")?;
        self.ok(root, &args::discard_all_tracked(), QUICK).map(drop)
    }

    /// Deletes one untracked file from disk. Refuses anything Git doesn't
    /// list as untracked, anything outside the repository, and symlinks.
    pub fn delete_untracked(
        &self,
        root: &Path,
        path: &str,
        confirmed: bool,
    ) -> Result<(), GitError> {
        require_confirmed(confirmed, "Deleting a file")?;
        let relative = repo_relative(path)?;
        let status = self.status(root)?;
        let untracked = status
            .changes
            .iter()
            .any(|change| change.path == relative && change.is_untracked());
        if !untracked {
            return Err(GitError::NothingToDiscard(relative));
        }
        let target = absolute_in(root, &relative);
        if crosses_symlink(root, &relative) || !is_lexically_inside(root, &target) {
            return Err(GitError::OutsideRepository(relative));
        }
        std::fs::remove_file(&target)
            .map_err(|err| GitError::Failed(format!("Couldn't delete {relative}: {err}")))
    }

    // --- Commit ---

    /// Commits what is staged. Returns Git's one-line summary.
    pub fn commit(&self, root: &Path, message: &str) -> Result<String, GitError> {
        let message = message.trim();
        if message.is_empty() {
            return Err(GitError::EmptyMessage);
        }
        if self.status(root)?.staged_count() == 0 {
            return Err(GitError::NothingStaged);
        }
        let output = self.ok(root, &args::commit(message), QUICK)?;
        Ok(output
            .stdout_text()
            .lines()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("Committed.")
            .trim()
            .to_string())
    }

    pub fn identity(&self, root: &Path) -> Result<Identity, GitError> {
        let read = |key: &str| -> Result<Option<String>, GitError> {
            let output = self.run(root, &args::config_get(key), QUICK, true)?;
            let value = output.stdout_text().trim().to_string();
            Ok((output.success() && !value.is_empty()).then_some(value))
        };
        Ok(Identity {
            name: read("user.name")?,
            email: read("user.email")?,
        })
    }

    /// Saves the author name and email in this repository's own config.
    pub fn set_identity(&self, root: &Path, name: &str, email: &str) -> Result<(), GitError> {
        let (name, email) = (name.trim(), email.trim());
        let bad = |text: &str| text.is_empty() || text.chars().any(char::is_control);
        if bad(name) || bad(email) || !email.contains('@') {
            return Err(GitError::InvalidIdentity);
        }
        self.ok(root, &args::config_set("user.name", name), QUICK)?;
        self.ok(root, &args::config_set("user.email", email), QUICK)
            .map(drop)
    }

    // --- Diff ---

    /// The two sides of one file's diff: working tree against the index, or
    /// (`staged`) the index against HEAD.
    pub fn diff_sides(&self, root: &Path, path: &str, staged: bool) -> Result<DiffSides, GitError> {
        let relative = repo_relative(path)?;
        let status = self.status(root)?;
        let change = status
            .changes
            .iter()
            .find(|change| change.path == relative)
            .ok_or_else(|| GitError::Failed(format!("{relative} has no changes.")))?;
        let (original, modified) = if staged {
            self.staged_sides(root, change)?
        } else {
            self.worktree_sides(root, change)?
        };
        build_sides(relative, original, modified)
    }

    fn blob(&self, root: &Path, spec: &str) -> Result<Vec<u8>, GitError> {
        let output = self.run(root, &args::cat_blob(spec), QUICK, false)?;
        if output.success() {
            Ok(output.stdout)
        } else {
            Err(failure(&output))
        }
    }

    fn staged_sides(&self, root: &Path, change: &FileChange) -> Result<Sides, GitError> {
        let old_path = change.orig_path.as_deref().unwrap_or(&change.path);
        let original = match change.index {
            ChangeKind::Added => None,
            _ => Some(self.blob(root, &format!("HEAD:{old_path}"))?),
        };
        let modified = match change.index {
            ChangeKind::Deleted => None,
            _ => Some(self.blob(root, &format!(":{}", change.path))?),
        };
        Ok((original, modified))
    }

    fn worktree_sides(&self, root: &Path, change: &FileChange) -> Result<Sides, GitError> {
        let original = if change.is_untracked() {
            None
        } else {
            Some(self.blob(root, &format!(":{}", change.path))?)
        };
        let modified = if change.worktree == ChangeKind::Deleted {
            None
        } else {
            Some(read_worktree_file(root, &change.path)?)
        };
        Ok((original, modified))
    }

    // --- Branches ---

    pub fn branches(&self, root: &Path) -> Result<Vec<Branch>, GitError> {
        let output = self.ok(root, &args::list_branches(), QUICK)?;
        Ok(output
            .stdout_text()
            .lines()
            .filter_map(|line| {
                let mut parts = line.split('\t');
                let head = parts.next()?;
                let name = parts.next()?.to_string();
                let upstream = parts.next().filter(|text| !text.is_empty());
                Some(Branch {
                    name,
                    current: head.trim() == "*",
                    upstream: upstream.map(str::to_string),
                })
            })
            .collect())
    }

    fn checked_branch(&self, root: &Path, name: &str) -> Result<String, GitError> {
        let name = args::validate_branch_syntax(name.trim())?.to_string();
        let output = self.run(root, &args::check_branch_name(&name), QUICK, true)?;
        if output.success() {
            Ok(name)
        } else {
            Err(GitError::InvalidBranchName(name))
        }
    }

    /// Switches branch. Never forced: if local changes would be overwritten,
    /// Git's own refusal is the error.
    pub fn switch_branch(&self, root: &Path, name: &str) -> Result<(), GitError> {
        let name = self.checked_branch(root, name)?;
        self.ok(root, &args::switch_branch(&name), QUICK).map(drop)
    }

    pub fn create_branch(&self, root: &Path, name: &str) -> Result<(), GitError> {
        let name = self.checked_branch(root, name)?;
        self.ok(root, &args::create_branch(&name), QUICK).map(drop)
    }

    pub fn delete_branch(&self, root: &Path, name: &str, confirmed: bool) -> Result<(), GitError> {
        require_confirmed(confirmed, "Deleting a branch")?;
        let name = self.checked_branch(root, name)?;
        self.ok(root, &args::delete_branch(&name), QUICK).map(drop)
    }

    // --- Remote ---

    pub fn fetch(&self, root: &Path) -> Result<String, GitError> {
        self.remote(root, &args::fetch())
    }

    pub fn pull(&self, root: &Path) -> Result<String, GitError> {
        self.remote(root, &args::pull())
    }

    pub fn push(&self, root: &Path) -> Result<String, GitError> {
        self.remote(root, &args::push())
    }

    fn remote(&self, root: &Path, args: &[String]) -> Result<String, GitError> {
        let output = self.ok(root, args, REMOTE)?;
        let text = format!("{}\n{}", output.stdout_text().trim(), output.stderr);
        Ok(text.trim().to_string())
    }
}

/// At most `max` bytes of `text`, cut on a character boundary.
fn shorten(text: &str, max: usize) -> String {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

fn checked(paths: &[String]) -> Result<Vec<String>, GitError> {
    if paths.is_empty() {
        return Err(GitError::InvalidPath(String::new()));
    }
    paths.iter().map(|path| repo_relative(path)).collect()
}

fn read_worktree_file(root: &Path, relative: &str) -> Result<Vec<u8>, GitError> {
    if crosses_symlink(root, relative) {
        return Err(GitError::OutsideRepository(relative.to_string()));
    }
    let path = absolute_in(root, relative);
    let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    if size as usize > MAX_DIFF_BYTES {
        return Err(GitError::Failed("File is too large to diff.".into()));
    }
    std::fs::read(&path).map_err(|err| GitError::Failed(format!("Couldn't read {relative}: {err}")))
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|byte| *byte == 0)
}

fn text_of(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

fn build_sides(
    path: String,
    original: Option<Vec<u8>>,
    modified: Option<Vec<u8>>,
) -> Result<DiffSides, GitError> {
    let sides = [original.as_deref(), modified.as_deref()];
    if sides
        .iter()
        .flatten()
        .any(|bytes| bytes.len() > MAX_DIFF_BYTES)
    {
        return Err(GitError::Failed("File is too large to diff.".into()));
    }
    if sides.iter().flatten().any(|bytes| looks_binary(bytes)) {
        return Ok(DiffSides {
            path,
            original: None,
            modified: None,
            binary: true,
        });
    }
    Ok(DiffSides {
        path,
        original: original.as_deref().map(text_of),
        modified: modified.as_deref().map(text_of),
        binary: false,
    })
}

/// Turns a failed command into the message the user sees.
fn failure(output: &Output) -> GitError {
    let text = if output.stderr.trim().is_empty() {
        output.stdout_text().trim().to_string()
    } else {
        output.stderr.trim().to_string()
    };
    let lower = text.to_ascii_lowercase();
    if lower.contains("not a git repository") {
        GitError::NotARepository
    } else if lower.contains("terminal prompts disabled")
        || lower.contains("could not read username")
        || lower.contains("could not read password")
        || lower.contains("authentication failed")
    {
        GitError::NeedsCredentials
    } else if text.is_empty() {
        GitError::Failed(format!(
            "Git failed with exit code {}.",
            output
                .code
                .map_or("unknown".to_string(), |code| code.to_string())
        ))
    } else {
        GitError::Failed(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out(code: i32, stdout: &str, stderr: &str) -> Output {
        Output {
            code: Some(code),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.to_string(),
        }
    }

    #[test]
    fn destructive_calls_without_confirmation_are_refused() {
        assert_eq!(
            require_confirmed(false, "Discarding changes"),
            Err(GitError::NotConfirmed("Discarding changes"))
        );
        assert_eq!(
            GitError::NotConfirmed("Deleting a file").to_string(),
            "Deleting a file needs confirmation."
        );
        assert!(require_confirmed(true, "x").is_ok());
    }

    #[test]
    fn failures_are_worded_for_the_user() {
        assert_eq!(
            failure(&out(
                128,
                "",
                "fatal: not a git repository (or any of the parent directories): .git"
            )),
            GitError::NotARepository
        );
        assert_eq!(
            failure(&out(
                128,
                "",
                "fatal: could not read Username for 'https://x': terminal prompts disabled"
            )),
            GitError::NeedsCredentials
        );
        assert_eq!(
            failure(&out(
                1,
                "",
                "error: Your local changes would be overwritten by checkout"
            )),
            GitError::Failed("error: Your local changes would be overwritten by checkout".into())
        );
        assert_eq!(
            failure(&out(1, "", "")),
            GitError::Failed("Git failed with exit code 1.".into())
        );
    }

    #[test]
    fn binary_files_are_reported_not_decoded() {
        let sides = build_sides("a.bin".into(), None, Some(vec![1, 2, 0, 3])).unwrap();
        assert!(sides.binary && sides.original.is_none() && sides.modified.is_none());
    }

    #[test]
    fn text_sides_keep_added_and_deleted_as_none_and_drop_a_bom() {
        let added = build_sides("a.txt".into(), None, Some(b"\xEF\xBB\xBFhello".to_vec())).unwrap();
        assert_eq!(added.original, None);
        assert_eq!(added.modified.as_deref(), Some("hello"));
        let deleted = build_sides("a.txt".into(), Some(b"bye".to_vec()), None).unwrap();
        assert_eq!(
            (deleted.original.as_deref(), deleted.modified),
            (Some("bye"), None)
        );
    }

    #[test]
    fn oversized_files_are_refused() {
        let big = vec![b'a'; MAX_DIFF_BYTES + 1];
        assert_eq!(
            build_sides("big.txt".into(), Some(big), None),
            Err(GitError::Failed("File is too large to diff.".into()))
        );
    }

    #[test]
    fn checked_paths_reject_empty_lists_and_traversal() {
        assert!(checked(&[]).is_err());
        assert!(checked(&["../x".to_string()]).is_err());
        assert_eq!(
            checked(&["a b\\c.txt".to_string()]).unwrap(),
            vec!["a b/c.txt".to_string()]
        );
    }
}
