use std::collections::HashMap;
use std::io::Cursor;
use std::sync::Mutex;

use sha2::{Digest, Sha256};

use super::*;
use crate::download::HttpResponse;
use crate::extract::tests::build_zip;

/// Serves a fixed body per URL and counts requests; an unknown URL fails
/// like an offline machine would.
struct Routed {
    files: HashMap<String, Vec<u8>>,
    requests: Mutex<Vec<String>>,
}

impl HttpClient for Routed {
    fn get(&self, url: &str, _range_from: Option<u64>) -> Result<HttpResponse, RuntimeError> {
        self.requests.lock().expect("lock").push(url.to_string());
        let body = self
            .files
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

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn good_zip() -> Vec<u8> {
    build_zip(&[
        ("wrap/", b""),
        ("wrap/demo.exe", b"MZ-demo"),
        ("wrap/demo.cmd", b"@echo demo"),
        ("wrap/bin/tool.exe", b"tool"),
    ])
}

const URL_1: &str = "https://example.com/demo-1.0.0.zip";
const URL_2: &str = "https://example.com/demo-2.0.0.zip";

fn manifest_json(hash_1: &str, hash_2: &str, verify: &str, env: &str) -> String {
    format!(
        r#"{{
        "id": "demo", "displayName": "Demo", "description": "d", "defaultVersion": "2.0.0",
        "versionCommand": {{ "executable": "demo.exe", "args": ["--version"], "outputPrefix": "v" }},
        "binDirs": [".", "bin"], "verifyFiles": {verify}, "env": {env},
        "versions": [
          {{ "version": "1.0.0", "artifacts": [ {{ "platform": "windows-x64", "url": "{URL_1}", "sha256": "{hash_1}", "archive": "zip", "stripComponents": 1 }} ] }},
          {{ "version": "2.0.0", "artifacts": [ {{ "platform": "windows-x64", "url": "{URL_2}", "sha256": "{hash_2}", "archive": "zip", "stripComponents": 1 }} ] }},
          {{ "version": "3.0.0", "artifacts": [ {{ "platform": "linux-x64", "url": "https://example.com/x.zip", "sha256": "{hash_1}", "archive": "zip" }} ] }}
        ]
    }}"#
    )
}

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    manager: RuntimeManager,
    client: Arc<Routed>,
}

async fn fixture_with(files: Vec<(&str, Vec<u8>)>, manifest: String, platform: &str) -> Fixture {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().to_path_buf();
    let db = Db::connect(&root.join("test.db")).await.expect("db");
    let client = Arc::new(Routed {
        files: files.into_iter().map(|(u, b)| (u.to_string(), b)).collect(),
        requests: Mutex::new(Vec::new()),
    });
    let registry =
        RuntimeRegistry::from_manifests(vec![RuntimeManifest::parse(&manifest).expect("manifest")]);
    let manager = RuntimeManager::new(
        db,
        RuntimePaths::new(root.join("runtimes"), root.join("cache")),
        registry,
        client.clone(),
        platform,
    );
    Fixture {
        _dir: dir,
        root,
        manager,
        client,
    }
}

