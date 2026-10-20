//! PascalABC.NET through the real Runtime Manager and its built-in manifest, without a network: the official archive is
//! taken from the download cache (where OpenMind's bundled copy is put), a corrupted one is refused, and the install
//! keeps working after the app folder moves. The real-archive tests need `OPENMIND_TEST_PASCALABC_ZIP` = the official
//! `PABCNETC.zip` (SHA-256 256eb56f…); without it they say so and pass without checking anything.

#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use openmind_db::Db;
use openmind_runtime_manager::manager::ProgressSink;
use openmind_runtime_manager::{
    HttpClient, HttpResponse, RuntimeError, RuntimeManager, RuntimePaths, RuntimeRegistry,
};

const KIND: &str = "pascalabc";
const VERSION: &str = "4.0.0.3883";

/// The network: refuses everything, or serves fixed bytes for any address.
struct Network(Option<Vec<u8>>);

impl HttpClient for Network {
    fn get(&self, _url: &str, _range_from: Option<u64>) -> Result<HttpResponse, RuntimeError> {
        let body = self
            .0
            .clone()
            .ok_or_else(|| RuntimeError::Download("no network in this test".into()))?;
        Ok(HttpResponse {
            status: 200,
            content_length: Some(body.len() as u64),
            body: Box::new(std::io::Cursor::new(body)),
        })
    }
}

/// The database sits beside the app folder (`<root>/../db/test.db`), so the folder can be renamed while the pool is
/// open, as `relocation.rs` does; a real move happens with the app closed.
async fn manager(root: &Path, network: Network) -> RuntimeManager {
    let db = Db::connect(&root.parent().expect("parent").join("db").join("test.db"))
        .await
        .expect("db");
    RuntimeManager::new(
        db,
        RuntimePaths::new(root.join("runtimes"), root.join("cache")),
        RuntimeRegistry::builtin(),
        Arc::new(network),
        "windows-x64",
    )
}

fn no_progress() -> ProgressSink {
    Arc::new(|_| {})
}

fn official_zip() -> Option<PathBuf> {
    let zip = std::env::var_os("OPENMIND_TEST_PASCALABC_ZIP").map(PathBuf::from);
    if zip.is_none() {
        eprintln!("skipped: OPENMIND_TEST_PASCALABC_ZIP is not set");
    }
    zip
}

/// Puts `bytes` where the manager looks before downloading (what the bundled copy does).
fn seed_cache(manager: &RuntimeManager, bytes: &[u8]) {
    let manifest = RuntimeRegistry::builtin()
        .get(KIND)
        .expect("manifest")
        .clone();
    let artifact = manifest.artifact(VERSION, "windows-x64").expect("artifact");
    let cached = manager
        .paths()
        .download_path(&artifact.sha256, &artifact.url);
    std::fs::create_dir_all(cached.parent().expect("parent")).expect("cache dir");
    std::fs::write(cached, bytes).expect("seed");
}

