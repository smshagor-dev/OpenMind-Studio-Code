//! OpenMind Studio's own packages on disk: finding the ones a source may offer, and checking a received one.
//!
//! A package is a release file (`OpenMind-Studio_<version>_<platform>_<arch>_setup.exe` / `..._portable.zip`) with its
//! updater signature beside it (`<file>.sig`, as the release publishes it). The signature check itself is the app's
//! (it holds the public key built into the program): it comes in as a [`Verifier`] — `(bytes, signature, version)` —
//! so this crate never decides on its own that something is trustworthy. A source offers only packages that pass that
//! same check on its own computer; a client checks again after downloading.

use std::io::Read;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::advert::{parse_release_name, PackageEntry, MAX_PACKAGES, MAX_PACKAGE_BYTES};

/// Checks `bytes` against a release signature made for `version`.
pub type Verifier<'a> = &'a (dyn Fn(&[u8], &str, &str) -> Result<(), String> + Sync);

/// The SHA-256 of a file (lowercase hex), read in pieces.
pub fn sha256_file(file: &Path) -> std::io::Result<String> {
    let mut reader = std::fs::File::open(file)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(crate::to_hex(&hasher.finalize()))
}

fn read_signature(sig: &Path) -> Result<String, String> {
    let text = std::fs::read_to_string(sig).map_err(|err| format!("{}: {err}", sig.display()))?;
    let text = text.trim().to_string();
    let base64 = !text.is_empty()
        && text.len() <= 2048
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='));
    if base64 {
        Ok(text)
    } else {
        Err(format!("{} is not an updater signature", sig.display()))
    }
}

/// What a folder offers: verified packages for `platform`, and a line for each file left out (and why).
pub fn scan_folder(
    folder: &Path,
    platform: &str,
    verifier: Verifier,
) -> (Vec<(PackageEntry, PathBuf)>, Vec<String>) {
    let mut offered = Vec::new();
    let mut problems = Vec::new();
    let Ok(entries) = std::fs::read_dir(folder) else {
        problems.push(format!("{} can't be read", folder.display()));
        return (offered, problems);
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    for name in names {
        let Some((version, file_platform, arch, kind)) = parse_release_name(&name) else {
            continue;
        };
        if file_platform != platform {
            continue;
        }
        if offered.len() >= MAX_PACKAGES {
            problems.push(format!(
                "{name}: more than {MAX_PACKAGES} packages; left out"
            ));
            continue;
        }
        let file = folder.join(&name);
        match describe(&file, &name, &version, arch, kind, verifier) {
            Ok(entry) => offered.push((entry, file)),
            Err(reason) => problems.push(format!("{name}: {reason}")),
        }
    }
    (offered, problems)
}

fn describe(
    file: &Path,
    name: &str,
    version: &str,
    arch: crate::Arch,
    kind: crate::advert::PackageKind,
    verifier: Verifier,
) -> Result<PackageEntry, String> {
    let signature = read_signature(&file.with_file_name(format!("{name}.sig")))?;
    let size = std::fs::metadata(file).map_err(|e| e.to_string())?.len();
    if size == 0 || size > MAX_PACKAGE_BYTES {
        return Err(format!("{size} bytes is not a package size"));
    }
    let bytes = std::fs::read(file).map_err(|e| e.to_string())?;
    verifier(&bytes, &signature, version)?;
    Ok(PackageEntry {
        name: name.to_string(),
        kind,
        arch,
        version: version.to_string(),
        size,
        sha256: crate::to_hex(&Sha256::digest(&bytes)),
        signature,
    })
}

/// Checks a received package against its manifest entry and its signature. On failure the caller deletes the file.
pub fn verify_file(file: &Path, entry: &PackageEntry, verifier: Verifier) -> Result<(), String> {
    let bytes = std::fs::read(file).map_err(|err| format!("{}: {err}", file.display()))?;
    verify_bytes(&bytes, entry, verifier)
}

/// [`verify_file`] for bytes already read — through a handle the caller keeps open, so the file can't be changed between
/// this check and its use.
pub fn verify_bytes(bytes: &[u8], entry: &PackageEntry, verifier: Verifier) -> Result<(), String> {
    if bytes.len() as u64 != entry.size {
        return Err(format!(
            "the package is {} bytes, not {}",
            bytes.len(),
            entry.size
        ));
    }
    if crate::to_hex(&Sha256::digest(bytes)) != entry.sha256 {
        return Err("the package's SHA-256 doesn't match".into());
    }
    verifier(bytes, &entry.signature, &entry.version)
        .map_err(|reason| format!("the package's signature was refused: {reason}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::advert::{release_name, PackageKind};
    use crate::Arch;

    /// A stand-in for the release key: a "signature" is `ok-<version>`, base64-safe.
    pub(crate) fn fake_verifier(_: &[u8], signature: &str, version: &str) -> Result<(), String> {
        if signature == format!("ok{}", version.replace(['.', '-'], "")) {
            Ok(())
        } else {
            Err("not signed by the release key".into())
        }
    }

    #[test]
    fn only_signed_release_files_of_this_platform_are_offered() {
        let dir = tempfile::tempdir().expect("dir");
        let good = release_name("1.0.3", "windows", Arch::X64, PackageKind::Installer);
        std::fs::write(dir.path().join(&good), b"setup bytes").expect("file");
        std::fs::write(dir.path().join(format!("{good}.sig")), "ok103").expect("sig");
        let forged = release_name("1.0.3", "windows", Arch::X86, PackageKind::Installer);
        std::fs::write(dir.path().join(&forged), b"evil").expect("file");
        std::fs::write(dir.path().join(format!("{forged}.sig")), "ok999").expect("sig");
        let unsigned = release_name("1.0.3", "windows", Arch::X64, PackageKind::Portable);
        std::fs::write(dir.path().join(&unsigned), b"zip").expect("file");
        let linux = release_name("1.0.3", "linux", Arch::X64, PackageKind::Portable);
        std::fs::write(dir.path().join(&linux), b"tar").expect("file");
        std::fs::write(dir.path().join("notes.txt"), b"hi").expect("file");

        let (offered, problems) = scan_folder(dir.path(), "windows", &fake_verifier);
        assert_eq!(offered.len(), 1);
        assert_eq!(offered[0].0.name, good);
        assert_eq!(
            offered[0].0.sha256,
            sha256_file(&offered[0].1).expect("hash")
        );
        assert_eq!(problems.len(), 2, "{problems:?}");
    }

    #[test]
    fn a_received_file_must_match_size_checksum_and_signature() {
        let dir = tempfile::tempdir().expect("dir");
        let name = release_name("1.0.3", "windows", Arch::X64, PackageKind::Installer);
        let file = dir.path().join(&name);
        std::fs::write(&file, b"setup bytes").expect("file");
        let entry = PackageEntry {
            name,
            kind: PackageKind::Installer,
            arch: Arch::X64,
            version: "1.0.3".into(),
            size: 11,
            sha256: sha256_file(&file).expect("hash"),
            signature: "ok103".into(),
        };
        verify_file(&file, &entry, &fake_verifier).expect("good");
        let tampered = PackageEntry {
            signature: "ok102".into(),
            ..entry.clone()
        };
        assert!(verify_file(&file, &tampered, &fake_verifier).is_err());
        std::fs::write(&file, b"setup bytez").expect("changed");
        assert!(verify_file(&file, &entry, &fake_verifier)
            .expect_err("changed")
            .contains("SHA-256"));
    }
}
