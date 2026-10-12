//! Unpacking a bundled pack into `language-servers/<package>/<revision>/`.
//! The archive's SHA256 is checked against `bundle.json` before anything is
//! written; every entry name must stay inside the target (no `..`, absolute or
//! drive paths), links are refused, and the total size and entry count are
//! capped. The files go to a staging folder that is renamed into place only
//! when every server of the package has its entry, so an interrupted unpack
//! leaves nothing half-there. A marker records which pack it came from.

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::bundle::{Bundle, PackEntry};
use crate::error::LspError;
use crate::install::package_dir;
use crate::registry::{Package, BUNDLED_TOOLS, SERVERS};

/// The file inside an unpacked package that names the pack it came from.
pub const MARKER: &str = ".openmind-bundle";
const MAX_UNPACKED_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 60_000;

fn fail(text: impl Into<String>) -> LspError {
    LspError::InstallFailed(text.into())
}

fn io_fail(path: &Path, err: io::Error) -> LspError {
    fail(format!("{}: {err}", path.display()))
}

/// Lowercase hex SHA256 of a file, streamed.
pub fn sha256_file(path: &Path) -> Result<String, LspError> {
    let mut file = File::open(path).map_err(|err| io_fail(path, err))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer).map_err(|err| io_fail(path, err))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// Which pack an unpacked package came from, if it came from one.
pub fn unpacked_from(app_root: &Path, package: &Package) -> Option<String> {
    fs::read_to_string(package_dir(app_root, package).join(MARKER))
        .ok()
        .map(|text| text.trim().to_ascii_lowercase())
}

/// Whether the package folder holds what `pack` would unpack. A folder installed
/// from npm (no marker) counts as current: it was built from the same lockfile.
pub fn is_current(app_root: &Path, package: &Package, pack: &PackEntry) -> bool {
    unpacked_from(app_root, package).is_none_or(|sha| sha.eq_ignore_ascii_case(&pack.sha256))
}

/// How long an unpack waits for another one of the same package (on this computer or another one sharing the folder)
/// before giving up. The biggest packs take well under a minute even over a network share.
pub const LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(600);

/// Unpacks `pack` for `package`, replacing an older unpacked copy.
///
/// Safe when several processes — on one computer or on several sharing `language-servers/` — ask at once:
/// - one unpack per package at a time, by an operating-system lock on `language-servers/<package>/.lock` (released by
///   the system when its holder exits, crashes or loses the network, so a dead holder never blocks anyone); the others
///   **wait** for it instead of failing;
/// - after the wait the folder is checked again: when the other process already unpacked this very pack, nothing is
///   done (no second extraction);
/// - each unpack extracts into its own staging folder (`.unpacking-<pid>-<n>`), verifies it, then publishes it with a
///   rename. A copy being replaced is first renamed away; if a running server holds its files the rename fails and the
///   old copy stays in place, untouched (the error says so) — an install another computer is using is never deleted;
/// - leftovers of an interrupted unpack (staging or set-aside folders) are removed only while holding the lock, i.e.
///   when provably nobody is using them.
pub fn unpack(
    app_root: &Path,
    bundle: &Bundle,
    pack: &PackEntry,
    package: &Package,
) -> Result<(), LspError> {
    if unpacked_current(app_root, package, pack) {
        return Ok(());
    }
    // Checked before anything is written (the archive is only read).
    let archive = bundle.pack_path(pack);
    let actual = sha256_file(&archive)?;
    if !actual.eq_ignore_ascii_case(&pack.sha256) {
        return Err(fail(format!(
            "the bundled archive {} is damaged (SHA256 {actual}, expected {}). Reinstall OpenMind Studio.",
            pack.file, pack.sha256
        )));
    }
    let base = app_root.join("language-servers").join(package.id);
    let _lock = PackageLock::acquire(&base, LOCK_WAIT)?;
    if unpacked_current(app_root, package, pack) {
        return Ok(()); // another process finished it while this one waited
    }
    clear_leftovers(&base);
    let staging = base.join(format!(".unpacking-{}-{}", std::process::id(), unique()));
    fs::create_dir_all(&staging).map_err(|err| io_fail(&staging, err))?;
    let outcome = extract(&archive, &staging)
        .and_then(|()| check_entries(&staging, package))
        .and_then(|()| {
            fs::write(
                staging.join(MARKER),
                format!("{}\n", pack.sha256.to_ascii_lowercase()),
            )
            .map_err(|err| io_fail(&staging, err))
        })
        .and_then(|()| publish(&staging, &package_dir(app_root, package)));
    if let Err(err) = outcome {
        let _ = fs::remove_dir_all(&staging);
        return Err(err);
    }
    remove_other_revisions(&base, package.revision);
    Ok(())
}

