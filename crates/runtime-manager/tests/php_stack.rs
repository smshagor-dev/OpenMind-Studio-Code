//! The shipped PHP and Composer manifests, installed for real from fake
//! (but correctly checksummed) archives: the install layout, PATH order, the
//! injected `OPENMIND_PHP`, the seeded `php.ini`, and the Composer launcher —
//! run for real, including after the app folder moves. Nothing touches the network.

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

fn hash_of(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A stand-in for windows.php.net's zip: the files the manifest verifies.
fn php_zip() -> Vec<u8> {
    let mut buffer = Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut buffer);
        let options = zip::write::SimpleFileOptions::default();
        for (name, data) in [
            ("php.exe", b"MZ-fake-php".as_slice()),
            ("ext/php_openssl.dll", b"dll".as_slice()),
        ] {
            writer.start_file(name, options).expect("file");
            writer.write_all(data).expect("data");
        }
        writer.finish().expect("finish");
    }
    buffer.into_inner()
}

const PHAR: &[u8] = b"<?php // fake composer.phar";

/// The real manifest text with every artifact's checksum swapped for the fake payload's.
fn manifest(file: &str, hash: &str) -> RuntimeManifest {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("manifests")
        .join(file);
    let mut json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("read")).expect("json");
    for version in json["versions"].as_array_mut().expect("versions") {
        for artifact in version["artifacts"].as_array_mut().expect("artifacts") {
            artifact["sha256"] = serde_json::Value::String(hash.to_string());
        }
    }
    RuntimeManifest::parse(&json.to_string()).expect("manifest")
}

async fn manager_at(dir: &Path, app: &str) -> RuntimeManager {
    let zip = php_zip();
    let php = manifest("php.json", &hash_of(&zip));
    let composer = manifest("composer.json", &hash_of(PHAR));
    let mut downloads = HashMap::new();
    for version in &php.versions {
        downloads.insert(version.artifacts[0].url.clone(), zip.clone());
    }
    for version in &composer.versions {
        downloads.insert(version.artifacts[0].url.clone(), PHAR.to_vec());
    }
    let db = Db::connect(&dir.join("db").join("test.db"))
        .await
        .expect("db");
    RuntimeManager::new(
        db,
        RuntimePaths::new(dir.join(app).join("runtimes"), dir.join(app).join("cache")),
        RuntimeRegistry::from_manifests(vec![php, composer]),
        Arc::new(Server(downloads)),
        "windows-x64",
    )
}

fn no_progress() -> ProgressSink {
    Arc::new(|_| {})
}

/// A `php` stand-in that just prints what it was asked to run.
fn fake_php(dir: &Path) -> PathBuf {
    let file = dir.join("fakephp.cmd");
    std::fs::write(&file, "@echo off\r\necho php ran %*\r\n").expect("fake php");
    file
}

