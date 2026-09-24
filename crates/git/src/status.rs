//! Parses `git status --porcelain=v2 -z --branch` into what the Source
//! Control view shows.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Unmodified,
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Unmerged,
    Untracked,
}

impl ChangeKind {
    fn from_code(code: char) -> Self {
        match code {
            'M' => Self::Modified,
            'A' => Self::Added,
            'D' => Self::Deleted,
            'R' => Self::Renamed,
            'C' => Self::Copied,
            'T' => Self::TypeChanged,
            'U' => Self::Unmerged,
            _ => Self::Unmodified,
        }
    }
}

/// One path with its state in the index (staged) and in the working tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// The old path of a rename/copy.
    pub orig_path: Option<String>,
    pub index: ChangeKind,
    pub worktree: ChangeKind,
    pub conflicted: bool,
}

impl FileChange {
    pub fn is_staged(&self) -> bool {
        !self.conflicted && self.index != ChangeKind::Unmodified
    }

    pub fn is_untracked(&self) -> bool {
        self.worktree == ChangeKind::Untracked
    }

    /// Modified in the working tree relative to the index (not untracked).
    pub fn is_unstaged(&self) -> bool {
        !self.is_untracked() && (self.conflicted || self.worktree != ChangeKind::Unmodified)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    /// `None` while HEAD is detached.
    pub branch: Option<String>,
    pub detached: bool,
    /// `None` before the first commit.
    pub oid: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub changes: Vec<FileChange>,
}

impl RepoStatus {
    pub fn has_head(&self) -> bool {
        self.oid.is_some()
    }

