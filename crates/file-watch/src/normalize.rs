use std::path::{Component, Path, PathBuf};

/// Drops the `\\?\` prefix Windows APIs sometimes add, so a reported path can
/// be compared with the root the user opened.
fn without_verbatim(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

/// An operating-system event path made comparable and checked against the
/// workspace: `Some` only for a path inside `root` with no `..` in it.
/// (Case-insensitive on Windows, where `C:\Work` and `c:\work` are the same folder.)
pub fn normalize_event_path(root: &Path, path: &Path) -> Option<PathBuf> {
    let root = without_verbatim(root);
    let path = without_verbatim(path);
    if path.components().any(|part| part == Component::ParentDir) {
        return None;
    }
    let mut own = root.components();
    let mut theirs = path.components();
    loop {
        match (own.next(), theirs.next()) {
            (None, Some(_)) => break,
            (None, None) => return None, // the root itself is not a file event
            (Some(a), Some(b)) if same_component(&a, &b) => {}
            _ => return None,
        }
    }
    let mut result = root;
    result.extend(path.components().skip(root_len(&result)));
    Some(result)
}

fn root_len(root: &Path) -> usize {
    root.components().count()
}

fn same_component(a: &Component, b: &Component) -> bool {
    if cfg!(windows) {
        a.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())
    } else {
        a == b
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_inside_the_root_are_kept_with_spaces_and_the_roots_own_spelling() {
        let root = Path::new("C:/My Projects/site");
        assert_eq!(
            normalize_event_path(root, Path::new("C:/My Projects/site/src/a b.txt")),
            Some(PathBuf::from("C:/My Projects/site/src/a b.txt"))
        );
    }

    #[test]
    fn the_root_itself_other_folders_and_traversal_are_refused() {
        let root = Path::new("C:/My Projects/site");
        for outside in [
            "C:/My Projects/site",
            "C:/My Projects/other/a.txt",
            "C:/My Projects/site2/a.txt",
            "C:/My Projects/site/../x.txt",
            "D:/elsewhere/a.txt",
        ] {
            assert_eq!(
                normalize_event_path(root, Path::new(outside)),
                None,
                "{outside}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_verbatim_prefixes_and_letter_case_do_not_matter() {
        let root = Path::new(r"C:\My Projects\site");
        assert_eq!(
            normalize_event_path(root, Path::new(r"\\?\c:\my projects\SITE\src\a.txt")),
            Some(PathBuf::from(r"C:\My Projects\site\src\a.txt"))
        );
    }
}
