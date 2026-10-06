//! Native language servers (rust-analyzer, clangd) without the offline bundle: the release archive pinned in
//! `servers/bundle-sources.json` (the same address and SHA-256 the bundle is built from) is downloaded on the user's
//! request, checked and unpacked into `language-servers/<package>/<revision>/` — the folder the bundle would fill. The
//! download itself is done by the caller (the app's checksum-verifying downloader); this module owns the staging,
//! the check that every server's program is there, and the final rename.

use std::path::Path;

use serde::Deserialize;

use crate::error::LspError;
use crate::install;
use crate::manager::{LogLevel, LspManager, ServerState};
use crate::registry::{package_by_id, ServerDef, Source, SERVERS};

const SOURCES: &str = include_str!("../servers/bundle-sources.json");

/// Where a native package's archive comes from.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeDownload {
    pub package: String,
    pub revision: String,
    pub contents: String,
    pub url: String,
    /// Lowercase hex SHA-256 of the archive, checked before anything is unpacked.
    pub sha256: String,
    pub license: String,
    #[serde(default)]
    pub strip_components: usize,
    /// Files of the archive that are not needed (debug symbols): removed after unpacking.
    #[serde(default)]
    pub skip: Vec<String>,
    /// `zip` (default) or `conda` (a conda-forge package: a zip holding a zstd-compressed tar).
    #[serde(default)]
    pub archive: NativeArchive,
    /// Unpack only this folder of the archive, its prefix removed (`Library/bin` of a conda package).
    #[serde(default)]
    pub only_under: Option<String>,
    /// Further pinned archives unpacked into the same folder (DLLs the program needs), each checked like the first.
    #[serde(default)]
    pub parts: Vec<NativePart>,
}

/// The archive format of a native download.
#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NativeArchive {
    #[default]
    Zip,
    Conda,
}

/// One more pinned archive of a native package.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativePart {
    pub contents: String,
    pub url: String,
    pub sha256: String,
    pub license: String,
    #[serde(default)]
    pub archive: NativeArchive,
    #[serde(default)]
    pub strip_components: usize,
    #[serde(default)]
    pub only_under: Option<String>,
}

impl NativeDownload {
    /// Every archive to fetch and unpack, the main one first.
    pub fn pieces(&self) -> Vec<NativePart> {
        let main = NativePart {
            contents: self.contents.clone(),
            url: self.url.clone(),
            sha256: self.sha256.clone(),
            license: self.license.clone(),
            archive: self.archive,
            strip_components: self.strip_components,
            only_under: self.only_under.clone(),
        };
        std::iter::once(main)
            .chain(self.parts.iter().cloned())
            .collect()
    }
}

#[derive(Deserialize)]
struct Sources {
    native: Vec<NativeDownload>,
}

/// The pinned download of native package `package_id` for this app's revision of it, if there is one.
pub fn native_download(package_id: &str) -> Option<NativeDownload> {
    let package = package_by_id(package_id)?;
    if !matches!(package.source, Source::Native) {
        return None;
    }
    let sources: Sources = serde_json::from_str(SOURCES).ok()?;
    sources
        .native
        .into_iter()
        .find(|entry| entry.package == package.id && entry.revision == package.revision)
}

/// Moves an unpacked native package from `staging` into place: the unneeded files are dropped, every server of the
/// package must have its program, and only then is the folder renamed to its final place.
pub fn adopt(
    app_root: &Path,
    package_id: &str,
    staging: &Path,
    skip: &[String],
) -> Result<(), LspError> {
    let package = package_by_id(package_id).ok_or(LspError::Unsupported)?;
    for name in skip {
        if install::is_plain_relative(name) {
            let _ = std::fs::remove_file(staging.join(name));
        }
    }
    let missing: Vec<&str> = SERVERS
        .iter()
        .filter(|server| server.package == package.id && !staging.join(server.entry).is_file())
        .map(|server| server.id)
        .collect();
    if !missing.is_empty() {
        return Err(LspError::InstallFailed(format!(
            "the download is missing files for: {}",
            missing.join(", ")
        )));
    }
    install::move_into_place(app_root, package, staging)
}

