//! The per-file Git operations behind the editor's context menu — a file's history (renames followed, page by page),
//! a file's text at any revision, the branches and tags to compare with, the remotes and whether a commit is
//! published, and one commit's details. The third `impl GitClient`; same rules as the others: argument lists only,
//! paths after `--`, revisions checked before they reach Git, nothing written.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;

use crate::client::{looks_binary, text_of, GitClient};
use crate::error::GitError;
use crate::filelog::{
    file_log_format, is_revision, parse_file_log, parse_refs, parse_remote_config, refs_format,
    FileLogPage, GitRef, Remote, FIELD,
};
use crate::history::{is_hash, CommitFile};
use crate::path::repo_relative;

const QUICK: Duration = Duration::from_secs(30);
/// A history page is at most this many commits.
pub const MAX_FILE_LOG_PAGE: u32 = 500;
/// How far back a file's history can be paged.
pub const MAX_FILE_LOG_DEPTH: u32 = 20_000;
/// A revision's text bigger than this isn't shown (the editor would stall).
const MAX_REVISION_BYTES: usize = 5 * 1024 * 1024;

/// A file's text at one revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionText {
    /// `None`: the file doesn't exist in that revision.
    pub text: Option<String>,
}

/// The remotes of a repository and where its checkout stands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub remotes: Vec<Remote>,
    /// The checked-out branch (`None` when HEAD is detached or there are no commits).
    pub branch: Option<String>,
    /// The branch's upstream, e.g. `origin/main`.
    pub upstream: Option<String>,
    /// The checked-out commit (`None` before the first commit).
    pub head: Option<String>,
}

/// One commit in full, for the commit details view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub author_email: String,
    pub author_time: i64,
    pub committer: String,
    pub committer_email: String,
    pub commit_time: i64,
    /// The whole message (subject and body).
    pub message: String,
    pub files: Vec<CommitFile>,
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_string()).collect()
}

fn checked_revision(revision: &str) -> Result<&str, GitError> {
    if is_revision(revision) {
        Ok(revision)
    } else {
        Err(GitError::InvalidCommit(revision.to_string()))
    }
}

impl GitClient {
    /// One page of the commits that changed `file` (repo-relative), newest first, following renames.
    pub fn file_log(
        &self,
        root: &Path,
        file: &str,
        skip: u32,
        limit: u32,
    ) -> Result<FileLogPage, GitError> {
        let relative = repo_relative(file)?;
        let limit = limit.clamp(1, MAX_FILE_LOG_PAGE);
        let mut args = strings(&[
            "-c",
            "core.quotePath=false",
            "--literal-pathspecs",
            "log",
            "--follow",
            "-M",
        ]);
        args.push(file_log_format());
        args.push("--numstat".into());
        // `--skip` doesn't work together with `--follow` (Git applies it before following renames), so the page is
        // cut out here; a history can be paged to `MAX_FILE_LOG_DEPTH` commits.
        let skip = skip.min(MAX_FILE_LOG_DEPTH);
        args.push(format!("--max-count={}", skip + limit + 1));
        args.push("--".into());
        args.push(relative);
        let output = self.run(root, &args, QUICK, false)?;
        if !output.success() {
            let text = output.stderr.to_ascii_lowercase();
            if text.contains("does not have any commits") || text.contains("unknown revision") {
                return Ok(FileLogPage {
                    commits: Vec::new(),
                    more: false,
                });
            }
            return Err(GitError::Failed(output.stderr.trim().to_string()));
        }
        let mut commits: Vec<_> = parse_file_log(&output.stdout)
            .into_iter()
            .skip(skip as usize)
            .collect();
        let more = commits.len() > limit as usize;
        commits.truncate(limit as usize);
        Ok(FileLogPage { commits, more })
    }

    /// The text of `file` (repo-relative) at `revision`; `text: None` when the file isn't in that revision.
    pub fn file_at(
        &self,
        root: &Path,
        revision: &str,
        file: &str,
    ) -> Result<RevisionText, GitError> {
        let revision = checked_revision(revision)?;
        let relative = repo_relative(file)?;
        let output = self.run(
            root,
            &strings(&["cat-file", "blob", &format!("{revision}:{relative}")]),
            QUICK,
            false,
        )?;
        if !output.success() {
            let text = output.stderr.to_ascii_lowercase();
            if text.contains("does not exist")
                || text.contains("not a valid object name")
                || text.contains("exists on disk, but not in")
                || text.contains("invalid object name")
            {
                return Ok(RevisionText { text: None });
            }
            return Err(GitError::Failed(output.stderr.trim().to_string()));
        }
        if output.stdout.len() > MAX_REVISION_BYTES {
            return Err(GitError::Failed(
                "This revision of the file is too large to show.".into(),
            ));
        }
        if looks_binary(&output.stdout) {
            return Err(GitError::Failed("Binary files can't be compared.".into()));
        }
        Ok(RevisionText {
            text: Some(text_of(&output.stdout)),
        })
    }

