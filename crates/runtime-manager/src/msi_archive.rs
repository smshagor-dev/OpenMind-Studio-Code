//! A Windows Installer package read as an archive (python.org's `tcltk.msi`): the files of its embedded cabinet(s)
//! are written to the folders its `Directory`/`Component`/`File` tables name. Nothing is installed through Windows
//! Installer — its registry entries, shortcuts and custom actions are ignored — and every path goes through the same
//! safety checks as a zip entry, so nothing can land outside the destination.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, Cursor, Read};
use std::path::{Path, PathBuf};

use crate::error::RuntimeError;
use crate::extract::{select_entry, ExtractSelection, MAX_EXTRACTED_BYTES};

/// More files than any runtime package has; guards against a hostile table.
const MAX_FILES: usize = 100_000;

fn invalid(message: impl std::fmt::Display) -> RuntimeError {
    RuntimeError::InvalidArchive(format!("MSI package: {message}"))
}

/// `short|long` -> `long`; a `target:source` pair -> the target.
fn long_name(field: &str) -> &str {
    let target = field.split(':').next().unwrap_or(field);
    target.rsplit('|').next().unwrap_or(target)
}

fn text(row: &msi::Row, column: &str) -> String {
    row[column].as_str().unwrap_or_default().to_string()
}

/// Each `Directory` id -> its path inside the package ("DLLs", "Lib/tkinter", "" for the root).
fn directory_paths(
    package: &mut msi::Package<File>,
) -> Result<HashMap<String, String>, RuntimeError> {
    let mut entries: HashMap<String, (String, String)> = HashMap::new();
    for row in package
        .select_rows(msi::Select::table("Directory"))
        .map_err(invalid)?
    {
        entries.insert(
            text(&row, "Directory"),
            (
                text(&row, "Directory_Parent"),
                long_name(&text(&row, "DefaultDir")).to_string(),
            ),
        );
    }
    let mut paths = HashMap::new();
    for id in entries.keys() {
        let mut parts = Vec::new();
        let mut current = id.clone();
        // A parent chain longer than the table is a loop.
        for _ in 0..=entries.len() {
            let Some((parent, name)) = entries.get(&current) else {
                break;
            };
            // The root's own name (`SourceDir`) and `.` add no folder.
            if !parent.is_empty() && parent != &current && name != "." {
                parts.push(name.clone());
            }
            if parent.is_empty() || parent == &current {
                break;
            }
            current = parent.clone();
        }
        parts.reverse();
        paths.insert(id.clone(), parts.join("/"));
    }
    Ok(paths)
}

/// Each `File` key (the name inside the cabinet) -> its path inside the package.
fn file_paths(package: &mut msi::Package<File>) -> Result<HashMap<String, String>, RuntimeError> {
    let directories = directory_paths(package)?;
    let mut component_dir = HashMap::new();
    for row in package
        .select_rows(msi::Select::table("Component"))
        .map_err(invalid)?
    {
        component_dir.insert(text(&row, "Component"), text(&row, "Directory_"));
    }
    let mut files = HashMap::new();
    for row in package
        .select_rows(msi::Select::table("File"))
        .map_err(invalid)?
    {
        let directory = component_dir
            .get(&text(&row, "Component_"))
            .and_then(|dir| directories.get(dir))
            .ok_or_else(|| invalid("a file's component has no folder"))?;
        let name = long_name(&text(&row, "FileName")).to_string();
        let path = if directory.is_empty() {
            name
        } else {
            format!("{directory}/{name}")
        };
        files.insert(text(&row, "File"), path);
        if files.len() > MAX_FILES {
            return Err(invalid("too many files"));
        }
    }
    Ok(files)
}

/// The embedded cabinets (`#name` in the `Media` table). A cabinet outside the package is refused.
fn cabinets(package: &mut msi::Package<File>) -> Result<Vec<Vec<u8>>, RuntimeError> {
    let mut names = Vec::new();
    for row in package
        .select_rows(msi::Select::table("Media"))
        .map_err(invalid)?
    {
        let cabinet = text(&row, "Cabinet");
        if cabinet.is_empty() {
            continue;
        }
        let Some(stream) = cabinet.strip_prefix('#') else {
            return Err(invalid(format!(
                "the cabinet \"{cabinet}\" is outside the package"
            )));
        };
        names.push(stream.to_string());
    }
    let mut data = Vec::new();
    for name in names {
        let mut bytes = Vec::new();
        package
            .read_stream(&name)
            .and_then(|mut stream| stream.read_to_end(&mut bytes))
            .map_err(invalid)?;
        data.push(bytes);
    }
    Ok(data)
}