impl LspManager {
    /// Installs a native package from its pinned download. `fetch` downloads, verifies and unpacks the archive into the
    /// staging folder it is given (logging through the function it gets); a failure leaves nothing behind.
    pub fn install_native(
        &self,
        def: &'static ServerDef,
        app_root: &Path,
        fetch: impl FnOnce(&NativeDownload, &Path, &dyn Fn(&str)) -> Result<(), String>,
    ) -> Result<(), LspError> {
        let download = native_download(def.package).ok_or_else(|| {
            LspError::InstallFailed(format!(
                "{} has no download; it ships only in the offline bundle.",
                def.name
            ))
        })?;
        let members = self.begin_install(def)?;
        self.log(
            def.id,
            LogLevel::Info,
            &format!("Installing {}...", download.contents),
        );
        let staging = install::staging_dir_of(app_root, def.package);
        let outcome = (|| {
            if staging.exists() {
                std::fs::remove_dir_all(&staging)
                    .map_err(|err| LspError::InstallFailed(err.to_string()))?;
            }
            std::fs::create_dir_all(&staging)
                .map_err(|err| LspError::InstallFailed(err.to_string()))?;
            let sink = self.clone();
            let id = def.id;
            fetch(&download, &staging, &move |line: &str| {
                sink.log(id, LogLevel::Info, line)
            })
            .map_err(LspError::InstallFailed)?;
            adopt(app_root, def.package, &staging, &download.skip)
        })();
        if outcome.is_err() {
            let _ = std::fs::remove_dir_all(&staging);
        }
        self.end_install(def, &members, &outcome);
        outcome
    }

    /// Marks every server of `def`'s package as installing (refused while one already is).
    fn begin_install(&self, def: &'static ServerDef) -> Result<Vec<&'static str>, LspError> {
        let members: Vec<&'static str> = SERVERS
            .iter()
            .filter(|server| server.package == def.package)
            .map(|server| server.id)
            .collect();
        if members
            .iter()
            .any(|id| self.status(id).state == ServerState::Installing)
        {
            return Err(LspError::InstallFailed("It is already installing.".into()));
        }
        for id in &members {
            self.set_state(id, ServerState::Installing);
        }
        Ok(members)
    }

    fn end_install(
        &self,
        def: &'static ServerDef,
        members: &[&'static str],
        outcome: &Result<(), LspError>,
    ) {
        let next = match outcome {
            Ok(()) => ServerState::Stopped,
            Err(err) => ServerState::Error {
                message: err.to_string(),
            },
        };
        for id in members {
            self.set_state(id, next.clone());
        }
        match outcome {
            Ok(()) => self.log(def.id, LogLevel::Info, "Installed."),
            Err(err) => self.log(def.id, LogLevel::Error, &err.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rust_analyzer_and_clangd_have_pinned_downloads() {
        for id in ["rust", "clangd"] {
            let download = native_download(id).expect(id);
            assert!(
                download.url.starts_with("https://github.com/"),
                "{}",
                download.url
            );
            assert_eq!(download.sha256.len(), 64);
            assert!(download.sha256.chars().all(|c| c.is_ascii_hexdigit()));
        }
        assert!(
            native_download("typescript").is_none(),
            "npm packages aren't native"
        );
        assert!(native_download("nope").is_none());
    }

    #[test]
    fn asm_lsp_comes_from_two_pinned_conda_forge_packages_unpacked_from_library_bin() {
        let download = native_download("asm-lsp").expect("asm-lsp");
        let pieces = download.pieces();
        assert_eq!(
            pieces.len(),
            2,
            "asm-lsp and the Visual C++ runtime DLLs it needs"
        );
        for piece in &pieces {
            assert!(
                piece
                    .url
                    .starts_with("https://conda.anaconda.org/conda-forge/win-64/"),
                "{}",
                piece.url
            );
            assert_eq!(piece.archive, NativeArchive::Conda);
            assert_eq!(piece.only_under.as_deref(), Some("Library/bin"));
            assert_eq!(piece.sha256.len(), 64);
        }
        assert!(pieces[0].url.contains("/asm-lsp-"));
        assert!(pieces[1].url.contains("/vc14_runtime-"));
    }

    #[test]
    fn adopting_requires_every_program_and_drops_the_skipped_files() {
        let tmp = tempfile::tempdir().expect("tmp");
        let staging = tmp
            .path()
            .join("language-servers")
            .join("rust")
            .join(".installing");
        std::fs::create_dir_all(&staging).expect("dir");
        std::fs::write(staging.join("rust_analyzer.pdb"), "debug").expect("pdb");
        let missing = adopt(tmp.path(), "rust", &staging, &["rust_analyzer.pdb".into()])
            .expect_err("missing");
        assert!(missing.to_string().contains("missing files"), "{missing}");
        std::fs::write(staging.join("rust-analyzer.exe"), "program").expect("exe");
        std::fs::write(staging.join("rust_analyzer.pdb"), "debug").expect("pdb");
        adopt(
            tmp.path(),
            "rust",
            &staging,
            &["rust_analyzer.pdb".into(), "../outside".into()],
        )
        .expect("adopt");
        let installed = tmp.path().join("language-servers").join("rust").join("1");
        assert!(installed.join("rust-analyzer.exe").is_file());
        assert!(!installed.join("rust_analyzer.pdb").exists());
        assert!(!staging.exists());
    }
}
