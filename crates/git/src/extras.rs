//! Clone, history, blame and stash — the second half of [`GitClient`].
//! Same rules as the first: argument lists only, every path checked, and
//! nothing destructive without `confirmed`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::args;
use crate::blame::{parse_blame, BlameLine};
use crate::client::{build_sides, read_worktree_file, require_confirmed, DiffSides, GitClient};
use crate::clone::{validate_destination, validate_url};
use crate::error::GitError;
use crate::history::{is_hash, parse_log, parse_name_status, Commit, CommitFile};
use crate::path::{relative_to_root, repo_relative};
use crate::stash::{parse_stash_list, reference, validate_message, StashEntry};

const QUICK: Duration = Duration::from_secs(30);
/// A clone can be big: ten minutes.
const CLONE: Duration = Duration::from_secs(600);
/// The most commits the History panel asks for.
pub const MAX_HISTORY: u32 = 200;
/// Blame refuses files bigger than this.
const MAX_BLAME_BYTES: u64 = 2 * 1024 * 1024;

impl GitClient {
    // --- Clone ---

    /// Clones `url` into `<parent>/<name>`. The destination must be new or an
    /// empty folder (nothing is ever overwritten). No credentials are stored:
    /// a remote that needs them fails with a clear message. Returns the folder.
    pub fn clone_repository(
        &self,
        url: &str,
        parent: &Path,
        name: &str,
    ) -> Result<PathBuf, GitError> {
        let url = validate_url(url)?;
        let target = validate_destination(parent, name)?;
        let dest = target.to_string_lossy().into_owned();
        self.ok(parent, &args::clone(&url, &dest), CLONE)?;
        Ok(target)
    }

    // --- History ---

    /// The newest commits of the current branch (none for a repository without commits).
    pub fn history(&self, root: &Path, limit: u32) -> Result<Vec<Commit>, GitError> {
        let output = self.run(root, &args::log(limit.clamp(1, MAX_HISTORY)), QUICK, false)?;
        if output.success() {
            return Ok(parse_log(&output.stdout));
        }
        let text = output.stderr.to_ascii_lowercase();
        if text.contains("does not have any commits") || text.contains("unknown revision") {
            return Ok(Vec::new());
        }
        Err(GitError::Failed(output.stderr))
    }

    /// The files one commit changed.
    pub fn commit_files(&self, root: &Path, hash: &str) -> Result<Vec<CommitFile>, GitError> {
        let hash = checked_hash(hash)?;
        let output = self.ok(root, &args::show_files(&hash), QUICK)?;
        Ok(parse_name_status(&output.stdout))
    }

    /// Both sides of one file's diff in a commit (against its first parent).
    pub fn commit_diff_sides(
        &self,
        root: &Path,
        hash: &str,
        file: &CommitFile,
    ) -> Result<DiffSides, GitError> {
        let hash = checked_hash(hash)?;
        let path = repo_relative(&file.path)?;
        let old_path = match &file.orig_path {
            Some(old) => repo_relative(old)?,
            None => path.clone(),
        };
        let original = if file.status == "A" {
            None
        } else {
            Some(self.blob(root, &format!("{hash}^:{old_path}"))?)
        };
        let modified = if file.status == "D" {
            None
        } else {
            Some(self.blob(root, &format!("{hash}:{path}"))?)
        };
        build_sides(path, original, modified)
    }

    // --- Blame ---

    /// Who last changed each line of a tracked file. `absolute` may be an
    /// absolute path inside the repository or a repo-relative one.
    pub fn blame(&self, root: &Path, file: &str) -> Result<Vec<BlameLine>, GitError> {
        let relative = if Path::new(file).is_absolute() || file.contains(':') {
            relative_to_root(root, file)?
        } else {
            repo_relative(file)?
        };
        let tracked = self.run(root, &args::ls_files(&relative), QUICK, false)?;
        if !tracked.success() {
            return Err(GitError::NotBlamable(
                "This file is untracked — it has no history to blame.".into(),
            ));
        }
        let bytes = read_worktree_file_limited(root, &relative)?;
        if bytes.iter().take(8000).any(|byte| *byte == 0) {
            return Err(GitError::NotBlamable(
                "Binary files can't be blamed.".into(),
            ));
        }
        let output = self.run(root, &args::blame(&relative), QUICK, false)?;
        if !output.success() {
            let text = output.stderr.to_ascii_lowercase();
            return Err(
                if text.contains("no such path") || text.contains("no such ref") {
                    GitError::NotBlamable("This file has no commits yet — commit it first.".into())
                } else {
                    GitError::Failed(output.stderr)
                },
            );
        }
        Ok(parse_blame(&output.stdout))
    }

    // --- Stash ---

    pub fn stash_list(&self, root: &Path) -> Result<Vec<StashEntry>, GitError> {
        let output = self.ok(root, &args::stash_list(), QUICK)?;
        Ok(parse_stash_list(&output.stdout))
    }

    /// Stashes the changes to tracked files (and, if asked, untracked ones),
    /// leaving a clean working tree. Returns the message Git printed.
    pub fn stash_push(
        &self,
        root: &Path,
        message: &str,
        include_untracked: bool,
    ) -> Result<String, GitError> {
        let message = validate_message(message)?;
        let status = self.status(root)?;
        let tracked = status.changes.iter().any(|change| !change.is_untracked());
        let untracked = status.changes.iter().any(|change| change.is_untracked());
        if !tracked && !(include_untracked && untracked) {
            return Err(GitError::Failed(if untracked {
                "Only untracked files changed. Tick \"Include untracked files\" to stash them."
                    .into()
            } else {
                "There are no local changes to stash.".into()
            }));
        }
        let output = self.ok(root, &args::stash_push(&message, include_untracked), QUICK)?;
        Ok(output.stdout_text().trim().to_string())
    }

    /// Applies a stash and keeps it. Conflicts are reported, never resolved.
    pub fn stash_apply(&self, root: &Path, index: u32) -> Result<String, GitError> {
        let output = self.ok(root, &args::stash_apply(&reference(index)), QUICK)?;
        Ok(output.stdout_text().trim().to_string())
    }

    /// Applies a stash and drops it (Git keeps it if applying conflicts).
    pub fn stash_pop(&self, root: &Path, index: u32) -> Result<String, GitError> {
        let output = self.ok(root, &args::stash_pop(&reference(index)), QUICK)?;
        Ok(output.stdout_text().trim().to_string())
    }

    /// Deletes a stash for good — only when confirmed.
    pub fn stash_drop(&self, root: &Path, index: u32, confirmed: bool) -> Result<(), GitError> {
        require_confirmed(confirmed, "Dropping a stash")?;
        self.ok(root, &args::stash_drop(&reference(index)), QUICK)
            .map(drop)
    }
}

fn checked_hash(hash: &str) -> Result<String, GitError> {
    if is_hash(hash) {
        Ok(hash.to_string())
    } else {
        Err(GitError::InvalidCommit(hash.to_string()))
    }
}

fn read_worktree_file_limited(root: &Path, relative: &str) -> Result<Vec<u8>, GitError> {
    let path = crate::path::absolute_in(root, relative);
    match std::fs::metadata(&path) {
        Ok(meta) if meta.len() > MAX_BLAME_BYTES => Err(GitError::NotBlamable(
            "This file is too large to blame.".into(),
        )),
        Ok(_) => read_worktree_file(root, relative),
        Err(_) => Err(GitError::NotBlamable(
            "This file doesn't exist on disk.".into(),
        )),
    }
}
