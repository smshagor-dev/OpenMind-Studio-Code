//! Catches a change the model left half done. A small model asked to rename something everywhere searches, finds the
//! name in several files, changes some of them and then says it changed all of them. The turn remembers each plain-text
//! search and the files it matched; when an applied change removed a searched name from a file, the name counts as
//! replaced. Before the turn ends, the files that search matched are read again, and any that still contain the name
//! are named to the model once, so it either finishes the change or says why those occurrences stay.

use std::path::Path;

use serde_json::Value;

use crate::tools::Change;

/// The shortest name worth following; shorter queries match too much ordinary text.
const MIN_NAME: usize = 3;
/// Files named in one reminder.
const MAX_LISTED: usize = 10;

#[derive(Debug, Default)]
pub(crate) struct Leftovers {
    /// Plain-text searches of this turn with the files (relative paths) they matched.
    searches: Vec<(String, Vec<String>)>,
    /// Searched names an applied change removed from a file, with the files it was removed from.
    replaced: Vec<(String, Vec<String>)>,
    reminded: bool,
}

/// A query that looks like a name (an identifier, a dotted path, a file name): letters, digits, `_`, `.`, `-`, `$`.
fn is_name(query: &str) -> bool {
    query.chars().count() >= MIN_NAME
        && query
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '.' | '-' | '$'))
        && query.chars().any(char::is_alphabetic)
}

/// The files of a search result: each line is `path:line: text`.
fn matched_files(result: &str) -> Vec<String> {
    let mut files: Vec<String> = Vec::new();
    for line in result.lines() {
        let Some((path, rest)) = line.split_once(':') else {
            continue;
        };
        let digits = rest.chars().take_while(char::is_ascii_digit).count();
        if digits == 0 || !rest[digits..].starts_with(':') {
            continue;
        }
        if !files.iter().any(|f| f == path) {
            files.push(path.to_string());
        }
    }
    files
}

impl Leftovers {
    /// After a `search` call ran.
    pub fn searched(&mut self, arguments: &str, result: &str) {
        let Ok(args) = serde_json::from_str::<Value>(arguments) else {
            return;
        };
        if args["regex"].as_bool().unwrap_or(false) {
            return;
        }
        let Some(query) = args["query"].as_str().map(str::trim) else {
            return;
        };
        if !is_name(query) {
            return;
        }
        let files = matched_files(result);
        if files.len() < 2 {
            return;
        }
        self.searches.retain(|(q, _)| q != query);
        self.searches.push((query.to_string(), files));
    }

    /// After a change was applied.
    pub fn changed(&mut self, change: &Change) {
        let text = |bytes: &Option<Vec<u8>>| {
            bytes
                .as_deref()
                .map(|b| String::from_utf8_lossy(b).into_owned())
                .unwrap_or_default()
        };
        let (before, after) = (text(&change.before), text(&change.after));
        let rel = change.rel.replace('\\', "/");
        for (query, _) in &self.searches {
            if !before.contains(query.as_str()) || after.contains(query.as_str()) {
                continue;
            }
            match self.replaced.iter_mut().find(|(q, _)| q == query) {
                Some((_, files)) if !files.contains(&rel) => files.push(rel.clone()),
                Some(_) => {}
                None => self.replaced.push((query.clone(), vec![rel.clone()])),
            }
        }
    }

