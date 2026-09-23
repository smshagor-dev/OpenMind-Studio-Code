//! Shims and moving the app folder. A tiny `.cmd` stands in for the runtime;
//! the shim is the real generated one, run for real.

#![cfg(windows)]

use std::collections::HashMap;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use openmind_db::Db;
use openmind_runtime_manager::manager::ProgressSink;
use openmind_runtime_manager::{
    HttpClient, HttpResponse, RuntimeError, RuntimeManager, RuntimeManifest, RuntimePaths,
    RuntimeRegistry,
};
use sha2::{Digest, Sha256};

const URL: &str = "https://example.com/demo.zip";

struct Server(HashMap<String, Vec<u8>>);

impl HttpClient for Server {
    fn get(&self, url: &str, _range_from: Option<u64>) -> Result<HttpResponse, RuntimeError> {
        let body = self
            .0
            .get(url)
            .ok_or_else(|| RuntimeError::Download("offline".into()))?
            .clone();
        Ok(HttpResponse {
            status: 200,
            content_length: Some(body.len() as u64),
            body: Box::new(Cursor::new(body)),
        })
    }
}

fn archive() -> Vec<u8> {
    let mut buffer = Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut buffer);
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file("demo.cmd", options).expect("file");
        writer
            .write_all(b"@echo off\r\necho ran from %~dp0 with %*\r\n")
            .expect("data");
        writer.finish().expect("finish");
    }
    buffer.into_inner()
}

fn registry(hash: &str) -> RuntimeRegistry {
    let json = format!(
        r#"{{
        "id": "demo", "displayName": "Demo", "description": "d", "defaultVersion": "1.0.0",
        "versionCommand": {{ "executable": "demo.cmd", "args": [] }},
        "binDirs": ["."], "verifyFiles": ["demo.cmd"],
        "env": {{ "DEMO_FLAG": "1" }},
        "shims": [{{ "name": "dm", "target": "demo.cmd", "args": ["--flag"] }}],
        "versions": [{{ "version": "1.0.0", "artifacts": [{{
            "platform": "windows-x64", "url": "{URL}", "sha256": "{hash}", "archive": "zip" }}] }}]
    }}"#
    );
    RuntimeRegistry::from_manifests(vec![RuntimeManifest::parse(&json).expect("manifest")])
}

struct Fixture {
    /// Holds the app folder and the database folder.
    dir: tempfile::TempDir,
    manager: RuntimeManager,
}

fn hash_of(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The database is kept outside `app*` so the folder can be renamed while the
/// pool is open; a real relocation happens with the app closed.
async fn manager_at(dir: &Path, app: &str) -> RuntimeManager {
    let bytes = archive();
    let db = Db::connect(&dir.join("db").join("test.db"))
        .await
        .expect("db");
    RuntimeManager::new(
        db,
        RuntimePaths::new(dir.join(app).join("runtimes"), dir.join(app).join("cache")),
        registry(&hash_of(&bytes)),
        Arc::new(Server(HashMap::from([(URL.to_string(), bytes)]))),
        "windows-x64",
    )
}

async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().expect("tempdir");
    let manager = manager_at(dir.path(), "app").await;
    Fixture { dir, manager }
}

fn no_progress() -> ProgressSink {
    Arc::new(|_| {})
}

fn runtimes(fx: &Fixture) -> PathBuf {
    fx.dir.path().join("app").join("runtimes").join("demo")
}

