//! Stash entries: `git stash list` parsing and the reference names used to address one.

use serde::Serialize;

use crate::error::GitError;
use crate::history::FIELD;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    /// Position in the stash list (0 = the newest).
    pub index: u32,
    /// Git's own description, e.g. `On main: my message` or `WIP on main: abc1234 subject`.
    pub description: String,
    /// The message the user gave, when there is one.
    pub message: Option<String>,
    pub branch: Option<String>,
    pub date: String,
}

/// Parses `git stash list -z --format=%gd%x1f%gs%x1f%aI`.
pub fn parse_stash_list(output: &[u8]) -> Vec<StashEntry> {
    String::from_utf8_lossy(output)
        .split('\0')
        .filter_map(|record| {
            let mut fields = record.trim_start_matches('\n').split(FIELD);
            let reference = fields.next()?;
            let index = reference
                .strip_prefix("stash@{")?
                .strip_suffix('}')?
                .parse()
                .ok()?;
            let description = fields.next()?.to_string();
            let date = fields.next().unwrap_or_default().to_string();
            let (branch, message) = split_description(&description);
            Some(StashEntry {
                index,
                description,
                message,
                branch,
                date,
            })
        })
        .collect()
}

/// `On main: text` carries the user's message; `WIP on main: abc subject` is Git's default.
fn split_description(description: &str) -> (Option<String>, Option<String>) {
    if let Some(rest) = description.strip_prefix("On ") {
        if let Some((branch, message)) = rest.split_once(": ") {
            return (Some(branch.to_string()), Some(message.to_string()));
        }
    }
    let branch = description
        .strip_prefix("WIP on ")
        .and_then(|rest| rest.split_once(": "))
        .map(|(branch, _)| branch.to_string());
    (branch, None)
}

/// The reference for stash `index`: only a number ever becomes part of the name.
pub fn reference(index: u32) -> String {
    format!("stash@{{{index}}}")
}

/// A stash message: one line, no control characters, at most 200 characters.
pub fn validate_message(message: &str) -> Result<String, GitError> {
    let message = message.trim();
    if message.chars().count() > 200 || message.chars().any(char::is_control) {
        return Err(GitError::Failed(
            "A stash message must be a single line of at most 200 characters.".into(),
        ));
    }
    Ok(message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_messages_branches_and_default_descriptions() {
        let out = format!(
            "stash@{{0}}{FIELD}On feature/x: my work in progress{FIELD}2026-01-02T00:00:00+00:00\0stash@{{1}}{FIELD}WIP on main: abc1234 subject line{FIELD}2026-01-01T00:00:00+00:00\0"
        );
        let stashes = parse_stash_list(out.as_bytes());
        assert_eq!(stashes.len(), 2);
        assert_eq!(stashes[0].index, 0);
        assert_eq!(stashes[0].message.as_deref(), Some("my work in progress"));
        assert_eq!(stashes[0].branch.as_deref(), Some("feature/x"));
        assert_eq!(stashes[1].index, 1);
        assert_eq!(stashes[1].message, None);
        assert_eq!(stashes[1].branch.as_deref(), Some("main"));
    }

    #[test]
    fn garbage_is_an_empty_list() {
        assert!(parse_stash_list(b"").is_empty());
        assert!(parse_stash_list(b"nope\0stash@{x}\x1fy\0").is_empty());
    }

    #[test]
    fn references_are_built_from_a_number_only() {
        assert_eq!(reference(0), "stash@{0}");
        assert_eq!(reference(12), "stash@{12}");
    }

    #[test]
    fn messages_are_single_line_and_bounded() {
        assert_eq!(validate_message("  wip  ").unwrap(), "wip");
        assert_eq!(validate_message("").unwrap(), "");
        assert!(validate_message("two\nlines").is_err());
        assert!(validate_message(&"x".repeat(201)).is_err());
    }
}
