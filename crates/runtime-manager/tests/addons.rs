//! Add-ons installed into an installed version through a fake server: verified download, only missing files added,
//! nothing of the runtime overwritten, reported per version, and removed exactly.

#![cfg(windows)]

use std::collections::HashMap;
use std::io::{Cursor, Write};
use std::sync::Arc;

use openmind_db::Db;
use openmind_runtime_manager::manager::ProgressSink;
use openmind_runtime_manager::{
    HttpClient, HttpResponse, RuntimeError, RuntimeManager, RuntimeManifest, RuntimePaths,
    RuntimeRegistry,
};
use sha2::{Digest, Sha256};

const RUNTIME_URL: &str = "https://example.com/runtime.zip";
const ADDON_URL: &str = "https://example.com/gui.zip";

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

fn zip(entries: &[(&str, &str)]) -> Vec<u8> {
    let mut buffer = Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut buffer);
        for (name, data) in entries {
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .expect("file");
            writer.write_all(data.as_bytes()).expect("data");
        }
        writer.finish().expect("finish");
    }
    buffer.into_inner()
}

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

struct Fixture {
    dir: tempfile::TempDir,
    manager: RuntimeManager,
}

async fn fixture(addon_hash_override: Option<&str>) -> Fixture {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = zip(&[("demo.exe", "MZ"), ("DLLs/shared.dll", "runtime's own")]);
    let addon = zip(&[
        ("DLLs/shared.dll", "add-on copy"),
        ("DLLs/gui.pyd", "gui"),
        ("Lib/gui/__init__.py", "init"),
    ]);
    let addon_hash = addon_hash_override.map_or_else(|| sha(&addon), str::to_string);
    let json = format!(
        r#"{{
        "id": "demo", "displayName": "Demo", "description": "d", "defaultVersion": "1.0.0",
        "versionCommand": {{ "executable": "demo.exe", "args": ["--version"] }},
        "binDirs": ["."], "verifyFiles": ["demo.exe"],
        "versions": [{{ "version": "1.0.0",
            "artifacts": [{{ "platform": "windows-x64", "url": "{RUNTIME_URL}", "sha256": "{}", "archive": "zip" }}],
            "addons": [{{ "id": "gui", "label": "GUI support", "description": "Adds the GUI module.",
                "verifyFile": "DLLs/gui.pyd",
                "license": {{ "name": "Demo licence", "url": "https://example.com/licence" }},
                "artifacts": [{{ "platform": "windows-x64", "url": "{ADDON_URL}", "sha256": "{addon_hash}",
                    "archive": "zip", "sizeBytes": {} }}] }}] }}]
    }}"#,
        sha(&runtime),
        addon.len()
    );
    let manifest = RuntimeManifest::parse(&json).expect("manifest");
    let db = Db::connect(&dir.path().join("test.db")).await.expect("db");
    let manager = RuntimeManager::new(
        db,
        RuntimePaths::new(dir.path().join("my runtimes"), dir.path().join("cache")),
        RuntimeRegistry::from_manifests(vec![manifest]),
        Arc::new(Server(HashMap::from([
            (RUNTIME_URL.to_string(), runtime),
            (ADDON_URL.to_string(), addon),
        ]))),
        "windows-x64",
    );
    Fixture { dir, manager }
}

fn no_progress() -> ProgressSink {
    Arc::new(|_| {})
}

#[tokio::test(flavor = "multi_thread")]
async fn an_addon_adds_only_missing_files_is_reported_and_is_removed_exactly() {
    let fx = fixture(None).await;
    let dir = fx.dir.path().join("my runtimes/demo/versions/1.0.0");

    // Not before the runtime itself is installed.
    let early = fx
        .manager
        .install_addon("demo", "1.0.0", "gui", no_progress())
        .await;
    assert!(
        matches!(early, Err(RuntimeError::NotInstalled { .. })),
        "{early:?}"
    );

    let installed = fx
        .manager
        .install("demo", None, no_progress())
        .await
        .expect("install");
    assert_eq!(installed.addons.len(), 1);
    assert!(!installed.addons[0].installed && installed.addons[0].available);

    fx.manager
        .install_addon("demo", "1.0.0", "gui", no_progress())
        .await
        .expect("add-on");

    assert_eq!(
        std::fs::read_to_string(dir.join("DLLs/gui.pyd")).expect("gui"),
        "gui"
    );
    assert_eq!(
        std::fs::read_to_string(dir.join("DLLs/shared.dll")).expect("shared"),
        "runtime's own",
        "the runtime's own file is never overwritten"
    );
    let listed = fx.manager.list().await.expect("list");
    let status = &listed[0].installed[0].addons[0];
    assert!(status.installed);
    assert_eq!(
        status.license.as_ref().map(|l| l.name.as_str()),
        Some("Demo licence")
    );
    assert!(!fx
        .dir
        .path()
        .join("my runtimes/demo/versions/1.0.0-gui-addon.installing")
        .exists());

    fx.manager
        .remove_addon("demo", "1.0.0", "gui")
        .await
        .expect("remove");

    assert!(!dir.join("DLLs/gui.pyd").exists());
    assert!(!dir.join("Lib").exists(), "the folders it created went too");
    assert!(dir.join("DLLs/shared.dll").exists() && dir.join("demo.exe").exists());
    assert!(!dir.join(".openmind-addons").exists());
    let again = fx.manager.remove_addon("demo", "1.0.0", "gui").await;
    assert!(matches!(again, Err(RuntimeError::Addon(_))), "{again:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_download_with_the_wrong_checksum_adds_nothing() {
    let fx = fixture(Some(&"0".repeat(64))).await;
    let dir = fx.dir.path().join("my runtimes/demo/versions/1.0.0");
    fx.manager
        .install("demo", None, no_progress())
        .await
        .expect("install");

    let result = fx
        .manager
        .install_addon("demo", "1.0.0", "gui", no_progress())
        .await;

    assert!(result.is_err(), "{result:?}");
    assert!(!dir.join("DLLs/gui.pyd").exists());
    assert!(!dir.join(".openmind-addons").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_addon_is_refused() {
    let fx = fixture(None).await;
    fx.manager
        .install("demo", None, no_progress())
        .await
        .expect("install");
    let result = fx
        .manager
        .install_addon("demo", "1.0.0", "nope", no_progress())
        .await;
    assert!(matches!(result, Err(RuntimeError::Addon(_))), "{result:?}");
}
