//! Parsers for the per-file Git views: a file's history (`git log --follow --numstat`), the repository's branches and
//! tags (`git for-each-ref`) and its remotes (`git remote -v`). Pure functions over Git's output, so every format is
//! tested without a repository.

use serde::Serialize;

use crate::history::is_hash;

/// Starts one record of [`file_log_format`] (record separator).
pub const RECORD: char = '\u{1e}';
/// Separates the fields of one record (unit separator).
pub const FIELD: char = '\u{1f}';

/// One commit that changed a file, with the file's name in that commit (renames are followed).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCommit {
    pub hash: String,
    pub short_hash: String,
    /// Parent ids as Git rewrote them for this file's history (what the graph connects).
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    /// Author time, seconds since the Unix epoch.
    pub author_time: i64,
    pub committer: String,
    pub commit_time: i64,
    pub subject: String,
    /// The file's repo-relative name in this commit (`None` when Git printed no change line, e.g. a merge).
    pub path: Option<String>,
    /// Lines added / removed in this file (`None` for binary files and merges).
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

/// One page of a file's history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileLogPage {
    pub commits: Vec<FileCommit>,
    /// More commits exist after this page.
    pub more: bool,
}

/// `--format` of the file history: one record per commit, fields separated by `FIELD`.
pub fn file_log_format() -> String {
    "--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%s".to_string()
}

/// Parses `git log --follow --numstat` printed with [`file_log_format`].
pub fn parse_file_log(output: &[u8]) -> Vec<FileCommit> {
    String::from_utf8_lossy(output)
        .split(RECORD)
        .filter_map(parse_record)
        .collect()
}

fn parse_record(record: &str) -> Option<FileCommit> {
    let mut lines = record.lines();
    let header = lines.next()?;
    let mut fields = header.split(FIELD);
    let hash = fields
        .next()
        .filter(|hash| hash.len() == 40 && is_hash(hash))?;
    let parents = fields
        .next()?
        .split(' ')
        .filter(|parent| is_hash(parent))
        .map(str::to_string)
        .collect();
    let author = fields.next()?.to_string();
    let email = fields.next()?.to_string();
    let author_time = fields.next()?.parse().unwrap_or(0);
    let committer = fields.next()?.to_string();
    let commit_time = fields.next()?.parse().unwrap_or(0);
    let subject = fields.next().unwrap_or_default().to_string();
    let stat = lines.find_map(parse_numstat);
    Some(FileCommit {
        hash: hash.to_string(),
        short_hash: hash[..7].to_string(),
        parents,
        author,
        email,
        author_time,
        committer,
        commit_time,
        subject,
        path: stat.as_ref().map(|(_, _, path)| path.clone()),
        additions: stat.as_ref().and_then(|(added, _, _)| *added),
        deletions: stat.as_ref().and_then(|(_, removed, _)| *removed),
    })
}

/// `12\t3\tpath`, `-\t-\tbinary`, `0\t0\told => new`, `1\t1\tsrc/{a => b}/f.txt`.
fn parse_numstat(line: &str) -> Option<(Option<u32>, Option<u32>, String)> {
    let mut parts = line.splitn(3, '\t');
    let added = parts.next()?;
    let removed = parts.next()?;
    let path = parts.next()?;
    let count = |text: &str| -> Option<Option<u32>> {
        if text == "-" {
            Some(None)
        } else {
            text.parse().ok().map(Some)
        }
    };
    Some((count(added)?, count(removed)?, renamed_target(path)))
}

/// The new name in Git's rename notation (`old => new`, `dir/{a => b}/f`); other names unchanged.
pub fn renamed_target(path: &str) -> String {
    if let (Some(open), Some(close)) = (path.find('{'), path.rfind('}')) {
        if open < close {
            let inner = &path[open + 1..close];
            if let Some((_, new)) = inner.split_once(" => ") {
                let joined = format!("{}{}{}", &path[..open], new, &path[close + 1..]);
                // `{ => b}` and `{a => }` leave a doubled or leading slash behind.
                return joined
                    .replace("//", "/")
                    .trim_start_matches('/')
                    .to_string();
            }
        }
    }
    match path.split_once(" => ") {
        Some((_, new)) => new.to_string(),
        None => path.to_string(),
    }
}

/// What kind of name a [`GitRef`] is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    Branch,
    Remote,
    Tag,
}

/// A branch, remote-tracking branch or tag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRef {
    /// Short name (`main`, `origin/main`, `v1.0`).
    pub name: String,
    pub kind: RefKind,
    /// The commit it points at (a tag is peeled to its commit).
    pub hash: String,
    /// Commit time of that commit, seconds since the Unix epoch.
    pub time: i64,
}