    pub fn staged_count(&self) -> usize {
        self.changes
            .iter()
            .filter(|change| change.is_staged())
            .count()
    }
}

pub fn parse_status(output: &[u8]) -> RepoStatus {
    let text = String::from_utf8_lossy(output);
    let mut status = RepoStatus::default();
    let mut records = text.split('\0').filter(|record| !record.is_empty());
    while let Some(record) = records.next() {
        if let Some(header) = record.strip_prefix("# ") {
            parse_header(header, &mut status);
            continue;
        }
        let change = match record.chars().next() {
            Some('1') => parse_ordinary(record),
            Some('2') => parse_renamed(record, records.next()),
            Some('u') => parse_unmerged(record),
            Some('?') => record.strip_prefix("? ").map(|path| FileChange {
                path: path.to_string(),
                orig_path: None,
                index: ChangeKind::Unmodified,
                worktree: ChangeKind::Untracked,
                conflicted: false,
            }),
            _ => None,
        };
        status.changes.extend(change);
    }
    status
}

fn parse_header(header: &str, status: &mut RepoStatus) {
    if let Some(oid) = header.strip_prefix("branch.oid ") {
        status.oid = (oid != "(initial)").then(|| oid.to_string());
    } else if let Some(head) = header.strip_prefix("branch.head ") {
        status.detached = head == "(detached)";
        status.branch = (!status.detached).then(|| head.to_string());
    } else if let Some(upstream) = header.strip_prefix("branch.upstream ") {
        status.upstream = Some(upstream.to_string());
    } else if let Some(counts) = header.strip_prefix("branch.ab ") {
        let mut parts = counts.split(' ');
        status.ahead = number(parts.next(), '+');
        status.behind = number(parts.next(), '-');
    }
}

fn number(part: Option<&str>, sign: char) -> u32 {
    part.and_then(|text| text.strip_prefix(sign))
        .and_then(|text| text.parse().ok())
        .unwrap_or(0)
}

fn xy(record: &str) -> Option<(ChangeKind, ChangeKind)> {
    let mut codes = record.split(' ').nth(1)?.chars();
    Some((
        ChangeKind::from_code(codes.next()?),
        ChangeKind::from_code(codes.next()?),
    ))
}

fn parse_ordinary(record: &str) -> Option<FileChange> {
    let fields: Vec<&str> = record.splitn(9, ' ').collect();
    let (index, worktree) = xy(record)?;
    Some(FileChange {
        path: (*fields.get(8)?).to_string(),
        orig_path: None,
        index,
        worktree,
        conflicted: false,
    })
}

fn parse_renamed(record: &str, original: Option<&str>) -> Option<FileChange> {
    let fields: Vec<&str> = record.splitn(10, ' ').collect();
    let (index, worktree) = xy(record)?;
    Some(FileChange {
        path: (*fields.get(9)?).to_string(),
        orig_path: original.map(str::to_string),
        index,
        worktree,
        conflicted: false,
    })
}

fn parse_unmerged(record: &str) -> Option<FileChange> {
    let fields: Vec<&str> = record.splitn(11, ' ').collect();
    Some(FileChange {
        path: (*fields.get(10)?).to_string(),
        orig_path: None,
        index: ChangeKind::Unmerged,
        worktree: ChangeKind::Unmerged,
        conflicted: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<u8> {
        let records = [
            "# branch.oid 1234567890abcdef",
            "# branch.head main",
            "# branch.upstream origin/main",
            "# branch.ab +2 -1",
            "1 .M N... 100644 100644 100644 aaa bbb src/changed file.txt",
            "1 M. N... 100644 100644 100644 aaa bbb staged.txt",
            "1 AM N... 000000 100644 100644 000 bbb added then edited.txt",
            "1 .D N... 100644 100644 000000 aaa bbb gone.txt",
            "2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt",
            "old name.txt",
            "u UU N... 100644 100644 100644 100644 a b c conflict.txt",
            "? untracked dir/new.txt",
        ];
        let mut out = records.join("\0").into_bytes();
        out.push(0);
        out
    }

    #[test]
    fn parses_the_branch_header() {
        let status = parse_status(&sample());
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert!(!status.detached);
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!((status.ahead, status.behind), (2, 1));
        assert!(status.has_head());
    }

    #[test]
    fn parses_modified_staged_added_deleted_renamed_conflicted_and_untracked() {
        let status = parse_status(&sample());
        let find = |path: &str| status.changes.iter().find(|c| c.path == path).unwrap();

        let changed = find("src/changed file.txt");
        assert_eq!(
            (changed.index, changed.worktree),
            (ChangeKind::Unmodified, ChangeKind::Modified)
        );
        assert!(changed.is_unstaged() && !changed.is_staged());

        let staged = find("staged.txt");
        assert!(staged.is_staged() && !staged.is_unstaged());

        let both = find("added then edited.txt");
        assert_eq!(
            (both.index, both.worktree),
            (ChangeKind::Added, ChangeKind::Modified)
        );
        assert!(both.is_staged() && both.is_unstaged());

        assert_eq!(find("gone.txt").worktree, ChangeKind::Deleted);

        let renamed = find("new name.txt");
        assert_eq!(renamed.index, ChangeKind::Renamed);
        assert_eq!(renamed.orig_path.as_deref(), Some("old name.txt"));

        let conflict = find("conflict.txt");
        assert!(conflict.conflicted && conflict.is_unstaged() && !conflict.is_staged());

        let untracked = find("untracked dir/new.txt");
        assert!(untracked.is_untracked() && !untracked.is_staged() && !untracked.is_unstaged());

        assert_eq!(status.changes.len(), 7);
        assert_eq!(status.staged_count(), 3);
    }

    #[test]
    fn a_fresh_repository_has_no_head_and_a_detached_head_has_no_branch() {
        let fresh = parse_status(b"# branch.oid (initial)\0# branch.head master\0");
        assert!(!fresh.has_head());
        assert_eq!(fresh.branch.as_deref(), Some("master"));

        let detached = parse_status(b"# branch.oid abc\0# branch.head (detached)\0");
        assert!(detached.detached);
        assert_eq!(detached.branch, None);
    }

    #[test]
    fn empty_and_garbage_output_is_an_empty_status() {
        assert_eq!(parse_status(b""), RepoStatus::default());
        assert!(parse_status(b"nonsense\0x y z\0").changes.is_empty());
    }
}
