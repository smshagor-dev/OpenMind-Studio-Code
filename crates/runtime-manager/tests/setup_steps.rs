//! Installs synthetic archives through a fake server to exercise extractRoot,
//! setup steps, feature reporting and PATH-injection order — the same code
//! path Python uses, with a tiny `.cmd` standing in for the interpreter.

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

const URL: &str = "https://example.com/pkg.nupkg";

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

fn package(setup_script: &str) -> Vec<u8> {
    let mut buffer = Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut buffer);
        let options = zip::write::SimpleFileOptions::default();
        for (name, data) in [
            ("pkg.nuspec", "metadata".as_bytes()),
            ("_rels/.rels", b"metadata"),
            ("tools/demo.exe", b"MZ"),
            ("tools/setup.cmd", setup_script.as_bytes()),
        ] {
            writer.start_file(name, options).expect("file");
            writer.write_all(data).expect("data");
        }
        writer.finish().expect("finish");
    }
    buffer.into_inner()
}

fn manifest(hash: &str, with_step: bool) -> RuntimeManifest {
    let step = if with_step {
        r#"[{ "description": "make the tool", "executable": "setup.cmd", "args": [] }]"#
    } else {
        "[]"
    };
    let json = format!(
        r#"{{
        "id": "demo", "displayName": "Demo", "description": "d", "defaultVersion": "1.0.0",
        "versionCommand": {{ "executable": "demo.exe", "args": ["--version"] }},
        "binDirs": [".", "Scripts"], "verifyFiles": ["demo.exe", "Scripts/tool.exe"],
        "postInstall": {step},
        "features": [{{ "id": "tool", "label": "tool", "verifyFile": "Scripts/tool.exe",
                        "missingNote": "tool is not set up" }}],
        "versions": [{{ "version": "1.0.0", "artifacts": [{{
            "platform": "windows-x64", "url": "{URL}", "sha256": "{hash}",
            "archive": "zip", "extractRoot": "tools" }}] }}]
    }}"#
    );
    RuntimeManifest::parse(&json).expect("manifest")
}

struct Fixture {
    dir: tempfile::TempDir,
    manager: RuntimeManager,
}

async fn fixture(setup_script: &str, with_step: bool) -> Fixture {
    let dir = tempfile::tempdir().expect("tempdir");
    let bytes = package(setup_script);
    let hash: String = Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let db = Db::connect(&dir.path().join("test.db")).await.expect("db");
    let manager = RuntimeManager::new(
        db,
        RuntimePaths::new(dir.path().join("runtimes"), dir.path().join("cache")),
        RuntimeRegistry::from_manifests(vec![manifest(&hash, with_step)]),
        Arc::new(Server(HashMap::from([(URL.to_string(), bytes)]))),
        "windows-x64",
    );
    Fixture { dir, manager }
}

fn no_progress() -> ProgressSink {
    Arc::new(|_| {})
}

const MAKE_TOOL: &str = "@echo off\r\nmkdir Scripts\r\necho x> Scripts\\tool.exe\r\n";

fn version_dir(fx: &Fixture) -> std::path::PathBuf {
    fx.dir.path().join("runtimes/demo/versions/1.0.0")
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_extract_root_is_installed_and_the_setup_step_runs_in_place() {
    let fx = fixture(MAKE_TOOL, true).await;

    let installed = fx
        .manager
        .install("demo", None, no_progress())
        .await
        .expect("install");

    let dir = version_dir(&fx);
    assert!(dir.join("demo.exe").is_file());
    assert!(dir.join("Scripts/tool.exe").is_file(), "the step ran");
    assert!(!dir.join("pkg.nuspec").exists());
    assert!(!dir.join(".rels").exists());
    assert!(installed.healthy);
    assert!(installed.features.iter().all(|f| f.available));
    assert!(!fx
        .dir
        .path()
        .join("runtimes/demo/versions/1.0.0.installing")
        .exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn injected_folders_follow_the_manifest_order_interpreter_first() {
    let fx = fixture(MAKE_TOOL, true).await;
    fx.manager
        .install("demo", None, no_progress())
        .await
        .expect("install");

    let environment = fx.manager.environment().await.expect("environment");

    let dir = version_dir(&fx);
    assert_eq!(
        environment.path_prepend,
        vec![dir.clone(), dir.join("Scripts")]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failing_setup_step_installs_nothing_and_records_nothing() {
    let fx = fixture("@echo off\r\necho boom 1>&2\r\nexit /b 2\r\n", true).await;

    let error = fx
        .manager
        .install("demo", None, no_progress())
        .await
        .expect_err("must fail");

    assert!(matches!(error, RuntimeError::PostInstall { .. }), "{error}");
    assert!(
        error.user_message().contains("boom"),
        "{}",
        error.user_message()
    );
    assert!(!version_dir(&fx).exists());
    let listed = fx.manager.list().await.expect("list");
    assert!(listed[0].installed.is_empty());
    assert!(fx
        .manager
        .environment()
        .await
        .expect("env")
        .path_prepend
        .is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_feature_is_reported_unavailable_with_its_reason_and_repair_restores_it() {
    let fx = fixture(MAKE_TOOL, true).await;
    fx.manager
        .install("demo", None, no_progress())
        .await
        .expect("install");
    std::fs::remove_file(version_dir(&fx).join("Scripts/tool.exe")).expect("remove tool");

    let damaged = fx.manager.list().await.expect("list");
    let version = &damaged[0].installed[0];
    assert!(!version.healthy);
    let tool = &version.features[0];
    assert!(!tool.available);
    assert_eq!(tool.note, "tool is not set up");
    // An unhealthy install is not injected into terminals.
    assert!(fx
        .manager
        .environment()
        .await
        .expect("env")
        .path_prepend
        .is_empty());

    assert!(fx
        .manager
        .repair("demo", "1.0.0", no_progress())
        .await
        .expect("repair"));

    let fixed = fx.manager.list().await.expect("list");
    assert!(fixed[0].installed[0].healthy);
    assert!(fixed[0].installed[0].features[0].available);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_archive_that_lacks_a_required_file_is_refused_when_no_step_could_create_it() {
    let fx = fixture(MAKE_TOOL, false).await;

    let error = fx
        .manager
        .install("demo", None, no_progress())
        .await
        .expect_err("must fail");

    assert!(matches!(error, RuntimeError::InvalidArchive(_)), "{error}");
    assert!(!version_dir(&fx).exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn delete_removes_the_folder_and_stops_injection() {
    let fx = fixture(MAKE_TOOL, true).await;
    fx.manager
        .install("demo", None, no_progress())
        .await
        .expect("install");

    fx.manager.delete("demo", "1.0.0").await.expect("delete");

    assert!(!version_dir(&fx).exists());
    assert!(fx
        .manager
        .environment()
        .await
        .expect("env")
        .path_prepend
        .is_empty());
}
