//! Reading a project's files as untrusted input: small files only, never through a link, bounded listings.

use std::fs;
use std::path::Path;

/// Manifests and metadata larger than this aren't read.
pub const MAX_FILE: u64 = 512 * 1024;
/// At most this many entries of any list are kept (a hostile manifest can't flood the view).
pub const MAX_ITEMS: usize = 500;
/// At most this many folder entries are looked at.
const MAX_LISTING: usize = 5000;

/// A regular file's text (lossy UTF-8), or `None` when it is missing, a link, or too big.
pub fn read_small(path: &Path) -> Option<String> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE {
        return None;
    }
    fs::read(path)
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// A real folder (not a link).
pub fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir())
}

/// A real file (not a link).
pub fn is_real_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file())
}

/// The names in a folder (bounded, sorted); empty when it can't be read.
pub fn names_in(path: &Path) -> Vec<String> {
    let Ok(read) = fs::read_dir(path) else {
        return Vec::new();
    };
    let mut names: Vec<String> = read
        .filter_map(Result::ok)
        .take(MAX_LISTING)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();
    names.sort();
    names
}

/// A string from a manifest, made safe to show: control characters removed, at most 200 characters.
pub fn display_text(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).take(200).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn big_files_and_links_are_not_read_and_text_is_made_safe_to_show() {
        let dir = tempfile::tempdir().expect("tempdir");
        let small = dir.path().join("a.json");
        fs::write(&small, "{}").expect("write");
        let big = dir.path().join("big.json");
        fs::write(&big, vec![b' '; (MAX_FILE + 1) as usize]).expect("write");
        assert_eq!(read_small(&small).as_deref(), Some("{}"));
        assert_eq!(read_small(&big), None);
        assert_eq!(read_small(&dir.path().join("missing")), None);
        assert_eq!(display_text("a\u{1b}[31mb\nc"), "a[31mbc");
        assert_eq!(display_text(&"x".repeat(300)).len(), 200);
    }
}