/// The package folder holds exactly `pack`, complete.
fn unpacked_current(app_root: &Path, package: &Package, pack: &PackEntry) -> bool {
    unpacked_from(app_root, package).is_some_and(|sha| sha.eq_ignore_ascii_case(&pack.sha256))
        && check_entries(&package_dir(app_root, package), package).is_ok()
}

/// Moves a verified staging folder into place. An existing copy is renamed away first and deleted afterwards; when its
/// files are in use the rename fails and it stays where it was.
fn publish(staging: &Path, final_dir: &Path) -> Result<(), LspError> {
    let retired = final_dir.with_file_name(format!(".retired-{}-{}", std::process::id(), unique()));
    let had_old = final_dir.exists();
    if had_old {
        fs::rename(final_dir, &retired).map_err(|err| {
            fail(format!(
                "{} is in use (a language server started from it is running, here or on another computer), so it \
                 was left as it is: {err}",
                final_dir.display()
            ))
        })?;
    }
    if let Err(err) = fs::rename(staging, final_dir) {
        if had_old {
            let _ = fs::rename(&retired, final_dir);
        }
        return Err(io_fail(final_dir, err));
    }
    if had_old {
        let _ = fs::remove_dir_all(&retired);
    }
    Ok(())
}

/// Staging and set-aside folders left by an unpack that stopped (a crash, a pulled cable). Called only while holding
/// the package's lock: no unpack can be using them.
fn clear_leftovers(base: &Path) {
    let Ok(entries) = fs::read_dir(base) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(".unpacking") || name.starts_with(".retired-") {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

fn unique() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default()
}

/// Holds `language-servers/<package_id>/.lock` (see [`unpack`]) — also taken by the npm, pip and native installs, so an
/// install and an unpack of one package (on any computer sharing the folder) never write the same files at once.
pub(crate) fn lock_package(app_root: &Path, package_id: &str) -> Result<impl Drop, LspError> {
    PackageLock::acquire(
        &app_root.join("language-servers").join(package_id),
        LOCK_WAIT,
    )
}

/// The operating-system lock on `language-servers/<package>/.lock` (see [`unpack`]).
struct PackageLock {
    _file: File,
}

impl Drop for PackageLock {
    fn drop(&mut self) {
        let _ = self._file.unlock();
    }
}

impl PackageLock {
    fn acquire(base: &Path, wait: std::time::Duration) -> Result<Self, LspError> {
        fs::create_dir_all(base).map_err(|err| io_fail(base, err))?;
        let path = base.join(".lock");
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|err| io_fail(&path, err))?;
        let deadline = std::time::Instant::now() + wait;
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(Self { _file: file }),
                Err(fs::TryLockError::WouldBlock) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
                Err(fs::TryLockError::WouldBlock) => {
                    return Err(fail(format!(
                        "another OpenMind Studio (here or on another computer) has been preparing {} for more than {} \
                         seconds; try again when it has finished",
                        base.display(),
                        wait.as_secs()
                    )))
                }
                Err(fs::TryLockError::Error(err)) => return Err(io_fail(&path, err)),
            }
        }
    }
}