/// Extracts every file of the package into `dest` (created if needed). Reports `(files done, total files)`.
pub fn extract_msi(
    archive: &Path,
    dest: &Path,
    selection: ExtractSelection<'_>,
    progress: &mut dyn FnMut(u64, Option<u64>),
) -> Result<(), RuntimeError> {
    let mut package = msi::open(archive).map_err(invalid)?;
    let files = file_paths(&mut package)?;
    let cabinets = cabinets(&mut package)?;
    fs::create_dir_all(dest).map_err(|err| RuntimeError::io(dest, err))?;
    let total = files.len() as u64;
    let (mut done, mut written) = (0u64, 0u64);
    for data in cabinets {
        let mut cabinet = cab::Cabinet::new(Cursor::new(data)).map_err(invalid)?;
        let entries: Vec<(String, u64)> = cabinet
            .folder_entries()
            .flat_map(|folder| {
                folder
                    .file_entries()
                    .map(|entry| {
                        (
                            entry.name().to_string(),
                            u64::from(entry.uncompressed_size()),
                        )
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        for (name, size) in entries {
            // A cabinet file the tables don't list is not part of the package.
            let Some(inside) = files.get(&name) else {
                continue;
            };
            let Some(relative) = select_entry(inside, selection)? else {
                continue;
            };
            written = written.saturating_add(size);
            if written > MAX_EXTRACTED_BYTES {
                return Err(RuntimeError::UnsafeArchive(
                    "the package unpacks to more than the size limit".into(),
                ));
            }
            write_entry(&mut cabinet, &name, &dest.join(relative))?;
            done += 1;
            progress(done, Some(total));
        }
    }
    Ok(())
}

fn write_entry(
    cabinet: &mut cab::Cabinet<Cursor<Vec<u8>>>,
    name: &str,
    target: &PathBuf,
) -> Result<(), RuntimeError> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|err| RuntimeError::io(parent, err))?;
    }
    let mut reader = cabinet.read_file(name).map_err(invalid)?;
    let mut out = File::create(target).map_err(|err| RuntimeError::io(target, err))?;
    io::copy(&mut reader, &mut out).map_err(|err| RuntimeError::io(target, err))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn msi_names_use_the_long_target_name() {
        assert_eq!(long_name("TCL|tcl"), "tcl");
        assert_eq!(long_name("tkinter"), "tkinter");
        assert_eq!(long_name("LIB~1|Lib:SRC|Source"), "Lib");
        assert_eq!(long_name("."), ".");
    }

    #[test]
    fn a_file_that_is_not_a_windows_installer_package_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = dir.path().join("fake.msi");
        fs::write(&fake, b"not an msi").expect("write");
        let error = extract_msi(
            &fake,
            &dir.path().join("out"),
            ExtractSelection::default(),
            &mut |_, _| {},
        )
        .expect_err("refused");
        assert!(matches!(error, RuntimeError::InvalidArchive(_)), "{error}");
        assert!(!dir.path().join("out").exists());
    }

    /// The real python.org package, when a copy is at `OPENMIND_TEST_TCLTK_MSI`.
    #[test]
    fn the_real_tcltk_package_extracts_to_the_python_layout() {
        let Some(msi) = std::env::var_os("OPENMIND_TEST_TCLTK_MSI") else {
            eprintln!("skipped: OPENMIND_TEST_TCLTK_MSI is not set");
            return;
        };
        let dir = tempfile::tempdir().expect("tempdir");
        let mut last = (0, None);
        extract_msi(
            Path::new(&msi),
            dir.path(),
            ExtractSelection::default(),
            &mut |done, total| last = (done, total),
        )
        .expect("extract");
        for file in [
            "DLLs/_tkinter.pyd",
            "DLLs/tcl90.dll",
            "DLLs/tcl9tk90.dll",
            "Lib/tkinter/__init__.py",
            "tcl/tk9.0/demos/README",
        ] {
            assert!(dir.path().join(file).is_file(), "{file}");
        }
        assert_eq!(last.0, 317);
        assert_eq!(last.1, Some(317));
    }
}
