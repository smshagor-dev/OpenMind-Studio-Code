use std::fs::{self, File};
use std::io;
use std::path::{Component, Path, PathBuf};

use crate::error::RuntimeError;

/// Upper bound on what one archive may write, so a zip bomb can't fill the disk.
const MAX_EXTRACTED_BYTES: u64 = 6 * 1024 * 1024 * 1024;

/// Maps an archive entry name to a path *inside* the destination, or `None`
/// if nothing is left after stripping. Anything that could land outside —
/// absolute paths, drive letters, `..`, alternate-data-stream colons, empty
/// or NUL-containing names — is an error, not silently skipped.
pub fn safe_entry_path(
    name: &str,
    strip_components: usize,
) -> Result<Option<PathBuf>, RuntimeError> {
    let unsafe_entry = |why: &str| RuntimeError::UnsafeArchive(format!("entry \"{name}\" {why}"));
    if name.contains('\0') {
        return Err(unsafe_entry("contains a NUL byte"));
    }
    let normalized = name.replace('\\', "/");
    if normalized.starts_with('/') {
        return Err(unsafe_entry("is an absolute path"));
    }
    let mut parts = Vec::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(unsafe_entry("escapes the destination with \"..\"")),
            other if other.contains(':') => {
                return Err(unsafe_entry("contains a drive letter or stream marker"));
            }
            other => parts.push(other),
        }
    }
    if parts.len() <= strip_components {
        return Ok(None);
    }
    let path: PathBuf = parts[strip_components..].iter().collect();
    // Belt and braces: whatever we built must be made only of normal components.
    if !path.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(unsafe_entry("resolves to an unsafe path"));
    }
    Ok(Some(path))
}

/// Extracts a ZIP into `dest` (created if needed). Reports `(entries done,
/// total entries)`. Symlink entries are refused outright: a runtime archive
/// has no business creating links that could later redirect a write.
pub fn extract_zip(
    archive_path: &Path,
    dest: &Path,
    strip_components: usize,
    progress: &mut dyn FnMut(u64, Option<u64>),
) -> Result<(), RuntimeError> {
    let file = File::open(archive_path).map_err(|err| RuntimeError::io(archive_path, err))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|err| RuntimeError::InvalidArchive(err.to_string()))?;
    fs::create_dir_all(dest).map_err(|err| RuntimeError::io(dest, err))?;

    let total = archive.len() as u64;
    let mut written = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|err| RuntimeError::InvalidArchive(err.to_string()))?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(RuntimeError::UnsafeArchive(format!(
                "entry \"{}\" is a symbolic link",
                entry.name()
            )));
        }
        if let Some(relative) = safe_entry_path(entry.name(), strip_components)? {
            let target = dest.join(&relative);
            debug_assert!(target.starts_with(dest));
            if entry.is_dir() {
                fs::create_dir_all(&target).map_err(|err| RuntimeError::io(&target, err))?;
            } else {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|err| RuntimeError::io(parent, err))?;
                }
                let mut out =
                    File::create(&target).map_err(|err| RuntimeError::io(&target, err))?;
                let copied = io::copy(
                    &mut (&mut entry).take(MAX_EXTRACTED_BYTES - written),
                    &mut out,
                )
                .map_err(|err| RuntimeError::io(&target, err))?;
                written += copied;
                if written >= MAX_EXTRACTED_BYTES {
                    return Err(RuntimeError::UnsafeArchive(
                        "the archive expands to more data than a runtime should".into(),
                    ));
                }
            }
        }
        progress(index as u64 + 1, Some(total));
    }
    Ok(())
}

