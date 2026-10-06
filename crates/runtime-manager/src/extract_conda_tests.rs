//! `.conda` packages: a zip holding metadata and one zstd-compressed tar of the files.

use std::io::Write;

use super::*;

fn tar_of(entries: &[(&str, &[u8], tar::EntryType)]) -> Vec<u8> {
    let mut raw = Vec::new();
    {
        let mut builder = tar::Builder::new(&mut raw);
        for (name, data, kind) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(*kind);
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            if kind.is_symlink() {
                header.set_link_name("elsewhere").expect("link");
            }
            // Written byte for byte: the tar crate refuses to *write* a hostile name such as `../x`.
            let raw = &mut header.as_old_mut().name;
            raw[..name.len()].copy_from_slice(name.as_bytes());
            header.set_cksum();
            builder.append(&header, &data[..]).expect("append");
        }
        builder.finish().expect("finish");
    }
    raw
}

/// A `.conda` file: `metadata.json`, an `info-*` part and the given `pkg-*.tar.zst` parts.
fn conda(payloads: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut buffer = io::Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut buffer);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        writer.start_file("metadata.json", options).expect("meta");
        writer
            .write_all(br#"{"conda_pkg_format_version": 2}"#)
            .expect("meta");
        writer
            .start_file("info-x-1.0-0.tar.zst", options)
            .expect("info");
        writer
            .write_all(&ruzstd::encoding::compress_to_vec(
                &tar_of(&[("info/index.json", b"{}", tar::EntryType::Regular)])[..],
                ruzstd::encoding::CompressionLevel::Fastest,
            ))
            .expect("info");
        for (name, tar) in payloads {
            writer.start_file(*name, options).expect("pkg");
            writer
                .write_all(&ruzstd::encoding::compress_to_vec(
                    &tar[..],
                    ruzstd::encoding::CompressionLevel::Fastest,
                ))
                .expect("pkg");
        }
        writer.finish().expect("finish");
    }
    buffer.into_inner()
}

fn write_package(dir: &Path, bytes: &[u8]) -> PathBuf {
    let path = dir.join("tool-1.0-0.conda");
    std::fs::write(&path, bytes).expect("write");
    path
}

#[test]
fn a_conda_package_extracts_only_its_files_folder() {
    let dir = tempfile::tempdir().expect("tmp");
    let package = write_package(
        dir.path(),
        &conda(&[(
            "pkg-tool-1.0-0.tar.zst",
            tar_of(&[
                ("Library/bin/tool.exe", b"program", tar::EntryType::Regular),
                ("Library/bin/runtime.dll", b"dll", tar::EntryType::Regular),
                ("Library/include/tool.h", b"header", tar::EntryType::Regular),
                ("info/licenses/LICENSE", b"text", tar::EntryType::Regular),
            ]),
        )]),
    );
    let out = dir.path().join("out");
    extract_archive(
        crate::manifest::ArchiveKind::Conda,
        &package,
        &out,
        ExtractSelection {
            strip_components: 0,
            only_under: Some("Library/bin"),
        },
        &mut |_, _| {},
    )
    .expect("extract");
    assert_eq!(
        std::fs::read(out.join("tool.exe")).expect("exe"),
        b"program"
    );
    assert!(out.join("runtime.dll").is_file());
    assert!(!out.join("tool.h").exists() && !out.join("include").exists());
    assert!(!out.join("info").exists(), "metadata isn't installed");
}

#[test]
fn a_conda_package_gets_the_same_safety_checks_as_any_archive() {
    let dir = tempfile::tempdir().expect("tmp");
    let selection = ExtractSelection {
        strip_components: 0,
        only_under: None,
    };
    let link = write_package(
        dir.path(),
        &conda(&[(
            "pkg-tool-1.0-0.tar.zst",
            tar_of(&[("bin/tool.exe", b"", tar::EntryType::Symlink)]),
        )]),
    );
    let refused = extract_conda(&link, &dir.path().join("a"), selection, &mut |_, _| {});
    assert!(
        matches!(refused, Err(RuntimeError::UnsafeArchive(_))),
        "{refused:?}"
    );

    let escape = write_package(
        dir.path(),
        &conda(&[(
            "pkg-tool-1.0-0.tar.zst",
            tar_of(&[("../evil.txt", b"x", tar::EntryType::Regular)]),
        )]),
    );
    let refused = extract_conda(&escape, &dir.path().join("b"), selection, &mut |_, _| {});
    assert!(refused.is_err());
    assert!(!dir.path().join("evil.txt").exists());
}

#[test]
fn a_package_without_exactly_one_payload_is_refused() {
    let dir = tempfile::tempdir().expect("tmp");
    let selection = ExtractSelection {
        strip_components: 0,
        only_under: None,
    };
    let none = write_package(dir.path(), &conda(&[]));
    assert!(matches!(
        extract_conda(&none, &dir.path().join("a"), selection, &mut |_, _| {}),
        Err(RuntimeError::InvalidArchive(_))
    ));
    let tar = tar_of(&[("a", b"a", tar::EntryType::Regular)]);
    let two = write_package(
        dir.path(),
        &conda(&[
            ("pkg-a-1-0.tar.zst", tar.clone()),
            ("pkg-b-1-0.tar.zst", tar),
        ]),
    );
    assert!(extract_conda(&two, &dir.path().join("b"), selection, &mut |_, _| {}).is_err());
    let not_zip = write_package(dir.path(), b"not a package");
    assert!(extract_conda(&not_zip, &dir.path().join("c"), selection, &mut |_, _| {}).is_err());
}
