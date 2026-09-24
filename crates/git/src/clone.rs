//! Cloning: what may be cloned and where. Checked before Git runs, so a bad
//! URL can't become an option and an existing folder is never overwritten.

use std::path::{Path, PathBuf};

use crate::error::GitError;

/// A repository address that is safe to hand to `git clone -- <url>`: a
/// URL (`https`, `http`, `ssh`, `git`, `file`), an scp-style `user@host:path`
/// or a local folder path. Never something Git could read as an option, and
/// never the `ext::` transport (which runs a command).
pub fn validate_url(url: &str) -> Result<String, GitError> {
    let url = url.trim();
    if url.is_empty() {
        return Err(GitError::InvalidCloneUrl(
            "Enter the address of the repository to clone.".into(),
        ));
    }
    if url.starts_with('-') || url.chars().any(char::is_control) {
        return Err(GitError::InvalidCloneUrl(
            "That address isn't valid — it can't start with \"-\" or contain control characters."
                .into(),
        ));
    }
    // `transport::address` (ext::, fd::, ...) makes Git run helpers: never accepted.
    if let Some((transport, _)) = url.split_once("::") {
        if !transport.is_empty() && transport.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(GitError::InvalidCloneUrl(
                "That kind of address isn't supported.".into(),
            ));
        }
    }
    Ok(url.to_string())
}

/// The folder name Git would pick for a URL: the last path part without `.git`.
pub fn default_folder_name(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches(['/', '\\']);
    let last = trimmed.rsplit(['/', '\\', ':']).next()?;
    let name = last.strip_suffix(".git").unwrap_or(last).trim();
    valid_folder_name(name).then(|| name.to_string())
}

fn valid_folder_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.chars().any(|c| {
            c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
}

/// Where a clone goes: `<parent>/<name>`, where `parent` must be an existing
/// folder and the target either missing or an empty folder. A folder that has
/// anything in it is refused — nothing is ever overwritten or emptied.
pub fn validate_destination(parent: &Path, name: &str) -> Result<PathBuf, GitError> {
    let name = name.trim();
    if !valid_folder_name(name) {
        return Err(GitError::InvalidCloneDestination(
            "Enter a valid folder name for the clone.".into(),
        ));
    }
    if !parent.is_dir() {
        return Err(GitError::InvalidCloneDestination(
            "The destination folder doesn't exist. Choose an existing folder.".into(),
        ));
    }
    let target = parent.join(name);
    if target.exists() {
        if !target.is_dir() {
            return Err(GitError::InvalidCloneDestination(format!(
                "\"{name}\" already exists and is not a folder."
            )));
        }
        let empty = std::fs::read_dir(&target)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
        if !empty {
            return Err(GitError::InvalidCloneDestination(format!(
                "The folder \"{name}\" already exists and is not empty. Nothing is overwritten — choose another folder or name."
            )));
        }
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_urls_scp_addresses_and_local_paths() {
        for ok in [
            "https://github.com/a/b.git",
            "ssh://git@host/a/b",
            "git@github.com:a/b.git",
            "file:///C:/repos/a",
            "C:\\repos\\bare.git",
            "/srv/git/repo.git",
            "E:\\my repos\\bare repo.git",
        ] {
            assert_eq!(validate_url(ok).unwrap(), ok, "{ok}");
        }
        assert_eq!(validate_url("  https://x/y  ").unwrap(), "https://x/y");
    }

    #[test]
    fn refuses_empty_option_like_and_command_running_addresses() {
        for bad in [
            "",
            "   ",
            "-u",
            "--upload-pack=calc",
            "ext::sh -c calc",
            "ext::calc",
            "https://x/\ny",
            "fd::17/repo",
        ] {
            assert!(
                matches!(validate_url(bad), Err(GitError::InvalidCloneUrl(_))),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn folder_names_come_from_the_last_part_of_the_address() {
        assert_eq!(
            default_folder_name("https://x/y/repo.git").as_deref(),
            Some("repo")
        );
        assert_eq!(
            default_folder_name("git@host:team/proj.git/").as_deref(),
            Some("proj")
        );
        assert_eq!(
            default_folder_name("C:\\a\\my repo").as_deref(),
            Some("my repo")
        );
        assert_eq!(default_folder_name("https://x/"), Some("x".to_string()));
        assert_eq!(default_folder_name(""), None);
    }

    #[test]
    fn destination_needs_an_existing_parent_and_a_free_or_empty_target() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("my parent");
        std::fs::create_dir_all(&parent).unwrap();

        assert_eq!(
            validate_destination(&parent, "new repo").unwrap(),
            parent.join("new repo")
        );
        assert!(matches!(
            validate_destination(&temp.path().join("missing"), "x"),
            Err(GitError::InvalidCloneDestination(_))
        ));

        std::fs::create_dir_all(parent.join("empty")).unwrap();
        assert!(validate_destination(&parent, "empty").is_ok());

        std::fs::create_dir_all(parent.join("full")).unwrap();
        std::fs::write(parent.join("full").join("keep.txt"), "x").unwrap();
        let error = validate_destination(&parent, "full").unwrap_err();
        assert!(error.to_string().contains("not empty"), "{error}");
        assert!(parent.join("full").join("keep.txt").exists());

        std::fs::write(parent.join("file"), "x").unwrap();
        assert!(validate_destination(&parent, "file").is_err());
    }

    #[test]
    fn folder_names_can_not_escape_the_parent() {
        let temp = tempfile::tempdir().unwrap();
        for bad in ["", ".", "..", "a/b", "a\\b", "C:x", "a*b"] {
            assert!(validate_destination(temp.path(), bad).is_err(), "{bad:?}");
        }
    }
}
