//! `.vsix` files: a zip whose `extension/` folder is the extension. Every entry name is checked before
//! anything is written, and extraction only ever writes inside the destination folder.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::error::ExtensionError;
use crate::manifest::Manifest;

const MAX_ENTRIES: usize = 50_000;
const MAX_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

/// The folder inside a `.vsix` that holds the extension.
const PAYLOAD: &str = "extension/";

/// Maps an archive entry name to a path *inside* the destination. Absolute paths, drive letters, `..`,
/// stream colons and NUL bytes are errors, never silently skipped.
pub fn safe_relative(name: &str) -> Result<Option<PathBuf>, ExtensionError> {
    let unsafe_entry = |why: &str| ExtensionError::UnsafeArchive(format!("\"{name}\" {why}"));
    if name.contains('\0') {
        return Err(unsafe_entry("contains a NUL byte"));
    }
    let normalized = name.replace('\\', "/");
    if normalized.starts_with('/') {
        return Err(unsafe_entry("is an absolute path"));
    }
    let mut path = PathBuf::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(unsafe_entry("escapes the folder with \"..\"")),
            other if other.contains(':') => {
                return Err(unsafe_entry("contains a drive letter or stream marker"));
            }
            other => path.push(other),
        }
    }
    if path.as_os_str().is_empty() {
        return Ok(None);
    }
    if !path.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(unsafe_entry("resolves to an unsafe path"));
    }
    Ok(Some(path))
}

fn open(vsix: &Path) -> Result<ZipArchive<File>, ExtensionError> {
    let file = File::open(vsix)
        .map_err(|err| ExtensionError::io(format!("Couldn't open {}", vsix.display()), err))?;
    ZipArchive::new(file).map_err(|err| ExtensionError::NotAVsix(err.to_string()))
}

/// Checks every entry name and the archive's size limits without extracting.
fn check_entries(archive: &mut ZipArchive<File>) -> Result<(), ExtensionError> {
    if archive.len() > MAX_ENTRIES {
        return Err(ExtensionError::UnsafeArchive(format!(
            "it has more than {MAX_ENTRIES} entries"
        )));
    }
    let mut total: u64 = 0;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|err| ExtensionError::NotAVsix(err.to_string()))?;
        safe_relative(entry.name())?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(ExtensionError::UnsafeArchive(format!(
                "\"{}\" is a symbolic link",
                entry.name()
            )));
        }
        total = total.saturating_add(entry.size());
        if total > MAX_TOTAL_BYTES {
            return Err(ExtensionError::UnsafeArchive(
                "it would extract to more than 1 GB".into(),
            ));
        }
    }
    Ok(())
}

/// What a `.vsix` contains, read without extracting it.
#[derive(Debug, Clone)]
pub struct Inspected {
    pub manifest: Manifest,
}

/// Validates the archive and reads `extension/package.json`.
pub fn inspect(vsix: &Path) -> Result<Inspected, ExtensionError> {
    let mut archive = open(vsix)?;
    check_entries(&mut archive)?;
    let mut entry = archive
        .by_name("extension/package.json")
        .map_err(|_| ExtensionError::NotAVsix("it has no extension/package.json".into()))?;
    if entry.size() > MAX_MANIFEST_BYTES {
        return Err(ExtensionError::Manifest(
            "package.json is unreasonably large".into(),
        ));
    }
    let mut text = String::new();
    entry.read_to_string(&mut text).map_err(|err| {
        ExtensionError::Manifest(format!("package.json can't be read as text: {err}"))
    })?;
    Ok(Inspected {
        manifest: Manifest::parse(&text)?,
    })
}

/// Extracts `extension/` of the archive into `dest` (created; must not exist yet or be empty).
pub fn extract(vsix: &Path, dest: &Path) -> Result<(), ExtensionError> {
    let mut archive = open(vsix)?;
    check_entries(&mut archive)?;
    fs::create_dir_all(dest)
        .map_err(|err| ExtensionError::io(format!("Couldn't create {}", dest.display()), err))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|err| ExtensionError::NotAVsix(err.to_string()))?;
        let normalized = entry.name().replace('\\', "/");
        let Some(inner) = normalized.strip_prefix(PAYLOAD) else {
            continue; // [Content_Types].xml, extension.vsixmanifest, ...
        };
        let Some(relative) = safe_relative(inner)? else {
            continue;
        };
        let target = dest.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|err| {
                ExtensionError::io(format!("Couldn't create {}", target.display()), err)
            })?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|err| {
                ExtensionError::io(format!("Couldn't create {}", parent.display()), err)
            })?;
        }
        let mut out = File::create(&target).map_err(|err| {
            ExtensionError::io(format!("Couldn't write {}", target.display()), err)
        })?;
        io::copy(&mut entry, &mut out).map_err(|err| {
            ExtensionError::io(format!("Couldn't write {}", target.display()), err)
        })?;
    }
    Ok(())
}