fn check_entries(dir: &Path, package: &Package) -> Result<(), LspError> {
    let servers = SERVERS
        .iter()
        .filter(|server| server.package == package.id)
        .filter(|server| !dir.join(server.entry).is_file())
        .map(|server| server.id);
    let tools = BUNDLED_TOOLS
        .iter()
        .filter(|tool| tool.package == package.id)
        .filter(|tool| {
            std::iter::once(tool.entry)
                .chain(tool.plugins.iter().copied())
                .any(|path| !dir.join(path).is_file())
        })
        .map(|tool| tool.tool);
    let missing: Vec<&str> = servers.chain(tools).collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(fail(format!(
            "the bundled archive is missing files for: {}",
            missing.join(", ")
        )))
    }
}

/// Extracts a ZIP into `dest` under the rules above.
pub fn extract(archive_path: &Path, dest: &Path) -> Result<(), LspError> {
    let file = File::open(archive_path).map_err(|err| io_fail(archive_path, err))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|err| fail(format!("the bundled archive can't be opened: {err}")))?;
    if archive.len() > MAX_ENTRIES {
        return Err(fail("the bundled archive has too many entries"));
    }
    let mut written = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|err| fail(format!("the bundled archive is damaged: {err}")))?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(fail(format!("\"{}\" is a symbolic link", entry.name())));
        }
        let relative: PathBuf = match entry.enclosed_name() {
            Some(path) if !entry.name().contains(['\\', ':']) => path,
            _ => return Err(fail(format!("unsafe entry name \"{}\"", entry.name()))),
        };
        let target = dest.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|err| io_fail(&target, err))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|err| io_fail(parent, err))?;
        }
        let mut out = File::create(&target).map_err(|err| io_fail(&target, err))?;
        let limit = MAX_UNPACKED_BYTES - written;
        let copied = io::copy(&mut (&mut entry).take(limit), &mut out)
            .map_err(|err| io_fail(&target, err))?;
        written += copied;
        if written >= MAX_UNPACKED_BYTES {
            return Err(fail("the bundled archive expands to too much data"));
        }
    }
    Ok(())
}