/// `--format` of [`parse_refs`]: full name, commit (peeled for annotated tags), commit time.
pub fn refs_format() -> String {
    "--format=%(refname)%1f%(objectname)%1f%(*objectname)%1f%(committerdate:unix)%1f%(*committerdate:unix)"
        .to_string()
}

/// Parses `git for-each-ref` printed with [`refs_format`] (`%1f` = the unit separator).
pub fn parse_refs(output: &[u8]) -> Vec<GitRef> {
    String::from_utf8_lossy(output)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split(FIELD);
            let full = fields.next()?;
            let object = fields.next()?;
            let peeled = fields.next().unwrap_or_default();
            let time = fields.next().unwrap_or_default();
            let peeled_time = fields.next().unwrap_or_default();
            let (kind, name) = if let Some(name) = full.strip_prefix("refs/heads/") {
                (RefKind::Branch, name)
            } else if let Some(name) = full.strip_prefix("refs/remotes/") {
                (RefKind::Remote, name)
            } else {
                (RefKind::Tag, full.strip_prefix("refs/tags/")?)
            };
            // `origin/HEAD` is an alias of another remote branch, not a branch of its own.
            if kind == RefKind::Remote && name.ends_with("/HEAD") {
                return None;
            }
            let hash = if is_hash(peeled) { peeled } else { object };
            if hash.len() != 40 || !is_hash(hash) || !is_ref_name(name) {
                return None;
            }
            let time = if peeled_time.is_empty() {
                time
            } else {
                peeled_time
            };
            Some(GitRef {
                name: name.to_string(),
                kind,
                hash: hash.to_string(),
                time: time.parse().unwrap_or(0),
            })
        })
        .collect()
}

/// A configured remote and the address it fetches from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub name: String,
    pub url: String,
}

/// Parses `git config --get-regexp ^remote\..*\.url$` (`remote.<name>.url <address>` per line): the addresses as the
/// user configured them. (`git remote -v` prints them after `url.*.insteadOf` rewriting, and the app's download
/// gateway rewrites every https remote to a loopback address for the processes it starts.) A remote listed twice
/// keeps its first address.
pub fn parse_remote_config(output: &[u8]) -> Vec<Remote> {
    let mut remotes: Vec<Remote> = Vec::new();
    for line in String::from_utf8_lossy(output).lines() {
        let Some((key, url)) = line.split_once(' ') else {
            continue;
        };
        let Some(name) = key
            .strip_prefix("remote.")
            .and_then(|rest| rest.strip_suffix(".url"))
        else {
            continue;
        };
        let url = url.trim();
        if name.is_empty() || url.is_empty() || remotes.iter().any(|remote| remote.name == name) {
            continue;
        }
        remotes.push(Remote {
            name: name.to_string(),
            url: url.to_string(),
        });
    }
    remotes
}

/// A revision OpenMind may hand to Git: a commit id, `HEAD` (with `~n`/`^`), or a branch / tag name as
/// `for-each-ref` lists them. Never an option (`-x`), a range (`a..b`), a path spec (`a:b`) or a reflog query.
pub fn is_revision(text: &str) -> bool {
    // An ancestor suffix (`~2`, `^`, `^^`, `~1^2`) may follow any base.
    let (base, suffix) = match text.find(['~', '^']) {
        Some(index) => text.split_at(index),
        None => (text, ""),
    };
    let suffix_ok = suffix
        .chars()
        .all(|c| c == '~' || c == '^' || c.is_ascii_digit())
        && !suffix.starts_with(|c: char| c.is_ascii_digit());
    suffix_ok && (base == "HEAD" || is_hash(base) || is_ref_name(base))
}

