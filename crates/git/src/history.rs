//! Commit history: `git log` records and the files one commit changed.

use serde::{Deserialize, Serialize};

/// One commit as the History panel lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    /// Strict ISO 8601 author date.
    pub date: String,
    pub subject: String,
}

/// One file a commit touched. `status` is Git's letter (A, M, D, R, C, T).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    pub orig_path: Option<String>,
    pub status: String,
}

/// Field separator inside a `git log` record (unit separator).
pub const FIELD: char = '\u{1f}';

/// Parses `git log -z --format=%H%x1f%h%x1f%an%x1f%aI%x1f%s`.
pub fn parse_log(output: &[u8]) -> Vec<Commit> {
    String::from_utf8_lossy(output)
        .split('\0')
        .filter_map(|record| {
            let mut fields = record.trim_start_matches('\n').split(FIELD);
            let hash = fields.next().filter(|hash| is_hash(hash))?;
            Some(Commit {
                hash: hash.to_string(),
                short_hash: fields.next()?.to_string(),
                author: fields.next()?.to_string(),
                date: fields.next()?.to_string(),
                subject: fields.next().unwrap_or_default().to_string(),
            })
        })
        .collect()
}

/// Parses `git show --name-status -z -M --format=` (`M\0path\0`, `R100\0old\0new\0`).
pub fn parse_name_status(output: &[u8]) -> Vec<CommitFile> {
    let text = String::from_utf8_lossy(output);
    let mut tokens = text.split('\0').filter(|token| !token.is_empty());
    let mut files = Vec::new();
    while let Some(status) = tokens.next() {
        let letter = status.chars().next().unwrap_or('?');
        if letter == 'R' || letter == 'C' {
            if let (Some(old), Some(new)) = (tokens.next(), tokens.next()) {
                files.push(CommitFile {
                    path: new.to_string(),
                    orig_path: Some(old.to_string()),
                    status: letter.to_string(),
                });
            }
        } else if let Some(path) = tokens.next() {
            files.push(CommitFile {
                path: path.to_string(),
                orig_path: None,
                status: letter.to_string(),
            });
        }
    }
    files
}

/// A full or abbreviated commit id: 7 to 40 hex digits. Anything else is never handed to Git.
pub fn is_hash(text: &str) -> bool {
    (7..=40).contains(&text.len()) && text.chars().all(|c| c.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_log_records_with_spaces_and_unicode_in_the_subject() {
        let hash = "a".repeat(40);
        let record = format!(
            "{hash}{FIELD}aaaaaaa{FIELD}Ada Lovelace{FIELD}2026-01-02T03:04:05+00:00{FIELD}fix: ünïcode subject, with spaces"
        );
        let second = format!(
            "{}{FIELD}bbbbbbb{FIELD}Bob{FIELD}2026-01-01T00:00:00+00:00{FIELD}",
            "b".repeat(40)
        );
        let output = format!("{record}\0{second}\0");
        let commits = parse_log(output.as_bytes());
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].author, "Ada Lovelace");
        assert_eq!(commits[0].short_hash, "aaaaaaa");
        assert_eq!(commits[0].subject, "fix: ünïcode subject, with spaces");
        assert_eq!(commits[1].subject, "");
    }

    #[test]
    fn garbage_and_empty_log_output_is_no_commits() {
        assert!(parse_log(b"").is_empty());
        assert!(parse_log(b"not a record\0also not").is_empty());
    }

    #[test]
    fn parses_name_status_including_renames_with_spaces() {
        let output =
            b"A\0new file.txt\0M\0src/a b.txt\0D\0gone.txt\0R100\0old name.txt\0new name.txt\0";
        let files = parse_name_status(output);
        assert_eq!(files.len(), 4);
        assert_eq!(files[0].status, "A");
        assert_eq!(files[1].path, "src/a b.txt");
        assert_eq!(files[3].status, "R");
        assert_eq!(files[3].orig_path.as_deref(), Some("old name.txt"));
        assert_eq!(files[3].path, "new name.txt");
    }

    #[test]
    fn only_hex_ids_of_sane_length_count_as_hashes() {
        assert!(is_hash("abc1234"));
        assert!(is_hash(&"f".repeat(40)));
        for bad in ["", "abc", "abc123g", "--output=x", "HEAD", &"a".repeat(41)] {
            assert!(!is_hash(bad), "{bad}");
        }
    }
}