fn run_shim(shim_dir: &Path, args: &str) -> String {
    let output = Command::new("cmd")
        .args(["/C", &format!("dm {args}")])
        .env("PATH", shim_dir)
        .env("PATHEXT", ".CMD")
        .output()
        .expect("run shim");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn install_writes_a_relative_shim_and_puts_its_folder_first_on_the_path() {
    let fx = fixture().await;
    fx.manager
        .install("demo", None, no_progress())
        .await
        .expect("install");

    let shim_dir = runtimes(&fx).join("shims").join("1.0.0");
    let script = std::fs::read_to_string(shim_dir.join("dm.cmd")).expect("shim");
    assert_eq!(
        script,
        "@echo off\r\n\"%~dp0..\\..\\versions\\1.0.0\\demo.cmd\" --flag %*\r\n"
    );
    assert!(
        !script.contains(fx.dir.path().to_string_lossy().as_ref()),
        "no absolute path may be baked in"
    );

    let environment = fx.manager.environment().await.expect("environment");
    assert_eq!(
        environment.path_prepend,
        vec![
            shim_dir.clone(),
            runtimes(&fx).join("versions").join("1.0.0")
        ]
    );
    assert!(environment
        .vars
        .iter()
        .any(|(key, value)| key == "DEMO_FLAG" && value == "1"));
    assert!(run_shim(&shim_dir, "hello").contains("with --flag hello"));
}

#[tokio::test(flavor = "multi_thread")]
async fn moving_the_app_folder_keeps_records_valid_and_the_shim_working() {
    let fx = fixture().await;
    fx.manager
        .install("demo", None, no_progress())
        .await
        .expect("install");
    let before = fx.manager.environment().await.expect("environment");
    drop(fx.manager);

    // The whole app folder moves; the database still records the old path.
    std::fs::rename(fx.dir.path().join("app"), fx.dir.path().join("moved")).expect("move");
    let moved = manager_at(fx.dir.path(), "moved").await;

    let listed = moved.list().await.expect("list");
    let version = &listed[0].installed[0];
    assert!(version.healthy);
    assert!(
        version.active,
        "active state lives in the database and survives"
    );
    assert!(
        version.path.contains("moved"),
        "paths are recomputed from the current root: {}",
        version.path
    );
    let after = moved.environment().await.expect("environment");
    assert_eq!(after.path_prepend.len(), before.path_prepend.len());
    assert!(after
        .path_prepend
        .iter()
        .all(|dir| dir.to_string_lossy().contains("moved")));
    assert!(run_shim(&after.path_prepend[0], "again").contains("with --flag again"));
}

#[tokio::test(flavor = "multi_thread")]
async fn delete_removes_the_shim_folder_along_with_the_version() {
    let fx = fixture().await;
    fx.manager
        .install("demo", None, no_progress())
        .await
        .expect("install");

    fx.manager.delete("demo", "1.0.0").await.expect("delete");

    assert!(!runtimes(&fx).join("versions").join("1.0.0").exists());
    assert!(!runtimes(&fx).join("shims").join("1.0.0").exists());
    assert!(fx
        .manager
        .environment()
        .await
        .expect("environment")
        .path_prepend
        .is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn repair_recreates_a_missing_shim_without_reinstalling() {
    let fx = fixture().await;
    fx.manager
        .install("demo", None, no_progress())
        .await
        .expect("install");
    let shim = runtimes(&fx).join("shims").join("1.0.0").join("dm.cmd");
    std::fs::remove_file(&shim).expect("remove shim");

    let repaired = fx
        .manager
        .repair("demo", "1.0.0", no_progress())
        .await
        .expect("repair");

    assert!(repaired);
    assert!(shim.is_file());
    assert!(!fx
        .manager
        .repair("demo", "1.0.0", no_progress())
        .await
        .expect("second repair"));
}

#[tokio::test(flavor = "multi_thread")]
async fn listing_or_launching_heals_missing_shims_so_an_older_install_gains_them() {
    let fx = fixture().await;
    fx.manager
        .install("demo", None, no_progress())
        .await
        .expect("install");
    std::fs::remove_dir_all(runtimes(&fx).join("shims")).expect("remove shims");

    // Launching a terminal (environment) restores them...
    let environment = fx.manager.environment().await.expect("environment");
    assert_eq!(environment.path_prepend.len(), 2);
    assert!(runtimes(&fx).join("shims/1.0.0/dm.cmd").is_file());

    // ...and so does simply opening the Runtime Manager (list).
    std::fs::remove_dir_all(runtimes(&fx).join("shims")).expect("remove shims");
    let listed = fx.manager.list().await.expect("list");
    assert!(listed[0].installed[0].healthy);
    assert!(runtimes(&fx).join("shims/1.0.0/dm.cmd").is_file());
}

#[tokio::test(flavor = "multi_thread")]
async fn if_the_shims_cannot_be_created_the_install_fails_cleanly() {
    let fx = fixture().await;
    // A file where the shims folder must go makes writing shims impossible.
    std::fs::create_dir_all(runtimes(&fx)).expect("runtimes");
    std::fs::write(runtimes(&fx).join("shims"), b"in the way").expect("blocker");

    let error = fx
        .manager
        .install("demo", None, no_progress())
        .await
        .expect_err("must fail");

    assert!(matches!(error, RuntimeError::Io { .. }), "{error}");
    assert!(!runtimes(&fx).join("versions").join("1.0.0").exists());
    let listed = fx.manager.list().await.expect("list");
    assert!(
        listed[0].installed.is_empty(),
        "nothing is reported installed"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn shims_of_a_version_that_no_longer_exists_are_cleaned_up() {
    let fx = fixture().await;
    let stray = runtimes(&fx).join("shims").join("9.9.9");
    std::fs::create_dir_all(&stray).expect("stray");
    std::fs::write(stray.join("dm.cmd"), b"x").expect("file");

    fx.manager.list().await.expect("list");

    assert!(!stray.exists());
}