/// A branch, remote branch or tag name in the shape `git check-ref-format` allows, without anything Git would
/// read as an option or a revision expression.
pub fn is_ref_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && !name.starts_with('-')
        && !name.starts_with('/')
        && !name.ends_with('/')
        && !name.ends_with('.')
        && !name.ends_with(".lock")
        && !name.contains("..")
        && !name.contains("//")
        && !name.contains("@{")
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | '+' | '@' | '#'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(hash: char, parents: &str, subject: &str, stat: &str) -> String {
        let hash = hash.to_string().repeat(40);
        format!(
            "{RECORD}{hash}{FIELD}{parents}{FIELD}Ada Lovelace{FIELD}ada@x.io{FIELD}1700000000{FIELD}Ada{FIELD}1700000100{FIELD}{subject}\n\n{stat}\n"
        )
    }

    #[test]
    fn parses_a_followed_history_with_a_rename_and_a_binary_change() {
        let b = "b".repeat(40);
        let output = format!(
            "{}{}{}",
            record(
                'a',
                &b,
                "rename it",
                "0\t0\tsrc/{old name.txt => new name.txt}"
            ),
            record('b', "", "first: ünïcode", "3\t0\tsrc/old name.txt"),
            record('c', "", "binary", "-\t-\tlogo.png"),
        );
        let commits = parse_file_log(output.as_bytes());
        assert_eq!(commits.len(), 3);
        assert_eq!(commits[0].path.as_deref(), Some("src/new name.txt"));
        assert_eq!(commits[0].parents, vec![b]);
        assert_eq!(commits[0].short_hash, "aaaaaaa");
        assert_eq!(commits[1].path.as_deref(), Some("src/old name.txt"));
        assert_eq!(commits[1].additions, Some(3));
        assert_eq!(commits[1].subject, "first: ünïcode");
        assert_eq!(commits[1].author_time, 1_700_000_000);
        assert_eq!(commits[1].commit_time, 1_700_000_100);
        assert!(commits[1].parents.is_empty());
        assert_eq!(commits[2].additions, None);
    }

    #[test]
    fn a_merge_without_a_change_line_still_lists_the_commit() {
        let output = record(
            'd',
            &format!("{} {}", "e".repeat(40), "f".repeat(40)),
            "merge",
            "",
        );
        let commits = parse_file_log(output.as_bytes());
        assert_eq!(commits[0].parents.len(), 2);
        assert_eq!(commits[0].path, None);
        assert!(parse_file_log(b"garbage").is_empty());
    }

    #[test]
    fn rename_notation_gives_the_new_name() {
        assert_eq!(renamed_target("a.txt => b.txt"), "b.txt");
        assert_eq!(renamed_target("src/{a => b}/f.txt"), "src/b/f.txt");
        assert_eq!(renamed_target("src/{ => sub}/f.txt"), "src/sub/f.txt");
        assert_eq!(renamed_target("{lib => }/f.txt"), "f.txt");
        assert_eq!(renamed_target("plain name.txt"), "plain name.txt");
    }

    #[test]
    fn parses_branches_remote_branches_and_peeled_tags() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let t = "c".repeat(40);
        let output = format!(
            "refs/heads/main\u{1f}{a}\u{1f}\u{1f}1700000000\u{1f}\nrefs/remotes/origin/HEAD\u{1f}{a}\u{1f}\u{1f}1\u{1f}\nrefs/remotes/origin/feature/x\u{1f}{b}\u{1f}\u{1f}1700000001\u{1f}\nrefs/tags/v1.0\u{1f}{t}\u{1f}{a}\u{1f}\u{1f}1700000002\nrefs/stash\u{1f}{a}\u{1f}\u{1f}1\u{1f}\nrefs/heads/-bad\u{1f}{a}\u{1f}\u{1f}1\u{1f}\n"
        );
        let refs = parse_refs(output.as_bytes());
        assert_eq!(refs.len(), 3);
        assert_eq!(refs[0].kind, RefKind::Branch);
        assert_eq!(refs[1].name, "origin/feature/x");
        assert_eq!(refs[1].kind, RefKind::Remote);
        assert_eq!(refs[2].kind, RefKind::Tag);
        assert_eq!(refs[2].hash, a, "an annotated tag points at its commit");
        assert_eq!(refs[2].time, 1_700_000_002);
    }

    #[test]
    fn parses_configured_remote_addresses_once_each() {
        let output = b"remote.origin.url https://github.com/o/r.git\nremote.my.fork.url git@gitlab.com:g/p.git\nremote.origin.url https://other\nbroken\nremote.x.pushurl y\n";
        let remotes = parse_remote_config(output);
        assert_eq!(remotes.len(), 2);
        assert_eq!(remotes[0].url, "https://github.com/o/r.git");
        assert_eq!(remotes[1].name, "my.fork");
        assert_eq!(remotes[1].url, "git@gitlab.com:g/p.git");
    }

    #[test]
    fn only_plain_revisions_and_ref_names_are_accepted() {
        for good in [
            "HEAD",
            "HEAD~2",
            "HEAD^",
            "main",
            "origin/feature/x",
            "v1.0.0",
            "abc1234",
            "release-2026+1",
            "abc1234^",
            "main~3",
            "v1.0^2",
        ] {
            assert!(is_revision(good), "{good}");
        }
        for bad in [
            "",
            "-p",
            "--output=x",
            "a..b",
            "a...b",
            "HEAD:file",
            "main@{1}",
            "x.lock",
            "a b",
            "a//b",
            "/a",
            "name\n",
            "a\\b",
            "~1",
            "main^x",
            "HEAD~-1",
        ] {
            assert!(!is_revision(bad), "{bad:?}");
        }
    }
}
