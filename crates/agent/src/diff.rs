//! A line diff of a file change, for the permission prompt and the result card: hunks with three lines of context,
//! line numbers on both sides and the added/removed counts. Pure; large files are trimmed to the changed middle first,
//! and a middle too big for a full comparison is shown as removed-then-added.

use serde::Serialize;

const CONTEXT: usize = 3;
/// Lines compared exactly (the middle of a change, after the common start and end are trimmed).
const MAX_LCS: usize = 2_000;
/// Lines shown at most; the counts stay exact.
const MAX_SHOWN: usize = 400;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LineKind {
    Context,
    Added,
    Removed,
    /// Lines left out between hunks.
    Gap,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: LineKind,
    pub old_line: Option<usize>,
    pub new_line: Option<usize>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub added: usize,
    pub removed: usize,
    pub lines: Vec<DiffLine>,
    /// More lines changed than are shown.
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    Same(usize, usize),
    Del(usize),
    Add(usize),
}

fn lcs_ops(old: &[&str], new: &[&str]) -> Vec<Op> {
    let (n, m) = (old.len(), new.len());
    let mut table = vec![0u32; (n + 1) * (m + 1)];
    let at = |i: usize, j: usize| i * (m + 1) + j;
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            table[at(i, j)] = if old[i] == new[j] {
                table[at(i + 1, j + 1)] + 1
            } else {
                table[at(i + 1, j)].max(table[at(i, j + 1)])
            };
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut ops = Vec::new();
    while i < n && j < m {
        if old[i] == new[j] {
            ops.push(Op::Same(i, j));
            i += 1;
            j += 1;
        } else if table[at(i + 1, j)] >= table[at(i, j + 1)] {
            ops.push(Op::Del(i));
            i += 1;
        } else {
            ops.push(Op::Add(j));
            j += 1;
        }
    }
    ops.extend((i..n).map(Op::Del));
    ops.extend((j..m).map(Op::Add));
    ops
}

fn ops(old: &[&str], new: &[&str]) -> Vec<Op> {
    let prefix = old.iter().zip(new).take_while(|(a, b)| a == b).count();
    let max_suffix = old.len().min(new.len()) - prefix;
    let suffix = old
        .iter()
        .rev()
        .zip(new.iter().rev())
        .take(max_suffix)
        .take_while(|(a, b)| a == b)
        .count();
    let old_mid = &old[prefix..old.len() - suffix];
    let new_mid = &new[prefix..new.len() - suffix];
    let mut out: Vec<Op> = (0..prefix).map(|k| Op::Same(k, k)).collect();
    if old_mid.len() <= MAX_LCS && new_mid.len() <= MAX_LCS {
        out.extend(lcs_ops(old_mid, new_mid).into_iter().map(|op| match op {
            Op::Same(a, b) => Op::Same(a + prefix, b + prefix),
            Op::Del(a) => Op::Del(a + prefix),
            Op::Add(b) => Op::Add(b + prefix),
        }));
    } else {
        out.extend((0..old_mid.len()).map(|k| Op::Del(k + prefix)));
        out.extend((0..new_mid.len()).map(|k| Op::Add(k + prefix)));
    }
    let (old_end, new_end) = (old.len() - suffix, new.len() - suffix);
    out.extend((0..suffix).map(|k| Op::Same(old_end + k, new_end + k)));
    out
}

/// The diff from `old` to `new` (an empty `old` is a new file, an empty `new` a deleted one).
pub fn diff(old: &str, new: &str) -> FileDiff {
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();
    let ops = ops(&old_lines, &new_lines);
    let added = ops.iter().filter(|o| matches!(o, Op::Add(_))).count();
    let removed = ops.iter().filter(|o| matches!(o, Op::Del(_))).count();
    // Keep the changed lines and CONTEXT lines around each.
    let changed: Vec<usize> = ops
        .iter()
        .enumerate()
        .filter(|(_, o)| !matches!(o, Op::Same(..)))
        .map(|(i, _)| i)
        .collect();
    let mut keep = vec![false; ops.len()];
    for &i in &changed {
        let from = i.saturating_sub(CONTEXT);
        let to = (i + CONTEXT + 1).min(ops.len());
        keep[from..to].iter_mut().for_each(|k| *k = true);
    }
    let mut lines = Vec::new();
    let mut truncated = false;
    let mut skipped = false;
    for (i, op) in ops.iter().enumerate() {
        if !keep[i] {
            skipped = true;
            continue;
        }
        if skipped && !lines.is_empty() {
            lines.push(DiffLine {
                kind: LineKind::Gap,
                old_line: None,
                new_line: None,
                text: String::new(),
            });
        }
        skipped = false;
        if lines.len() >= MAX_SHOWN {
            truncated = true;
            break;
        }
        lines.push(match *op {
            Op::Same(a, b) => DiffLine {
                kind: LineKind::Context,
                old_line: Some(a + 1),
                new_line: Some(b + 1),
                text: old_lines[a].to_string(),
            },
            Op::Del(a) => DiffLine {
                kind: LineKind::Removed,
                old_line: Some(a + 1),
                new_line: None,
                text: old_lines[a].to_string(),
            },
            Op::Add(b) => DiffLine {
                kind: LineKind::Added,
                old_line: None,
                new_line: Some(b + 1),
                text: new_lines[b].to_string(),
            },
        });
    }
    FileDiff {
        added,
        removed,
        lines,
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_one_line_fix_shows_context_and_numbers() {
        let old = "def add(a, b):\n    return a - b\n\nprint(add(2, 3))\n";
        let new = "def add(a, b):\n    return a + b\n\nprint(add(2, 3))\n";
        let d = diff(old, new);
        assert_eq!((d.added, d.removed), (1, 1));
        let removed = d
            .lines
            .iter()
            .find(|l| l.kind == LineKind::Removed)
            .expect("removed");
        assert_eq!(removed.old_line, Some(2));
        assert_eq!(removed.text, "    return a - b");
        let added = d
            .lines
            .iter()
            .find(|l| l.kind == LineKind::Added)
            .expect("added");
        assert_eq!(added.new_line, Some(2));
        assert_eq!(d.lines.first().map(|l| l.kind), Some(LineKind::Context));
    }

    #[test]
    fn a_new_file_is_all_added() {
        let d = diff("", "a\nb\n");
        assert_eq!((d.added, d.removed), (2, 0));
        assert!(d.lines.iter().all(|l| l.kind == LineKind::Added));
    }

    #[test]
    fn far_apart_changes_become_hunks_with_a_gap() {
        let old: String = (1..=40).map(|i| format!("line {i}\n")).collect();
        let new = old
            .replace("line 2\n", "two\n")
            .replace("line 38\n", "thirty-eight\n");
        let d = diff(&old, &new);
        assert_eq!((d.added, d.removed), (2, 2));
        assert_eq!(
            d.lines.iter().filter(|l| l.kind == LineKind::Gap).count(),
            1
        );
        assert!(d.lines.len() < 20);
    }

    #[test]
    fn huge_changes_are_counted_exactly_but_shown_in_part() {
        let old: String = (0..3_000).map(|i| format!("a{i}\n")).collect();
        let new: String = (0..3_000).map(|i| format!("b{i}\n")).collect();
        let d = diff(&old, &new);
        assert_eq!((d.added, d.removed), (3_000, 3_000));
        assert!(d.truncated);
        assert!(d.lines.len() <= MAX_SHOWN + 1);
    }
}