fn compile(compiler: &Path, source: &Path, output: &Path) -> (bool, String) {
    let result = Command::new(compiler)
        .arg(format!("/Output:{}", output.display()))
        .arg(source)
        .output()
        .expect("compiler");
    (
        result.status.success(),
        String::from_utf8_lossy(&result.stdout).into_owned(),
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn the_official_archive_installs_offline_with_its_cyrillic_unit_and_survives_a_move() {
    let Some(zip) = official_zip() else {
        return;
    };
    let temp = tempfile::tempdir().expect("tempdir");
    let first = temp.path().join("OpenMind Studio ü");
    let manager = manager(&first, Network(None)).await;
    seed_cache(&manager, &std::fs::read(&zip).expect("zip"));

    let installed = manager
        .install(KIND, None, no_progress())
        .await
        .expect("install");
    assert_eq!(installed.version, VERSION);
    assert!(installed.healthy);
    assert!(
        installed.features.iter().all(|f| f.available),
        "{:?}",
        installed.features
    );
    let dir = manager.paths().version_dir(KIND, VERSION).expect("dir");
    assert!(
        dir.join("Lib").join("Мозаика.pcu").is_file(),
        "cp866 entry name decoded"
    );
    assert!(!dir.join("Lib").join("îºíáΦ¬á.pcu").exists());
    let listed = manager.list().await.expect("list");
    let abc = listed.iter().find(|r| r.id == KIND).expect("listed");
    assert_eq!(abc.active_version.as_deref(), Some(VERSION));
    let environment = manager.environment().await.expect("environment");
    assert!(environment.path_prepend.iter().any(|p| p == &dir));
    let version = Command::new(dir.join("pabcnetcclear.exe"))
        .arg("/Version:")
        .output()
        .expect("version");
    assert_eq!(String::from_utf8_lossy(&version.stdout).trim(), VERSION);

    // Move the whole app folder: nothing records an absolute path.
    drop(manager);
    let moved = temp.path().join("moved copy");
    std::fs::rename(&first, &moved).expect("move");
    // Same database (it records the old folder), new app folder.
    let manager = self::manager(&moved, Network(None)).await;
    let listed = manager.list().await.expect("list");
    let abc = listed.iter().find(|r| r.id == KIND).expect("listed");
    assert!(abc
        .installed
        .iter()
        .any(|v| v.version == VERSION && v.healthy));
    let dir = manager.paths().version_dir(KIND, VERSION).expect("dir");
    let source = temp.path().join("hello.pas");
    std::fs::write(&source, "begin\n  WriteLn('moved');\nend.\n").expect("source");
    let output = temp.path().join("out").join("hello.exe");
    std::fs::create_dir_all(output.parent().expect("parent")).expect("out");
    let (built, text) = compile(&dir.join("pabcnetcclear.exe"), &source, &output);
    assert!(built, "{text}");
    let ran = Command::new(&output).output().expect("program");
    assert_eq!(String::from_utf8_lossy(&ran.stdout).trim(), "moved");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_corrupted_download_is_refused_and_leaves_nothing_installed() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("app");
    // Whatever the network hands over, it isn't the pinned file.
    let manager = manager(
        &root,
        Network(Some(b"PK\x03\x04 not the official archive".to_vec())),
    )
    .await;
    let err = manager
        .install(KIND, None, no_progress())
        .await
        .expect_err("refused");
    assert!(
        err.user_message().to_lowercase().contains("checksum")
            || err.user_message().to_lowercase().contains("sha"),
        "{}",
        err.user_message()
    );
    let listed = manager.list().await.expect("list");
    assert!(listed
        .iter()
        .find(|r| r.id == KIND)
        .expect("listed")
        .installed
        .is_empty());
    // No version folder and no staging folder; the version's OS lock file (`<version>.lock`) stays by design.
    let versions = root.join("runtimes").join(KIND).join("versions");
    let left: Vec<String> = std::fs::read_dir(&versions)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|name| !name.ends_with(".lock"))
                .collect()
        })
        .unwrap_or_default();
    assert!(left.is_empty(), "{left:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_network_or_a_cached_copy_the_install_fails_with_a_reason() {
    let temp = tempfile::tempdir().expect("tempdir");
    let manager = manager(&temp.path().join("app"), Network(None)).await;
    let err = manager
        .install(KIND, None, no_progress())
        .await
        .expect_err("offline");
    assert!(!err.user_message().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn two_installs_at_once_end_with_one_healthy_copy() {
    let Some(zip) = official_zip() else {
        return;
    };
    let temp = tempfile::tempdir().expect("tempdir");
    let manager = manager(&temp.path().join("app"), Network(None)).await;
    seed_cache(&manager, &std::fs::read(&zip).expect("zip"));
    let (a, b) = tokio::join!(
        manager.install(KIND, None, no_progress()),
        manager.install(KIND, None, no_progress())
    );
    let ok = [a.is_ok(), b.is_ok()];
    assert!(ok.contains(&true), "{a:?} {b:?}");
    let listed = manager.list().await.expect("list");
    let abc = listed.iter().find(|r| r.id == KIND).expect("listed");
    assert_eq!(abc.installed.len(), 1);
    assert!(abc.installed[0].healthy);
}