    /// Before the turn ends: what to tell the model when a replaced name is still in files its search found. Once per
    /// turn; `None` = nothing left over (or already reminded).
    pub fn reminder(&mut self, root: &Path) -> Option<String> {
        if self.reminded {
            return None;
        }
        let mut notes = Vec::new();
        for (query, done) in &self.replaced {
            let Some((_, found)) = self.searches.iter().find(|(q, _)| q == query) else {
                continue;
            };
            let left: Vec<&str> = found
                .iter()
                .filter(|rel| {
                    std::fs::read_to_string(root.join(rel.as_str()))
                        .is_ok_and(|text| text.contains(query.as_str()))
                })
                .map(String::as_str)
                .take(MAX_LISTED)
                .collect();
            if !left.is_empty() {
                notes.push(format!(
                    "You replaced `{query}` in {}, but your search also found it in {}, which still contain{} it",
                    done.join(", "),
                    left.join(", "),
                    if left.len() == 1 { "s" } else { "" }
                ));
            }
        }
        if notes.is_empty() {
            return None;
        }
        self.reminded = true;
        Some(format!(
            "{}. Read those files and change them too if the task covers them; if an occurrence should stay as it is, \
             say which one and why in your final answer. Describe only changes you actually made.",
            notes.join(". ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::ChangeKind;

    fn change(rel: &str, before: &str, after: &str) -> Change {
        Change {
            root: Default::default(),
            path: Default::default(),
            rel: rel.into(),
            kind: ChangeKind::Modified,
            before: Some(before.as_bytes().to_vec()),
            after: Some(after.as_bytes().to_vec()),
        }
    }

    const FOUND: &str = "utils.py:1: def get_total(items):\nmain.py:1: from utils import get_total\n\
                         main.py:4: print(get_total(items))\nreport.py:5: return utils.get_total(items)";

    #[test]
    fn a_rename_left_in_one_file_is_named_once() {
        let dir = tempfile::tempdir().expect("tmp");
        std::fs::write(dir.path().join("utils.py"), "def compute_total(items): ...\n").expect("w");
        std::fs::write(dir.path().join("main.py"), "from utils import compute_total\n").expect("w");
        std::fs::write(dir.path().join("report.py"), "utils.get_total(items)\n").expect("w");
        let mut l = Leftovers::default();
        l.searched(r#"{"query":"get_total"}"#, FOUND);
        l.changed(&change("utils.py", "def get_total", "def compute_total"));
        l.changed(&change("main.py", "import get_total", "import compute_total"));
        let note = l.reminder(dir.path()).expect("reminder");
        assert!(note.contains("`get_total` in utils.py, main.py"), "{note}");
        assert!(
            note.contains("also found it in report.py, which still contains it"),
            "{note}"
        );
        assert_eq!(l.reminder(dir.path()), None, "only once per turn");
    }

    #[test]
    fn a_finished_rename_says_nothing() {
        let dir = tempfile::tempdir().expect("tmp");
        for f in ["utils.py", "main.py", "report.py"] {
            std::fs::write(dir.path().join(f), "compute_total\n").expect("w");
        }
        let mut l = Leftovers::default();
        l.searched(r#"{"query":"get_total"}"#, FOUND);
        l.changed(&change("utils.py", "get_total", "compute_total"));
        assert_eq!(l.reminder(dir.path()), None);
    }

    #[test]
    fn searches_that_are_not_names_or_never_replaced_are_ignored() {
        let dir = tempfile::tempdir().expect("tmp");
        std::fs::write(dir.path().join("report.py"), "get_total\n").expect("w");
        let mut l = Leftovers::default();
        // A sentence, a regex and a one-file result are not followed.
        l.searched(r#"{"query":"wrong result"}"#, FOUND);
        l.searched(r#"{"query":"get_.*","regex":true}"#, FOUND);
        l.searched(r#"{"query":"shout"}"#, "a.py:1: shout");
        l.changed(&change("a.py", "wrong result shout get_.*", ""));
        assert_eq!(l.reminder(dir.path()), None);
        // A name still in the file after the edit (its call changed, not the name) isn't "replaced".
        l.searched(r#"{"query":"get_total"}"#, FOUND);
        l.changed(&change("utils.py", "get_total(a)", "get_total(a, b)"));
        assert_eq!(l.reminder(dir.path()), None);
    }

    #[test]
    fn result_lines_give_each_file_once() {
        assert_eq!(
            matched_files(FOUND),
            vec!["utils.py", "main.py", "report.py"]
        );
        assert!(matched_files("No matches.").is_empty());
        assert_eq!(
            matched_files("src/a b.ts:12: x\n[stopped at 200 matches]"),
            vec!["src/a b.ts"]
        );
    }
}