fn add_dir(
    writer: &mut ZipWriter<File>,
    base: &Path,
    dir: &Path,
    options: SimpleFileOptions,
) -> Result<(), ExtensionError> {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|err| ExtensionError::io(format!("Couldn't read {}", dir.display()), err))?
        .filter_map(Result::ok)
        .collect();
    entries.sort_by_key(fs::DirEntry::file_name);
    for entry in entries {
        let path = entry.path();
        let relative = path.strip_prefix(base).map_err(|_| {
            ExtensionError::Refused("A file is outside the folder being packed.".into())
        })?;
        let name = format!(
            "{PAYLOAD}{}",
            relative
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/")
        );
        if path.is_dir() {
            add_dir(writer, base, &path, options)?;
        } else {
            let mut bytes = Vec::new();
            File::open(&path)
                .and_then(|mut f| f.read_to_end(&mut bytes))
                .map_err(|err| {
                    ExtensionError::io(format!("Couldn't read {}", path.display()), err)
                })?;
            writer
                .start_file(name, options)
                .and_then(|()| writer.write_all(&bytes).map_err(Into::into))
                .map_err(|err| ExtensionError::NotAVsix(err.to_string()))?;
        }
    }
    Ok(())
}

/// Packs a folder that has a `package.json` into a `.vsix` (used by tests and by `examples/pack.rs`, so
/// sample extensions can be built without `vsce`).
pub fn pack(dir: &Path, out: &Path) -> Result<(), ExtensionError> {
    let text = fs::read_to_string(dir.join("package.json"))
        .map_err(|err| ExtensionError::io("Couldn't read package.json", err))?;
    Manifest::parse(&text)?; // never pack something the app would refuse
    let file = File::create(out)
        .map_err(|err| ExtensionError::io(format!("Couldn't create {}", out.display()), err))?;
    let mut writer = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let fail = |err: zip::result::ZipError| ExtensionError::NotAVsix(err.to_string());
    writer
        .start_file("[Content_Types].xml", options)
        .map_err(fail)?;
    writer
        .write_all(b"<?xml version=\"1.0\" encoding=\"utf-8\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"json\" ContentType=\"application/json\"/></Types>")
        .map_err(|err| ExtensionError::io("Couldn't write the archive", err))?;
    add_dir(&mut writer, dir, dir, options)?;
    writer.finish().map_err(fail)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let mut writer = ZipWriter::new(File::create(path).expect("create"));
        let options = SimpleFileOptions::default();
        for (name, bytes) in entries {
            writer.start_file(*name, options).expect("start");
            writer.write_all(bytes).expect("write");
        }
        writer.finish().expect("finish");
    }

    const PACKAGE: &[u8] =
        br#"{"name":"hello","version":"1.0.0","publisher":"acme","main":"./extension.js"}"#;

    #[test]
    fn entry_names_that_could_escape_are_errors() {
        for name in [
            "../evil.js",
            "a/../../evil.js",
            "/abs/x",
            "C:/x",
            "a\\..\\b",
            "x:stream",
            "a\0b",
        ] {
            assert!(safe_relative(name).is_err(), "{name:?}");
        }
        assert_eq!(
            safe_relative("a/b/c.js").expect("ok"),
            Some(PathBuf::from("a/b/c.js"))
        );
        assert_eq!(
            safe_relative("./a//b.js").expect("ok"),
            Some(PathBuf::from("a/b.js"))
        );
        assert_eq!(safe_relative("").expect("ok"), None);
        assert_eq!(
            safe_relative("a\\b.js").expect("ok"),
            Some(PathBuf::from("a/b.js"))
        );
    }

    #[test]
    fn a_path_traversal_entry_is_rejected_before_anything_is_written() {
        let dir = tempfile::tempdir().expect("tempdir");
        let vsix = dir.path().join("evil.vsix");
        write_zip(
            &vsix,
            &[
                ("extension/package.json", PACKAGE),
                ("extension/../../outside.txt", b"pwned"),
            ],
        );
        let dest = dir.path().join("Installed Here");
        let error = extract(&vsix, &dest).expect_err("unsafe");
        assert!(matches!(error, ExtensionError::UnsafeArchive(_)), "{error}");
        assert!(
            !dest.exists(),
            "nothing may be created for an unsafe archive"
        );
        assert!(!dir.path().join("outside.txt").exists());
        assert!(matches!(
            inspect(&vsix),
            Err(ExtensionError::UnsafeArchive(_))
        ));
    }

    #[test]
    fn an_absolute_or_drive_entry_is_rejected() {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in ["/etc/passwd", "C:/Windows/evil.dll", "extension/C:/x"] {
            let vsix = dir.path().join("a.vsix");
            write_zip(&vsix, &[("extension/package.json", PACKAGE), (name, b"x")]);
            assert!(inspect(&vsix).is_err(), "{name}");
        }
    }

    #[test]
    fn a_file_that_is_not_a_zip_or_has_no_manifest_is_not_a_vsix() {
        let dir = tempfile::tempdir().expect("tempdir");
        let text = dir.path().join("x.vsix");
        fs::write(&text, "not a zip").expect("write");
        assert!(matches!(inspect(&text), Err(ExtensionError::NotAVsix(_))));
        let empty = dir.path().join("y.vsix");
        write_zip(&empty, &[("extension/readme.md", b"hi")]);
        let error = inspect(&empty).expect_err("no manifest").to_string();
        assert!(error.contains("no extension/package.json"), "{error}");
        assert!(matches!(
            inspect(&dir.path().join("missing.vsix")),
            Err(ExtensionError::Io { .. })
        ));
    }

    #[test]
    fn inspect_reads_and_validates_the_manifest() {
        let dir = tempfile::tempdir().expect("tempdir");
        let vsix = dir.path().join("ok.vsix");
        write_zip(&vsix, &[("extension/package.json", PACKAGE)]);
        assert_eq!(inspect(&vsix).expect("ok").manifest.id(), "acme.hello");
        let bad = dir.path().join("bad.vsix");
        write_zip(&bad, &[("extension/package.json", br#"{"name":"x"}"#)]);
        assert!(matches!(inspect(&bad), Err(ExtensionError::Manifest(_))));
    }

    #[test]
    fn extract_writes_only_the_extension_folder_into_the_destination() {
        let dir = tempfile::tempdir().expect("tempdir");
        let vsix = dir.path().join("ok.vsix");
        write_zip(
            &vsix,
            &[
                ("[Content_Types].xml", b"<x/>"),
                ("extension.vsixmanifest", b"<y/>"),
                ("extension/package.json", PACKAGE),
                ("extension/extension.js", b"exports.activate = () => {};"),
                ("extension/snippets/a.json", b"{}"),
            ],
        );
        let dest = dir.path().join("My Extensions").join("acme.hello-1.0.0");
        extract(&vsix, &dest).expect("extracted");
        assert!(dest.join("package.json").is_file());
        assert!(dest.join("extension.js").is_file());
        assert!(dest.join("snippets").join("a.json").is_file());
        assert!(!dest.join("[Content_Types].xml").exists());
        assert!(!dest.join("extension.vsixmanifest").exists());
    }

    #[test]
    fn pack_then_inspect_and_extract_round_trips_a_folder() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = dir.path().join("src ext");
        fs::create_dir_all(source.join("sub")).expect("mkdir");
        fs::write(source.join("package.json"), PACKAGE).expect("write");
        fs::write(source.join("extension.js"), "exports.activate = () => {};").expect("write");
        fs::write(source.join("sub").join("data.txt"), "hello").expect("write");
        let vsix = dir.path().join("out.vsix");
        pack(&source, &vsix).expect("packed");
        assert_eq!(inspect(&vsix).expect("ok").manifest.name, "hello");
        let dest = dir.path().join("dest");
        extract(&vsix, &dest).expect("extracted");
        assert_eq!(
            fs::read_to_string(dest.join("sub").join("data.txt")).expect("read"),
            "hello"
        );
    }

    #[test]
    fn pack_refuses_a_folder_the_app_would_not_install() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::write(
            dir.path().join("package.json"),
            r#"{"name":"bad name","version":"1.0.0"}"#,
        )
        .expect("write");
        assert!(matches!(
            pack(dir.path(), &dir.path().join("x.vsix")),
            Err(ExtensionError::Manifest(_))
        ));
    }
}