fn run_composer(shim_dir: &Path, php: Option<&Path>) -> (bool, String, String) {
    let mut command = Command::new("cmd");
    command
        .args(["/C", "composer --version"])
        .env("PATH", shim_dir)
        .env("PATHEXT", ".CMD")
        .env_remove("OPENMIND_PHP");
    if let Some(php) = php {
        command.env("OPENMIND_PHP", php);
    }
    let output = command.output().expect("run shim");
    (
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).trim().to_string(),
        String::from_utf8_lossy(&output.stderr).trim().to_string(),
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn php_and_composer_install_with_the_documented_layout_and_environment() {
    let dir = tempfile::tempdir().expect("tempdir");
    let manager = manager_at(dir.path(), "app").await;
    manager
        .install("php", None, no_progress())
        .await
        .expect("php");
    manager
        .install("composer", None, no_progress())
        .await
        .expect("composer");

    let runtimes = dir.path().join("app").join("runtimes");
    let php_dir = runtimes.join("php").join("versions").join("8.4.26");
    let composer_dir = runtimes.join("composer").join("versions").join("2.10.3");
    assert!(php_dir.join("php.exe").is_file());
    let ini = std::fs::read_to_string(php_dir.join("php.ini")).expect("php.ini");
    assert!(ini.contains("extension_dir = \"ext\""), "{ini}");
    assert!(ini.contains("extension=openssl"), "{ini}");
    assert!(
        !ini.contains(":\\"),
        "php.ini must not hold an absolute path"
    );
    assert_eq!(
        std::fs::read(composer_dir.join("composer.phar")).expect("phar"),
        PHAR
    );

    let environment = manager.environment().await.expect("environment");
    let composer_shims = runtimes.join("composer").join("shims").join("2.10.3");
    assert!(
        environment.path_prepend.contains(&composer_shims),
        "{:?}",
        environment.path_prepend
    );
    assert!(environment.path_prepend.contains(&php_dir));
    assert!(
        environment.vars.contains(&(
            "OPENMIND_PHP".to_string(),
            php_dir.join("php.exe").to_string_lossy().into_owned()
        )),
        "{:?}",
        environment.vars
    );
    let script = std::fs::read_to_string(composer_shims.join("composer.cmd")).expect("shim");
    assert!(script.contains("%OPENMIND_PHP%"), "{script}");
    assert!(
        !script.contains(dir.path().to_string_lossy().as_ref()),
        "no absolute path may be baked in: {script}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn composer_runs_its_phar_with_the_named_php_and_refuses_without_one() {
    let dir = tempfile::tempdir().expect("tempdir");
    let manager = manager_at(dir.path(), "app").await;
    manager
        .install("composer", None, no_progress())
        .await
        .expect("composer");
    let shims = dir
        .path()
        .join("app")
        .join("runtimes")
        .join("composer")
        .join("shims")
        .join("2.10.3");
    let php = fake_php(dir.path());

    let (ok, out, _) = run_composer(&shims, Some(&php));
    assert!(ok);
    assert!(out.contains("php ran"), "{out}");
    assert!(out.contains("composer.phar\" --version"), "{out}");

    // No portable PHP active: it says so and never reaches for a global one.
    let (ok, out, err) = run_composer(&shims, None);
    assert!(!ok);
    assert!(out.is_empty(), "{out}");
    assert!(err.contains("not installed or not active"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn moving_the_app_folder_keeps_php_env_and_the_composer_launcher_working() {
    let dir = tempfile::tempdir().expect("tempdir");
    let manager = manager_at(dir.path(), "app").await;
    manager
        .install("php", None, no_progress())
        .await
        .expect("php");
    manager
        .install("composer", None, no_progress())
        .await
        .expect("composer");
    drop(manager);

    std::fs::rename(dir.path().join("app"), dir.path().join("moved")).expect("move");
    let moved = manager_at(dir.path(), "moved").await;

    let environment = moved.environment().await.expect("environment");
    let php_var = environment
        .vars
        .iter()
        .find(|(key, _)| key == "OPENMIND_PHP")
        .expect("OPENMIND_PHP");
    assert!(php_var.1.contains("moved"), "{}", php_var.1);
    let shims = environment
        .path_prepend
        .iter()
        .find(|dir| dir.ends_with("2.10.3"))
        .expect("composer shim dir")
        .clone();
    assert!(shims.to_string_lossy().contains("moved"));
    let php = fake_php(dir.path());
    let (ok, out, _) = run_composer(&shims, Some(&php));
    assert!(ok && out.contains("composer.phar"), "{out}");
}

fn php_var(environment: &openmind_runtime_manager::RuntimeEnvironment) -> String {
    environment
        .vars
        .iter()
        .find(|(key, _)| key == "OPENMIND_PHP")
        .map(|(_, value)| value.clone())
        .expect("OPENMIND_PHP")
}

#[tokio::test(flavor = "multi_thread")]
async fn the_first_php_is_active_and_switching_changes_php_the_terminal_and_composer_use() {
    let dir = tempfile::tempdir().expect("tempdir");
    let manager = manager_at(dir.path(), "app").await;
    manager
        .install("php", None, no_progress())
        .await
        .expect("php default");
    manager
        .install("php", Some("8.3.35"), no_progress())
        .await
        .expect("php 8.3");
    manager
        .install("composer", None, no_progress())
        .await
        .expect("composer");

    // The recommended version was installed first, so it is the active one.
    let before = manager.environment().await.expect("environment");
    assert!(php_var(&before).contains("8.4.26"), "{}", php_var(&before));
    assert!(before
        .path_prepend
        .iter()
        .any(|dir| dir.ends_with("8.4.26")));
    assert!(!before
        .path_prepend
        .iter()
        .any(|dir| dir.ends_with("8.3.35")));

    manager.set_active("php", "8.3.35").await.expect("switch");

    // Only the newly active PHP is injected; Composer's launcher is untouched
    // and finds PHP through OPENMIND_PHP, so it follows the switch.
    let after = manager.environment().await.expect("environment");
    assert!(php_var(&after).contains("8.3.35"), "{}", php_var(&after));
    assert!(after.path_prepend.iter().any(|dir| dir.ends_with("8.3.35")));
    assert!(!after.path_prepend.iter().any(|dir| dir.ends_with("8.4.26")));
    let shims = after
        .path_prepend
        .iter()
        .find(|dir| dir.to_string_lossy().contains("composer"))
        .expect("composer shim dir")
        .clone();
    let php = fake_php(dir.path());
    let (ok, out, _) = run_composer(&shims, Some(&php));
    assert!(ok && out.contains("composer.phar"), "{out}");
}

#[tokio::test(flavor = "multi_thread")]
async fn deleting_the_active_php_promotes_the_other_and_leaves_no_stale_records_or_shims() {
    let dir = tempfile::tempdir().expect("tempdir");
    let manager = manager_at(dir.path(), "app").await;
    manager
        .install("php", None, no_progress())
        .await
        .expect("php default");
    manager
        .install("php", Some("8.3.35"), no_progress())
        .await
        .expect("php 8.3");
    manager
        .install("composer", None, no_progress())
        .await
        .expect("composer");

    manager
        .delete("php", "8.4.26")
        .await
        .expect("delete active");

    let environment = manager.environment().await.expect("environment");
    assert!(php_var(&environment).contains("8.3.35"));
    let listed = manager.list().await.expect("list");
    let php = listed.iter().find(|r| r.id == "php").expect("php");
    assert_eq!(php.active_version.as_deref(), Some("8.3.35"));
    assert_eq!(php.installed.len(), 1);
    let runtimes = dir.path().join("app").join("runtimes");
    assert!(!runtimes
        .join("php")
        .join("versions")
        .join("8.4.26")
        .exists());

    // Deleting Composer removes its launcher folder and it stops being injected.
    manager
        .delete("composer", "2.10.3")
        .await
        .expect("composer");
    assert!(!runtimes
        .join("composer")
        .join("shims")
        .join("2.10.3")
        .exists());
    let after = manager.environment().await.expect("environment");
    assert!(!after
        .path_prepend
        .iter()
        .any(|dir| dir.to_string_lossy().contains("composer")));
}

#[tokio::test(flavor = "multi_thread")]
async fn php_8_1_gets_its_own_ini_without_the_zip_extension() {
    let dir = tempfile::tempdir().expect("tempdir");
    let manager = manager_at(dir.path(), "app").await;
    manager
        .install("php", Some("8.1.34"), no_progress())
        .await
        .expect("php 8.1");
    manager
        .install("php", Some("8.2.34"), no_progress())
        .await
        .expect("php 8.2");

    let versions = dir
        .path()
        .join("app")
        .join("runtimes")
        .join("php")
        .join("versions");
    let old = std::fs::read_to_string(versions.join("8.1.34").join("php.ini")).expect("8.1 ini");
    let new = std::fs::read_to_string(versions.join("8.2.34").join("php.ini")).expect("8.2 ini");
    assert!(!old.contains("extension=zip"), "{old}");
    assert!(old.contains("extension=openssl"), "{old}");
    assert!(new.contains("extension=zip"), "{new}");
}

#[tokio::test(flavor = "multi_thread")]
async fn path_injection_puts_each_runtimes_shims_before_its_own_folders_for_every_runtime() {
    let dir = tempfile::tempdir().expect("tempdir");
    let manager = full_manager(dir.path()).await;
    for kind in ["python", "node", "git", "php", "composer"] {
        manager
            .install(kind, None, no_progress())
            .await
            .unwrap_or_else(|err| panic!("{kind}: {err}"));
    }

    let environment = manager.environment().await.expect("environment");
    let position = |needle: &str| -> Vec<usize> {
        environment
            .path_prepend
            .iter()
            .enumerate()
            .filter(|(_, dir)| dir.to_string_lossy().contains(needle))
            .map(|(index, _)| index)
            .collect()
    };
    for kind in ["python", "node", "git", "php", "composer"] {
        assert!(
            !position(&format!("runtimes\\{kind}\\")).is_empty(),
            "{kind} is not on the injected PATH: {:?}",
            environment.path_prepend
        );
    }
    // Shims (pip, composer) always come before the version folders that hold
    // tool-generated launchers with absolute paths.
    let python_shims = position("python\\shims");
    let python_bins = position("python\\versions");
    assert!(
        python_shims[0] < python_bins[0],
        "{:?}",
        environment.path_prepend
    );
    let composer_shims = position("composer\\shims");
    assert_eq!(composer_shims.len(), 1);
    // The PHP folder and the OPENMIND_PHP variable agree.
    assert!(php_var(&environment).contains("runtimes\\php\\versions"));
    assert!(environment
        .vars
        .iter()
        .any(|(k, v)| k == "PYTHONNOUSERSITE" && v == "1"));
}

/// Every shipped runtime, installed from stand-in archives that hold exactly
/// the files each manifest verifies.
async fn full_manager(dir: &Path) -> RuntimeManager {
    let mut manifests = Vec::new();
    let mut downloads = HashMap::new();
    for file in [
        "python.json",
        "node.json",
        "git.json",
        "php.json",
        "composer.json",
    ] {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("manifests")
            .join(file);
        let mut json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).expect("read")).expect("json");
        let files: Vec<String> = json["verifyFiles"]
            .as_array()
            .expect("verifyFiles")
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        for version in json["versions"].as_array_mut().expect("versions") {
            for artifact in version["artifacts"].as_array_mut().expect("artifacts") {
                let is_file = artifact["archive"] == "file";
                let strip = artifact["stripComponents"].as_u64().unwrap_or(0) as usize;
                let root = artifact["extractRoot"].as_str().map(str::to_string);
                let bytes = if is_file {
                    PHAR.to_vec()
                } else {
                    let mut names: Vec<String> = files.clone();
                    // Files a manifest seeds itself (php.ini) are not in the archive.
                    names.retain(|name| name != "php.ini");
                    let prefix = format!(
                        "{}{}",
                        "w/".repeat(strip),
                        root.map(|r| format!("{r}/")).unwrap_or_default()
                    );
                    zip_of(
                        &names
                            .iter()
                            .map(|n| format!("{prefix}{n}"))
                            .collect::<Vec<_>>(),
                    )
                };
                artifact["sha256"] = serde_json::Value::String(hash_of(&bytes));
                downloads.insert(artifact["url"].as_str().expect("url").to_string(), bytes);
            }
        }
        manifests.push(RuntimeManifest::parse(&json.to_string()).expect("manifest"));
    }
    let db = Db::connect(&dir.join("db").join("test.db"))
        .await
        .expect("db");
    RuntimeManager::new(
        db,
        RuntimePaths::new(
            dir.join("app").join("runtimes"),
            dir.join("app").join("cache"),
        ),
        RuntimeRegistry::from_manifests(manifests),
        Arc::new(Server(downloads)),
        "windows-x64",
    )
}

fn zip_of(names: &[String]) -> Vec<u8> {
    let mut buffer = Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut buffer);
        let options = zip::write::SimpleFileOptions::default();
        for name in names {
            writer.start_file(name, options).expect("file");
            writer.write_all(b"x").expect("data");
        }
        writer.finish().expect("finish");
    }
    buffer.into_inner()
}

#[tokio::test(flavor = "multi_thread")]
async fn deleting_php_stops_injecting_it_and_removes_its_folders() {
    let dir = tempfile::tempdir().expect("tempdir");
    let manager = manager_at(dir.path(), "app").await;
    manager
        .install("php", None, no_progress())
        .await
        .expect("php");

    manager.delete("php", "8.4.26").await.expect("delete");

    let environment = manager.environment().await.expect("environment");
    assert!(environment.path_prepend.is_empty());
    assert!(environment.vars.is_empty());
    let php_root = dir.path().join("app").join("runtimes").join("php");
    assert!(!php_root.join("versions").join("8.4.26").exists());
}
