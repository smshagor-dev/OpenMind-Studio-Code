//! `git blame --porcelain` parsing: who last changed each line.

use std::collections::HashMap;

use serde::Serialize;

/// The all-zero id Git uses for lines that are not committed yet.
const UNCOMMITTED: &str = "0000000000000000000000000000000000000000";

/// One line of the file with the commit that last touched it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    /// 1-based line number in the current file.
    pub line: u32,
    pub short_hash: String,
    pub author: String,
    /// Author time, seconds since the Unix epoch (0 for uncommitted lines).
    pub time: i64,
    pub summary: String,
    pub content: String,
    pub committed: bool,
}

#[derive(Default, Clone)]
struct CommitInfo {
    author: String,
    time: i64,
    summary: String,
}

pub fn parse_blame(output: &[u8]) -> Vec<BlameLine> {
    let text = String::from_utf8_lossy(output);
    let mut commits: HashMap<String, CommitInfo> = HashMap::new();
    let mut lines = Vec::new();
    let mut current: Option<(String, u32)> = None;
    for raw in text.split('\n') {
        if let Some(content) = raw.strip_prefix('\t') {
            let Some((hash, line)) = current.take() else {
                continue;
            };
            let info = commits.get(&hash).cloned().unwrap_or_default();
            let committed = hash != UNCOMMITTED;
            lines.push(BlameLine {
                line,
                short_hash: hash.chars().take(7).collect(),
                author: if committed {
                    info.author
                } else {
                    "Not Committed Yet".to_string()
                },
                time: info.time,
                summary: if committed {
                    info.summary
                } else {
                    "Uncommitted changes".to_string()
                },
                content: content.trim_end_matches('\r').to_string(),
                committed,
            });
            continue;
        }
        if let Some((hash, line)) = header(raw) {
            commits.entry(hash.clone()).or_default();
            current = Some((hash, line));
            continue;
        }
        let Some((hash, _)) = &current else { continue };
        let entry = commits.entry(hash.clone()).or_default();
        if let Some(author) = raw.strip_prefix("author ") {
            entry.author = author.to_string();
        } else if let Some(time) = raw.strip_prefix("author-time ") {
            entry.time = time.parse().unwrap_or(0);
        } else if let Some(summary) = raw.strip_prefix("summary ") {
            entry.summary = summary.to_string();
        }
    }
    lines
}

/// `<40 hex> <orig line> <final line> [<group size>]`
fn header(line: &str) -> Option<(String, u32)> {
    let mut parts = line.split(' ');
    let hash = parts.next()?;
    if hash.len() != 40 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    parts.next()?.parse::<u32>().ok()?;
    let final_line = parts.next()?.parse::<u32>().ok()?;
    Some((hash.to_string(), final_line))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> String {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        format!(
            "{a} 1 1 2\nauthor Ada Lovelace\nauthor-mail <ada@x.io>\nauthor-time 1700000000\nsummary first commit\nfilename f.txt\n\tline one\n{a} 2 2\n\tline two\n{b} 3 3 1\nauthor Bob\nauthor-time 1700001000\nsummary second: tweak\nfilename f.txt\n\tline three\r\n{UNCOMMITTED} 4 4 1\nauthor Not Committed Yet\nauthor-time 1700002000\nsummary Version of f.txt from f.txt\nfilename f.txt\n\tedited\n"
        )
    }

    #[test]
    fn attributes_every_line_including_repeats_of_a_commit() {
        let lines = parse_blame(sample().as_bytes());
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[0].author, "Ada Lovelace");
        assert_eq!(lines[0].summary, "first commit");
        assert_eq!(lines[0].short_hash, "aaaaaaa");
        // The second line reuses the first commit's details (Git prints them once).
        assert_eq!(lines[1].author, "Ada Lovelace");
        assert_eq!(lines[1].line, 2);
        assert_eq!(lines[2].author, "Bob");
        assert_eq!(lines[2].time, 1_700_001_000);
        assert_eq!(lines[2].content, "line three");
    }

    #[test]
    fn uncommitted_lines_are_labelled_as_such() {
        let lines = parse_blame(sample().as_bytes());
        assert!(!lines[3].committed);
        assert_eq!(lines[3].author, "Not Committed Yet");
        assert_eq!(lines[3].summary, "Uncommitted changes");
    }

    #[test]
    fn empty_or_broken_output_is_no_lines() {
        assert!(parse_blame(b"").is_empty());
        assert!(parse_blame(b"garbage\n\tcontent without header\n").is_empty());
    }
}