    /// Whether Git tracks `file` (repo-relative).
    pub fn is_tracked(&self, root: &Path, file: &str) -> Result<bool, GitError> {
        let relative = repo_relative(file)?;
        let output = self.run(root, &crate::args::ls_files(&relative), QUICK, false)?;
        Ok(output.success())
    }

    /// Branches, remote-tracking branches and tags, most recent first.
    pub fn refs(&self, root: &Path) -> Result<Vec<GitRef>, GitError> {
        let mut args = strings(&["for-each-ref", "--sort=-committerdate"]);
        args.push(refs_format());
        args.extend(strings(&["refs/heads", "refs/remotes", "refs/tags"]));
        let output = self.ok(root, &args, QUICK)?;
        Ok(parse_refs(&output.stdout))
    }

    /// Remotes, the checked-out branch, its upstream and HEAD.
    pub fn remote_info(&self, root: &Path) -> Result<RemoteInfo, GitError> {
        // The configured addresses, not `git remote -v`'s rewritten ones (see `parse_remote_config`). Exit code 1 =
        // no remote is configured.
        let config = self.run(
            root,
            &strings(&["config", "--get-regexp", r"^remote\..*\.url$"]),
            QUICK,
            false,
        )?;
        let remotes = if config.success() {
            parse_remote_config(&config.stdout)
        } else {
            Vec::new()
        };
        let line = |args: &[&str]| -> Result<Option<String>, GitError> {
            let output = self.run(root, &strings(args), QUICK, false)?;
            Ok(output
                .success()
                .then(|| output.stdout_text().trim().to_string())
                .filter(|text| !text.is_empty()))
        };
        let head = line(&["rev-parse", "--verify", "-q", "HEAD"])?.filter(|hash| is_hash(hash));
        let branch = line(&["symbolic-ref", "-q", "--short", "HEAD"])?;
        let upstream = match &branch {
            Some(_) => line(&[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ])?,
            None => None,
        };
        Ok(RemoteInfo {
            remotes,
            branch,
            upstream,
            head,
        })
    }

    /// The remote-tracking branches that contain `hash` (empty: the commit isn't pushed anywhere Git knows of).
    pub fn remote_branches_containing(
        &self,
        root: &Path,
        hash: &str,
    ) -> Result<Vec<String>, GitError> {
        if !is_hash(hash) {
            return Err(GitError::InvalidCommit(hash.to_string()));
        }
        let output = self.run(
            root,
            &strings(&[
                "branch",
                "-r",
                "--contains",
                hash,
                "--format=%(refname:short)",
            ]),
            QUICK,
            false,
        )?;
        if !output.success() {
            // A commit Git doesn't know (yet) is simply in no remote branch.
            return Ok(Vec::new());
        }
        Ok(output
            .stdout_text()
            .lines()
            .map(str::trim)
            .filter(|name| !name.is_empty() && !name.ends_with("/HEAD") && !name.contains(' '))
            .map(str::to_string)
            .collect())
    }

    /// The full commit id `revision` points at (`None` when it points at nothing).
    pub fn resolve_revision(
        &self,
        root: &Path,
        revision: &str,
    ) -> Result<Option<String>, GitError> {
        let revision = checked_revision(revision)?;
        let output = self.run(
            root,
            &strings(&[
                "rev-parse",
                "--verify",
                "-q",
                &format!("{revision}^{{commit}}"),
            ]),
            QUICK,
            false,
        )?;
        let text = output.stdout_text().trim().to_string();
        Ok((output.success() && is_hash(&text)).then_some(text))
    }

    /// Everything about one commit: people, times, the whole message and the files it changed.
    pub fn commit_details(&self, root: &Path, hash: &str) -> Result<CommitDetails, GitError> {
        if !is_hash(hash) {
            return Err(GitError::InvalidCommit(hash.to_string()));
        }
        let output = self.ok(
            root,
            &strings(&[
                "show",
                "-s",
                "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B",
                hash,
            ]),
            QUICK,
        )?;
        let text = output.stdout_text();
        let mut fields = text.splitn(9, FIELD);
        let mut next = || fields.next().unwrap_or_default().to_string();
        let full = next();
        if !is_hash(&full) {
            return Err(GitError::InvalidCommit(hash.to_string()));
        }
        let parents = next()
            .split(' ')
            .filter(|p| is_hash(p))
            .map(str::to_string)
            .collect();
        let (author, author_email, author_time) = (next(), next(), next().parse().unwrap_or(0));
        let (committer, committer_email, commit_time) =
            (next(), next(), next().parse().unwrap_or(0));
        let message = next().trim_end().to_string();
        let files = self.commit_files(root, &full)?;
        Ok(CommitDetails {
            hash: full,
            parents,
            author,
            author_email,
            author_time,
            committer,
            committer_email,
            commit_time,
            message,
            files,
        })
    }
}
