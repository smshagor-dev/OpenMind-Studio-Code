//! Building a pack (used by `scripts/prepare-lsp-bundle.mjs` through the
//! `bundle-pack` example, and by tests): a ZIP of a folder with forward-slash
//! names in a stable order. Links are refused, so a pack can never carry one.

use std::fs::{self, File};
use std::io;
use std::path::Path;

use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

use crate::error::LspError;

fn fail(text: impl Into<String>) -> LspError {
    LspError::InstallFailed(text.into())
}

/// Zips every file under `src` into `out`. Returns how many files were added.
pub fn create_pack(src: &Path, out: &Path) -> Result<usize, LspError> {
    let file = File::create(out).map_err(|err| fail(format!("{}: {err}", out.display())))?;
    let mut writer = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(9))
        .large_file(true);
    let mut count = 0;
    add_dir(&mut writer, src, "", options, &mut count)?;
    writer
        .finish()
        .map_err(|err| fail(format!("{}: {err}", out.display())))?;
    Ok(count)
}

fn add_dir(
    writer: &mut zip::ZipWriter<File>,
    dir: &Path,
    prefix: &str,
    options: SimpleFileOptions,
    count: &mut usize,
) -> Result<(), LspError> {
    let mut entries: Vec<fs::DirEntry> = fs::read_dir(dir)
        .map_err(|err| fail(format!("{}: {err}", dir.display())))?
        .collect::<Result<_, _>>()
        .map_err(|err| fail(format!("{}: {err}", dir.display())))?;
    entries.sort_by_key(fs::DirEntry::file_name);
    for entry in entries {
        let kind = entry
            .file_type()
            .map_err(|err| fail(format!("{}: {err}", entry.path().display())))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let path_in_zip = format!("{prefix}{name}");
        if kind.is_symlink() {
            return Err(fail(format!(
                "{path_in_zip} is a link; packs can't hold links"
            )));
        }
        if kind.is_dir() {
            add_dir(
                writer,
                &entry.path(),
                &format!("{path_in_zip}/"),
                options,
                count,
            )?;
        } else {
            writer
                .start_file(path_in_zip.as_str(), options)
                .map_err(|err| fail(format!("{path_in_zip}: {err}")))?;
            let mut input = File::open(entry.path())
                .map_err(|err| fail(format!("{}: {err}", entry.path().display())))?;
            io::copy(&mut input, writer).map_err(|err| fail(format!("{path_in_zip}: {err}")))?;
            *count += 1;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pack_holds_every_file_with_forward_slash_names() {
        let root = tempfile::tempdir().expect("tempdir");
        let src = root.path().join("My Pack");
        fs::create_dir_all(src.join("node_modules/a b")).expect("mkdir");
        fs::write(src.join("node_modules/a b/index.js"), "x").expect("w");
        fs::write(src.join("package.json"), "{}").expect("w");
        let out = root.path().join("p.zip");
        assert_eq!(create_pack(&src, &out).expect("pack"), 2);
        let archive = zip::ZipArchive::new(File::open(&out).expect("open")).expect("zip");
        let names: Vec<&str> = archive.file_names().collect();
        assert!(names.contains(&"node_modules/a b/index.js"));
        assert!(names.contains(&"package.json"));
    }
}