use std::io::Read;

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;

    pub fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buffer = io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buffer);
            let options = zip::write::SimpleFileOptions::default();
            for (name, data) in entries {
                if name.ends_with('/') {
                    writer.add_directory(*name, options).expect("dir");
                } else {
                    writer.start_file(*name, options).expect("file");
                    writer.write_all(data).expect("data");
                }
            }
            writer.finish().expect("finish");
        }
        buffer.into_inner()
    }

    fn write_zip(dir: &Path, entries: &[(&str, &[u8])]) -> PathBuf {
        let path = dir.join("a.zip");
        fs::write(&path, build_zip(entries)).expect("write zip");
        path
    }

    #[test]
    fn safe_entry_paths_accept_normal_names_and_strip_prefixes() {
        let p = |name, strip| safe_entry_path(name, strip).expect("safe");

        assert_eq!(p("node.exe", 0), Some(PathBuf::from("node.exe")));
        assert_eq!(
            p("top/bin/node.exe", 1),
            Some(PathBuf::from("bin").join("node.exe"))
        );
        assert_eq!(p("top/", 1), None);
        assert_eq!(p("top", 1), None);
        assert_eq!(
            p("./a//b/./c.txt", 0),
            Some(PathBuf::from("a").join("b").join("c.txt"))
        );
        assert_eq!(
            p("a\\b\\c.txt", 0),
            Some(PathBuf::from("a").join("b").join("c.txt"))
        );
    }

    #[test]
    fn safe_entry_paths_reject_every_way_out_of_the_destination() {
        for name in [
            "../evil.txt",
            "a/../../evil.txt",
            "a/../b",
            "/etc/passwd",
            "\\windows\\system32\\evil.dll",
            "C:/Windows/evil.dll",
            "C:evil.dll",
            "a/b:stream",
            "..\\evil.txt",
            "nul\0.txt",
        ] {
            assert!(
                matches!(
                    safe_entry_path(name, 0),
                    Err(RuntimeError::UnsafeArchive(_))
                ),
                "{name}"
            );
        }
        // Traversal hidden inside the part that strip_components would drop is still refused.
        assert!(safe_entry_path("../top/file", 1).is_err());
    }

    #[test]
    fn extracts_files_and_directories_with_the_wrapper_folder_stripped() {
        let dir = tempfile::tempdir().expect("tempdir");
        let zip = write_zip(
            dir.path(),
            &[
                ("wrap/", b""),
                ("wrap/node.exe", b"MZ"),
                ("wrap/lib/x.js", b"js"),
            ],
        );
        let dest = dir.path().join("out");
        let mut last = (0, None);

        extract_zip(&zip, &dest, 1, &mut |done, total| last = (done, total)).expect("extract");

        assert_eq!(fs::read(dest.join("node.exe")).expect("node"), b"MZ");
        assert_eq!(fs::read(dest.join("lib").join("x.js")).expect("x"), b"js");
        assert_eq!(last, (3, Some(3)));
    }

    #[test]
    fn a_zip_slip_archive_is_rejected_and_writes_nothing_outside_the_destination() {
        let dir = tempfile::tempdir().expect("tempdir");
        let zip = write_zip(
            dir.path(),
            &[("ok.txt", b"fine"), ("../escaped.txt", b"pwned")],
        );
        let dest = dir.path().join("out");

        let result = extract_zip(&zip, &dest, 0, &mut |_, _| {});

        assert!(matches!(result, Err(RuntimeError::UnsafeArchive(_))));
        assert!(!dir.path().join("escaped.txt").exists());
    }

    #[test]
    fn a_corrupt_archive_is_an_invalid_archive_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("a.zip");
        fs::write(&path, b"this is not a zip").expect("write");

        let result = extract_zip(&path, &dir.path().join("out"), 0, &mut |_, _| {});

        assert!(matches!(result, Err(RuntimeError::InvalidArchive(_))));
    }

    #[test]
    fn a_missing_archive_is_an_io_error() {
        let dir = tempfile::tempdir().expect("tempdir");

        let result = extract_zip(
            &dir.path().join("nope.zip"),
            &dir.path().join("out"),
            0,
            &mut |_, _| {},
        );

        assert!(matches!(result, Err(RuntimeError::Io { .. })));
    }
}