fn remove_other_revisions(base: &Path, revision: &str) {
    let Ok(entries) = fs::read_dir(base) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // Only other revisions: never the lock file or anything in flight (dot-names).
        if name != revision && !name.starts_with('.') && entry.path().is_dir() {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::{bundle_dir, load};
    use crate::install::is_installed;
    use crate::pack::create_pack;
    use crate::registry::{package_by_id, server_by_id};
    use std::io::Write;

    /// A bundle in `root/lsp` holding one pack made from `files`.
    pub(super) fn bundle_with(
        root: &Path,
        files: &[(&str, &str)],
        sha_override: Option<&str>,
    ) -> Bundle {
        let src = root.join("src files");
        for (name, text) in files {
            let path = src.join(name);
            fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
            fs::write(path, text).expect("write");
        }
        let packs = bundle_dir(root).join("packs");
        fs::create_dir_all(&packs).expect("mkdir");
        let zip = packs.join("python-1.zip");
        create_pack(&src, &zip).expect("pack");
        let sha = sha_override.map_or_else(|| sha256_file(&zip).expect("sha"), str::to_string);
        let size = fs::metadata(&zip).expect("meta").len();
        let json = format!(
            r#"{{"format":"openmind-lsp-bundle","version":1,"platform":"windows-x64",
            "packs":[{{"package":"python","revision":"1","contents":"pyright",
            "file":"packs/python-1.zip","sha256":"{sha}","size":{size}}}]}}"#
        );
        fs::write(bundle_dir(root).join("bundle.json"), json).expect("json");
        load(root).expect("ok").expect("bundle")
    }

    pub(super) fn first_pack(bundle: &Bundle) -> PackEntry {
        bundle.packs.first().expect("pack").clone()
    }

    #[test]
    fn a_pack_unpacks_into_the_package_folder_with_a_marker() {
        let root = tempfile::tempdir().expect("tempdir");
        let app = root.path().join("My App");
        let bundle = bundle_with(
            &app,
            &[("node_modules/pyright/langserver.index.js", "// server")],
            None,
        );
        let pack = first_pack(&bundle);
        let package = package_by_id("python").expect("package");
        let server = server_by_id("python").expect("server");
        assert!(!is_installed(&app, server, package));
        fs::create_dir_all(app.join("language-servers/python/0")).expect("old revision");
        unpack(&app, &bundle, &pack, package).expect("unpack");
        assert!(is_installed(&app, server, package));
        assert_eq!(unpacked_from(&app, package), Some(pack.sha256.clone()));
        assert!(is_current(&app, package, &pack));
        assert!(!app.join("language-servers/python/0").exists());
        assert!(!app.join("language-servers/python/.unpacking").exists());
        // Unpacking again (e.g. a rebuilt bundle) replaces the folder.
        unpack(&app, &bundle, &pack, package).expect("again");
        assert!(is_installed(&app, server, package));
    }

    #[test]
    fn a_damaged_archive_is_refused_before_anything_is_written() {
        let root = tempfile::tempdir().expect("tempdir");
        let bundle = bundle_with(
            root.path(),
            &[("node_modules/pyright/langserver.index.js", "x")],
            Some(&"0".repeat(64)),
        );
        let package = package_by_id("python").expect("package");
        let err = unpack(root.path(), &bundle, &first_pack(&bundle), package).expect_err("bad");
        assert!(err.to_string().contains("damaged"), "{err}");
        assert!(!root.path().join("language-servers").exists());
    }

    #[test]
    fn a_pack_without_the_server_entry_leaves_nothing_behind() {
        let root = tempfile::tempdir().expect("tempdir");
        let bundle = bundle_with(root.path(), &[("readme.txt", "no server here")], None);
        let package = package_by_id("python").expect("package");
        let err = unpack(root.path(), &bundle, &first_pack(&bundle), package).expect_err("bad");
        assert!(err.to_string().contains("python"), "{err}");
        assert!(!package_dir(root.path(), package).exists());
        assert!(!root
            .path()
            .join("language-servers/python/.unpacking")
            .exists());
    }

    #[test]
    fn a_folder_from_another_pack_is_not_current_but_an_npm_install_is() {
        let root = tempfile::tempdir().expect("tempdir");
        let package = package_by_id("python").expect("package");
        let pack = PackEntry {
            package: "python".into(),
            revision: "1".into(),
            contents: String::new(),
            file: "packs/python-1.zip".into(),
            sha256: "a".repeat(64),
            size: 1,
            license: String::new(),
        };
        let dir = package_dir(root.path(), package);
        fs::create_dir_all(&dir).expect("mkdir");
        assert!(is_current(root.path(), package, &pack), "npm install");
        fs::write(dir.join(MARKER), "b".repeat(64)).expect("marker");
        assert!(!is_current(root.path(), package, &pack));
    }

    #[test]
    fn entries_that_escape_the_target_are_refused() {
        let root = tempfile::tempdir().expect("tempdir");
        for bad in [
            "../evil.txt",
            "a/../../evil.txt",
            "C:/evil.txt",
            r"a\..\..\evil.txt",
        ] {
            let zip_path = root.path().join("bad.zip");
            {
                let file = File::create(&zip_path).expect("create");
                let mut writer = zip::ZipWriter::new(file);
                writer
                    .start_file(bad, zip::write::SimpleFileOptions::default())
                    .expect("start");
                writer.write_all(b"x").expect("write");
                writer.finish().expect("finish");
            }
            let dest = root.path().join("out");
            let err = extract(&zip_path, &dest).expect_err(bad);
            assert!(err.to_string().contains("unsafe"), "{bad}: {err}");
            assert!(!root.path().join("evil.txt").exists());
        }
    }
}

#[cfg(test)]
#[path = "unpack_concurrency_tests.rs"]
mod concurrency_tests;