async fn fixture() -> Fixture {
    let zip = good_zip();
    let hash = sha(&zip);
    fixture_with(
        vec![(URL_1, zip.clone()), (URL_2, zip)],
        manifest_json(&hash, &hash, r#"["demo.exe", "demo.cmd"]"#, "{}"),
        "windows-x64",
    )
    .await
}

fn sink() -> (ProgressSink, Arc<Mutex<Vec<InstallProgress>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let store = seen.clone();
    (Arc::new(move |p| store.lock().expect("lock").push(p)), seen)
}

fn no_progress() -> ProgressSink {
    Arc::new(|_| {})
}

fn demo(statuses: Vec<RuntimeStatus>) -> RuntimeStatus {
    statuses
        .into_iter()
        .find(|s| s.id == "demo")
        .expect("demo status")
}

fn versions_dir(fx: &Fixture) -> PathBuf {
    fx.root.join("runtimes").join("demo").join("versions")
}

#[tokio::test]
async fn install_extracts_verifies_records_and_activates_the_first_version() {
    let fx = fixture().await;
    let (progress, seen) = sink();

    let installed = fx
        .manager
        .install("demo", Some("1.0.0"), progress)
        .await
        .expect("install");

    assert!(installed.active && installed.healthy);
    let dir = versions_dir(&fx).join("1.0.0");
    assert_eq!(fs::read(dir.join("demo.exe")).expect("exe"), b"MZ-demo");
    assert!(dir.join("bin").join("tool.exe").is_file());
    assert!(!versions_dir(&fx).join("1.0.0.installing").exists());

    let phases: Vec<InstallPhase> = seen.lock().expect("lock").iter().map(|p| p.phase).collect();
    let first = |phase| phases.iter().position(|p| *p == phase).expect("phase seen");
    assert!(first(InstallPhase::Download) < first(InstallPhase::Verify));
    assert!(first(InstallPhase::Verify) < first(InstallPhase::Extract));
    assert!(first(InstallPhase::Extract) < first(InstallPhase::Finalize));
    assert_eq!(phases.last(), Some(&InstallPhase::Done));

    let status = demo(fx.manager.list().await.expect("list"));
    assert_eq!(status.active_version.as_deref(), Some("1.0.0"));
    assert_eq!(status.installed.len(), 1);
    assert_eq!(status.available_versions, vec!["1.0.0", "2.0.0"]);
}

#[tokio::test]
async fn install_defaults_to_the_manifest_default_version() {
    let fx = fixture().await;

    let installed = fx
        .manager
        .install("demo", None, no_progress())
        .await
        .expect("install");

    assert_eq!(installed.version, "2.0.0");
}

#[tokio::test]
async fn installed_state_survives_a_restart_and_works_offline() {
    let fx = fixture().await;
    fx.manager
        .install("demo", Some("1.0.0"), no_progress())
        .await
        .expect("install");

    // "Restart": a new manager over the same database and folders, with no network at all.
    let offline = RuntimeManager::new(
        fx.manager.db.clone(),
        fx.manager.paths.clone(),
        (*fx.manager.registry).clone(),
        Arc::new(Routed {
            files: HashMap::new(),
            requests: Mutex::new(Vec::new()),
        }),
        "windows-x64",
    );

    let status = demo(offline.list().await.expect("list"));
    assert_eq!(status.active_version.as_deref(), Some("1.0.0"));
    assert!(status.installed[0].healthy);
    assert!(!offline
        .environment()
        .await
        .expect("env")
        .path_prepend
        .is_empty());
}

#[tokio::test]
async fn a_second_version_is_not_active_until_switched_and_environment_follows_the_switch() {
    let fx = fixture().await;
    fx.manager
        .install("demo", Some("1.0.0"), no_progress())
        .await
        .expect("install 1");
    let second = fx
        .manager
        .install("demo", Some("2.0.0"), no_progress())
        .await
        .expect("install 2");
    assert!(!second.active);
    let versions = versions_dir(&fx);

    let env = fx.manager.environment().await.expect("env");
    assert_eq!(
        env.path_prepend,
        vec![versions.join("1.0.0"), versions.join("1.0.0").join("bin")]
    );

    fx.manager
        .set_active("demo", "2.0.0")
        .await
        .expect("switch");

    let env = fx.manager.environment().await.expect("env");
    assert_eq!(
        env.path_prepend,
        vec![versions.join("2.0.0"), versions.join("2.0.0").join("bin")]
    );
    assert_eq!(
        demo(fx.manager.list().await.expect("list"))
            .active_version
            .as_deref(),
        Some("2.0.0")
    );
}

/// The environment is read again for every new terminal and run: an active runtime whose executable is gone (deleted
/// by hand, quarantined) leaves new environments at once instead of putting a dead folder first on PATH, and comes back
/// when it is repaired.
#[tokio::test]
async fn an_active_runtime_whose_executable_is_missing_leaves_new_environments() {
    let fx = fixture().await;
    fx.manager
        .install("demo", Some("1.0.0"), no_progress())
        .await
        .expect("install");
    let exe = versions_dir(&fx).join("1.0.0").join("demo.exe");
    assert!(!fx
        .manager
        .environment()
        .await
        .expect("env")
        .path_prepend
        .is_empty());

    fs::remove_file(&exe).expect("remove");
    assert!(fx
        .manager
        .environment()
        .await
        .expect("env")
        .path_prepend
        .is_empty());

    fs::write(&exe, b"MZ-demo").expect("restore");
    assert!(!fx
        .manager
        .environment()
        .await
        .expect("env")
        .path_prepend
        .is_empty());
}

#[tokio::test]
async fn switching_to_a_version_that_is_not_installed_fails_and_changes_nothing() {
    let fx = fixture().await;
    fx.manager
        .install("demo", Some("1.0.0"), no_progress())
        .await
        .expect("install");

    let result = fx.manager.set_active("demo", "2.0.0").await;

    assert!(matches!(result, Err(RuntimeError::NotInstalled { .. })));
    assert_eq!(
        demo(fx.manager.list().await.expect("list"))
            .active_version
            .as_deref(),
        Some("1.0.0")
    );
}

#[tokio::test]
async fn a_checksum_mismatch_installs_nothing_and_discards_the_download() {
    let zip = good_zip();
    let fx = fixture_with(
        vec![(URL_1, zip.clone()), (URL_2, zip)],
        manifest_json(&"0".repeat(64), &"0".repeat(64), r#"["demo.exe"]"#, "{}"),
        "windows-x64",
    )
    .await;

    let result = fx
        .manager
        .install("demo", Some("1.0.0"), no_progress())
        .await;

    assert!(matches!(result, Err(RuntimeError::ChecksumMismatch { .. })));
    assert!(!versions_dir(&fx).join("1.0.0").exists());
    assert!(!versions_dir(&fx).join("1.0.0.installing").exists());
    assert!(fs::read_dir(fx.root.join("cache").join("downloads"))
        .expect("dir")
        .next()
        .is_none());
    assert!(demo(fx.manager.list().await.expect("list"))
        .installed
        .is_empty());
}

#[tokio::test]
async fn a_zip_slip_archive_with_a_valid_checksum_is_still_refused_and_leaves_nothing() {
    let evil = build_zip(&[
        ("wrap/demo.exe", b"MZ"),
        ("wrap/../../escaped.txt", b"pwned"),
    ]);
    let hash = sha(&evil);
    let fx = fixture_with(
        vec![(URL_1, evil.clone()), (URL_2, evil)],
        manifest_json(&hash, &hash, r#"["demo.exe"]"#, "{}"),
        "windows-x64",
    )
    .await;

    let result = fx
        .manager
        .install("demo", Some("1.0.0"), no_progress())
        .await;

    assert!(matches!(result, Err(RuntimeError::UnsafeArchive(_))));
    assert!(!fx.root.join("runtimes").join("escaped.txt").exists());
    assert!(!versions_dir(&fx).join("1.0.0").exists());
    assert!(!versions_dir(&fx).join("1.0.0.installing").exists());
}

#[tokio::test]
async fn an_archive_missing_a_required_file_is_rejected() {
    let zip = build_zip(&[("wrap/demo.exe", b"MZ")]);
    let hash = sha(&zip);
    let fx = fixture_with(
        vec![(URL_1, zip.clone()), (URL_2, zip)],
        manifest_json(&hash, &hash, r#"["demo.exe", "demo.cmd"]"#, "{}"),
        "windows-x64",
    )
    .await;

    let result = fx
        .manager
        .install("demo", Some("1.0.0"), no_progress())
        .await;

    assert!(matches!(result, Err(RuntimeError::InvalidArchive(_))));
    assert!(demo(fx.manager.list().await.expect("list"))
        .installed
        .is_empty());
}

#[tokio::test]
async fn an_offline_install_fails_with_a_download_error_and_recovery_advice() {
    let zip = good_zip();
    let fx = fixture_with(
        vec![],
        manifest_json(&sha(&zip), &sha(&zip), r#"["demo.exe"]"#, "{}"),
        "windows-x64",
    )
    .await;

    let error = fx
        .manager
        .install("demo", Some("1.0.0"), no_progress())
        .await
        .expect_err("offline");

    assert!(matches!(error, RuntimeError::Download(_)));
    assert!(error.user_message().contains("internet connection"));
}

#[tokio::test]
async fn reinstalling_reuses_the_verified_cached_download_without_the_network() {
    let fx = fixture().await;
    fx.manager
        .install("demo", Some("1.0.0"), no_progress())
        .await
        .expect("install");
    fx.manager.delete("demo", "1.0.0").await.expect("delete");
    let before = fx.client.requests.lock().expect("lock").len();

    fx.manager
        .install("demo", Some("1.0.0"), no_progress())
        .await
        .expect("reinstall");

    assert_eq!(fx.client.requests.lock().expect("lock").len(), before);
}

#[tokio::test]
async fn unsupported_platform_unknown_version_and_unknown_runtime_are_typed_errors() {
    let zip = good_zip();
    let manifest = manifest_json(&sha(&zip), &sha(&zip), r#"["demo.exe"]"#, "{}");
    let linux = fixture_with(vec![], manifest, "linux-x64").await;

    assert!(matches!(
        linux
            .manager
            .install("demo", Some("1.0.0"), no_progress())
            .await,
        Err(RuntimeError::UnsupportedPlatform { .. })
    ));
    assert!(matches!(
        linux
            .manager
            .install("demo", Some("9.9.9"), no_progress())
            .await,
        Err(RuntimeError::UnknownVersion { .. })
    ));
    assert!(matches!(
        linux.manager.install("cobol", None, no_progress()).await,
        Err(RuntimeError::UnknownRuntime(_))
    ));
    assert!(matches!(
        linux
            .manager
            .install("demo", Some("../evil"), no_progress())
            .await,
        Err(RuntimeError::UnknownVersion { .. }) | Err(RuntimeError::InvalidName(_))
    ));
}

#[tokio::test]
async fn delete_removes_files_and_record_and_promotes_the_remaining_version() {
    let fx = fixture().await;
    fx.manager
        .install("demo", Some("1.0.0"), no_progress())
        .await
        .expect("install 1");
    fx.manager
        .install("demo", Some("2.0.0"), no_progress())
        .await
        .expect("install 2");

    fx.manager.delete("demo", "1.0.0").await.expect("delete");

    assert!(!versions_dir(&fx).join("1.0.0").exists());
    let status = demo(fx.manager.list().await.expect("list"));
    assert_eq!(status.installed.len(), 1);
    assert_eq!(status.active_version.as_deref(), Some("2.0.0"));
}

#[tokio::test]
async fn deleting_the_last_version_stops_injecting_it_and_deleting_twice_is_an_error() {
    let fx = fixture().await;
    fx.manager
        .install("demo", Some("1.0.0"), no_progress())
        .await
        .expect("install");

    fx.manager.delete("demo", "1.0.0").await.expect("delete");

    assert_eq!(
        fx.manager.environment().await.expect("env"),
        RuntimeEnvironment::default()
    );
    assert!(matches!(
        fx.manager.delete("demo", "1.0.0").await,
        Err(RuntimeError::NotInstalled { .. })
    ));
    assert!(demo(fx.manager.list().await.expect("list"))
        .active_version
        .is_none());
}

#[tokio::test]
async fn delete_ignores_a_tampered_database_path_and_only_touches_the_computed_folder() {
    let fx = fixture().await;
    fx.manager
        .install("demo", Some("1.0.0"), no_progress())
        .await
        .expect("install");
    let victim = fx.root.join("precious");
    fs::create_dir_all(&victim).expect("victim");
    fs::write(victim.join("keep.txt"), "keep").expect("write");
    InstalledRuntimesRepository::new(fx.manager.db.pool())
        .record("demo", "1.0.0", &victim.to_string_lossy())
        .await
        .expect("tamper");

    fx.manager.delete("demo", "1.0.0").await.expect("delete");

    assert!(victim.join("keep.txt").exists());
}

#[tokio::test]
async fn a_damaged_install_shows_unhealthy_and_repair_restores_it_keeping_it_active() {
    let fx = fixture().await;
    fx.manager
        .install("demo", Some("1.0.0"), no_progress())
        .await
        .expect("install 1");
    fx.manager
        .install("demo", Some("2.0.0"), no_progress())
        .await
        .expect("install 2");
    fx.manager
        .set_active("demo", "2.0.0")
        .await
        .expect("switch");
    let exe = versions_dir(&fx).join("2.0.0").join("demo.exe");
    fs::remove_file(&exe).expect("damage");
    let status = demo(fx.manager.list().await.expect("list"));
    assert!(
        !status
            .installed
            .iter()
            .find(|i| i.version == "2.0.0")
            .expect("v2")
            .healthy
    );
    assert!(fx
        .manager
        .environment()
        .await
        .expect("env")
        .path_prepend
        .iter()
        .all(|p| !p.ends_with("2.0.0")));

    let repaired = fx
        .manager
        .repair("demo", "2.0.0", no_progress())
        .await
        .expect("repair");

    assert!(repaired);
    assert!(exe.is_file());
    let status = demo(fx.manager.list().await.expect("list"));
    assert!(status.installed.iter().all(|i| i.healthy));
    assert_eq!(status.active_version.as_deref(), Some("2.0.0"));
}

#[tokio::test]
async fn repairing_a_healthy_install_changes_nothing_and_a_missing_one_is_an_error() {
    let fx = fixture().await;
    fx.manager
        .install("demo", Some("1.0.0"), no_progress())
        .await
        .expect("install");
    let before = fx.client.requests.lock().expect("lock").len();

    assert!(!fx
        .manager
        .repair("demo", "1.0.0", no_progress())
        .await
        .expect("repair"));
    assert_eq!(fx.client.requests.lock().expect("lock").len(), before);
    assert!(matches!(
        fx.manager.repair("demo", "2.0.0", no_progress()).await,
        Err(RuntimeError::NotInstalled { .. })
    ));
}

#[tokio::test]
async fn two_operations_on_the_same_version_cannot_overlap() {
    let fx = fixture().await;
    let held = fx.manager.acquire("demo", "1.0.0").expect("first");

    let second = fx
        .manager
        .install("demo", Some("1.0.0"), no_progress())
        .await;
    let other_version = fx.manager.acquire("demo", "2.0.0");

    assert!(matches!(second, Err(RuntimeError::Busy { .. })));
    assert!(other_version.is_ok());
    assert!(demo(fx.manager.list().await.expect("list")).busy);
    drop(held);
    assert!(fx.manager.acquire("demo", "1.0.0").is_ok());
}

#[tokio::test]
async fn reconcile_adopts_a_healthy_copied_in_install_and_cleans_stale_staging() {
    let fx = fixture().await;
    let versions = versions_dir(&fx);
    fs::create_dir_all(versions.join("1.0.0")).expect("dir");
    fs::write(versions.join("1.0.0").join("demo.exe"), "x").expect("exe");
    fs::write(versions.join("1.0.0").join("demo.cmd"), "x").expect("cmd");
    fs::create_dir_all(versions.join("2.0.0")).expect("half installed");
    fs::create_dir_all(versions.join("9.9.9.installing")).expect("stale staging");

    let status = demo(fx.manager.list().await.expect("list"));

    assert_eq!(status.installed.len(), 1);
    assert_eq!(status.installed[0].version, "1.0.0");
    assert!(status.installed[0].active);
    assert!(!versions.join("9.9.9.installing").exists());
}

#[tokio::test]
async fn environment_includes_manifest_variables_with_the_install_dir_substituted() {
    let zip = good_zip();
    let hash = sha(&zip);
    let fx = fixture_with(
        vec![(URL_1, zip.clone()), (URL_2, zip)],
        manifest_json(
            &hash,
            &hash,
            r#"["demo.exe"]"#,
            r#"{ "DEMO_HOME": "{dir}", "DEMO_FLAG": "1" }"#,
        ),
        "windows-x64",
    )
    .await;
    fx.manager
        .install("demo", Some("1.0.0"), no_progress())
        .await
        .expect("install");

    let env = fx.manager.environment().await.expect("env");

    let dir = versions_dir(&fx).join("1.0.0");
    assert!(env
        .vars
        .contains(&("DEMO_HOME".to_string(), dir.to_string_lossy().into_owned())));
    assert!(env
        .vars
        .contains(&("DEMO_FLAG".to_string(), "1".to_string())));
}

#[tokio::test]
async fn a_single_file_artifact_installs_with_its_seed_file_and_a_via_env_shim() {
    let phar = b"<?php echo 1;".to_vec();
    let hash = sha(&phar);
    let manifest = format!(
        r#"{{
        "id": "demo", "displayName": "Demo", "description": "d", "defaultVersion": "1.0.0",
        "versionCommand": {{ "executable": "demo.phar", "args": ["--version"] }},
        "binDirs": [], "verifyFiles": ["demo.phar", "demo.ini"], "env": {{}},
        "seedFiles": [{{ "path": "demo.ini", "content": "extension_dir = \"ext\"\n" }}],
        "shims": [{{ "name": "demo", "target": "demo.phar", "viaEnv": "DEMO_INTERPRETER" }}],
        "versions": [
          {{ "version": "1.0.0", "artifacts": [ {{ "platform": "windows-x64", "url": "{URL_1}", "sha256": "{hash}", "archive": "file", "installAs": "demo.phar" }} ] }}
        ]
    }}"#
    );
    let fx = fixture_with(vec![(URL_1, phar.clone())], manifest, "windows-x64").await;

    fx.manager
        .install("demo", None, no_progress())
        .await
        .expect("install");

    let dir = versions_dir(&fx).join("1.0.0");
    assert_eq!(std::fs::read(dir.join("demo.phar")).expect("phar"), phar);
    assert_eq!(
        std::fs::read_to_string(dir.join("demo.ini")).expect("ini"),
        "extension_dir = \"ext\"\n"
    );
    let shim_dir = fx
        .root
        .join("runtimes")
        .join("demo")
        .join("shims")
        .join("1.0.0");
    let shim_file = std::fs::read_dir(&shim_dir)
        .expect("shim dir")
        .filter_map(Result::ok)
        .next()
        .expect("a shim");
    let text = std::fs::read_to_string(shim_file.path()).expect("shim text");
    assert!(text.contains("DEMO_INTERPRETER"), "{text}");
    let env = fx.manager.environment().await.expect("env");
    assert_eq!(env.path_prepend, vec![shim_dir]);
}

#[tokio::test]
async fn nothing_installed_means_an_empty_environment() {
    let fx = fixture().await;

    assert_eq!(
        fx.manager.environment().await.expect("env"),
        RuntimeEnvironment::default()
    );
}
