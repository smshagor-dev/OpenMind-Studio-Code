//! The package server and client over real TCP on this computer: manifest, downloads, tampering, traversal attempts,
//! concurrent downloads. Signatures use a stand-in verifier here; the app's real minisign check is tested in the app.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use openmind_deploy::advert::{
    release_name, DeploymentKind, Manifest, PackageEntry, PackageKind, RuntimeEntry,
    MANIFEST_FORMAT,
};
use openmind_deploy::client::{download, fetch_manifest, FetchError};
use openmind_deploy::package::{scan_folder, verify_file};
use openmind_deploy::server::{Catalog, PackageServer, MANIFEST_PATH};
use openmind_deploy::{source_deployment_id, Arch, PROTOCOL};

const T: Duration = Duration::from_secs(10);

fn verifier(_: &[u8], signature: &str, version: &str) -> Result<(), String> {
    (signature == format!("ok{}", version.replace('.', "")))
        .then_some(())
        .ok_or_else(|| "not signed by the release key".into())
}

struct Source {
    _dir: tempfile::TempDir,
    folder: PathBuf,
    server: PackageServer,
}

fn source_with(files: &[(&str, &[u8])]) -> Source {
    let dir = tempfile::tempdir().expect("dir");
    let folder = dir.path().join("deploy packages");
    std::fs::create_dir_all(&folder).expect("folder");
    for (name, bytes) in files {
        std::fs::write(folder.join(name), bytes).expect("file");
        std::fs::write(folder.join(format!("{name}.sig")), "ok103").expect("sig");
    }
    let (offered, problems) = scan_folder(&folder, "windows", &verifier);
    assert!(problems.is_empty(), "{problems:?}");
    let manifest = Manifest {
        format: MANIFEST_FORMAT.into(),
        protocol: PROTOCOL,
        deployment_id: source_deployment_id("pc-a", "folder"),
        app_version: "1.0.3".into(),
        platform: "windows".into(),
        arch: Arch::X64,
        kind: DeploymentKind::PackageSource,
        share_path: None,
        packages: offered.iter().map(|(entry, _)| entry.clone()).collect(),
        runtimes: vec![RuntimeEntry {
            kind: "python".into(),
            version: "3.14.7".into(),
        }],
    };
    let files: HashMap<String, PathBuf> = offered
        .into_iter()
        .map(|(entry, file)| (entry.name, file))
        .collect();
    let catalog = Catalog::new(manifest, files).expect("catalog");
    let server =
        PackageServer::start("127.0.0.1:0".parse().expect("addr"), catalog).expect("server");
    Source {
        _dir: dir,
        folder,
        server,
    }
}

fn setup_name() -> String {
    release_name("1.0.3", "windows", Arch::X64, PackageKind::Installer)
}

fn big_payload() -> Vec<u8> {
    (0..3_000_000u32).map(|i| (i % 251) as u8).collect()
}

fn entry(manifest: &Manifest) -> PackageEntry {
    manifest.packages[0].clone()
}

#[test]
fn a_package_downloads_verified_into_any_destination() {
    let payload = big_payload();
    let source = source_with(&[(&setup_name(), &payload)]);
    let manifest = fetch_manifest(source.server.address(), T).expect("manifest");
    assert_eq!(manifest.packages.len(), 1);
    let dest_dir = tempfile::tempdir().expect("dest");
    let dest = dest_dir
        .path()
        .join("Программы")
        .join("বাংলা Test")
        .join(setup_name());
    let mut last = 0;
    download(
        source.server.address(),
        &entry(&manifest),
        &dest,
        T,
        &mut |received, _| last = received,
        &AtomicBool::new(false),
    )
    .expect("download");
    assert_eq!(last, payload.len() as u64);
    assert_eq!(std::fs::read(&dest).expect("read"), payload);
    verify_file(&dest, &entry(&manifest), &verifier).expect("verified");
    assert_eq!(leftover_parts(dest.parent().expect("parent")), 0);
}

fn leftover_parts(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|e| e.file_name().to_string_lossy().ends_with(".part"))
                .count()
        })
        .unwrap_or(0)
}

#[test]
fn a_package_changed_on_the_source_after_it_was_announced_is_refused_and_nothing_is_kept() {
    let payload = big_payload();
    let source = source_with(&[(&setup_name(), &payload)]);
    let manifest = fetch_manifest(source.server.address(), T).expect("manifest");
    // Same size, different bytes (a tampered setup).
    let mut tampered = payload.clone();
    tampered[1000] ^= 0xff;
    std::fs::write(source.folder.join(setup_name()), &tampered).expect("tamper");
    let dest_dir = tempfile::tempdir().expect("dest");
    let dest = dest_dir.path().join(setup_name());
    let outcome = download(
        source.server.address(),
        &entry(&manifest),
        &dest,
        T,
        &mut |_, _| {},
        &AtomicBool::new(false),
    );
    assert_eq!(outcome, Err(FetchError::ChecksumMismatch));
    assert!(!dest.exists());
    assert_eq!(leftover_parts(dest_dir.path()), 0);
    // Another size: refused before the body is read.
    std::fs::write(source.folder.join(setup_name()), b"short").expect("tamper");
    let outcome = download(
        source.server.address(),
        &entry(&manifest),
        &dest,
        T,
        &mut |_, _| {},
        &AtomicBool::new(false),
    );
    assert!(
        matches!(outcome, Err(FetchError::SizeMismatch { .. })),
        "{outcome:?}"
    );
    assert!(!dest.exists());
}

#[test]
fn a_cancelled_download_leaves_nothing() {
    let source = source_with(&[(&setup_name(), &big_payload())]);
    let manifest = fetch_manifest(source.server.address(), T).expect("manifest");
    let dest_dir = tempfile::tempdir().expect("dest");
    let dest = dest_dir.path().join(setup_name());
    let cancel = AtomicBool::new(true);
    let outcome = download(
        source.server.address(),
        &entry(&manifest),
        &dest,
        T,
        &mut |_, _| {},
        &cancel,
    );
    assert_eq!(outcome, Err(FetchError::Cancelled));
    assert!(!dest.exists());
    assert_eq!(leftover_parts(dest_dir.path()), 0);
}

fn raw(address: SocketAddr, request: &[u8]) -> String {
    let mut stream = TcpStream::connect(address).expect("connect");
    stream.set_read_timeout(Some(T)).expect("timeout");
    stream.write_all(request).expect("write");
    let mut answer = String::new();
    let _ = stream.read_to_string(&mut answer);
    answer
}

#[test]
fn nothing_outside_the_catalog_can_be_reached_or_changed() {
    let source = source_with(&[(&setup_name(), b"setup")]);
    std::fs::write(source.folder.join("secret.txt"), b"private").expect("secret");
    let address = source.server.address();
    for path in [
        "/openmind-deploy/v1/packages/secret.txt",
        "/openmind-deploy/v1/packages/../secret.txt",
        "/openmind-deploy/v1/packages/..%2Fsecret.txt",
        "/openmind-deploy/v1/packages/OpenMind-Studio_1.0.3_windows_x64_setup.exe.sig",
        "/openmind-deploy/v1/packages/OpenMind-Studio_1.0.3_windows_x64_setup.exe?x=1",
        "/../../windows/win.ini",
    ] {
        let answer = raw(
            address,
            format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes(),
        );
        assert!(answer.starts_with("HTTP/1.1 404"), "{path}: {answer}");
    }
    let put = raw(
        address,
        format!("PUT {MANIFEST_PATH} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes(),
    );
    assert!(put.starts_with("HTTP/1.1 405"), "{put}");
    let huge = format!(
        "GET {MANIFEST_PATH} HTTP/1.1\r\nX: {}\r\n\r\n",
        "a".repeat(20_000)
    );
    assert!(raw(address, huge.as_bytes()).starts_with("HTTP/1.1 400"));
    assert!(raw(address, b"garbage\r\n\r\n").starts_with("HTTP/1.1 400"));
}

#[test]
fn many_computers_downloading_at_once_each_get_a_whole_verified_copy() {
    let payload = big_payload();
    let source = source_with(&[(&setup_name(), &payload)]);
    let address = source.server.address();
    let manifest = fetch_manifest(address, T).expect("manifest");
    let dest_dir = tempfile::tempdir().expect("dest");
    let clients: Vec<_> = (0..12)
        .map(|pc| {
            let entry = entry(&manifest);
            let dest = dest_dir.path().join(format!("pc-{pc}")).join(setup_name());
            std::thread::spawn(move || {
                download(
                    address,
                    &entry,
                    &dest,
                    T,
                    &mut |_, _| {},
                    &AtomicBool::new(false),
                )
                .map(|()| dest)
            })
        })
        .collect();
    for client in clients {
        let dest = client.join().expect("thread").expect("download");
        verify_file(&dest, &entry(&manifest), &verifier).expect("verified");
    }
}

#[test]
fn an_unreachable_source_is_a_connection_error() {
    let source = source_with(&[(&setup_name(), b"x")]);
    let address = source.server.address();
    drop(source);
    assert!(matches!(
        fetch_manifest(address, Duration::from_secs(2)),
        Err(FetchError::Connect(_))
    ));
}

#[test]
fn a_client_trickling_its_request_head_is_cut_off() {
    let source = source_with(&[(&setup_name(), b"setup")]);
    let mut stream = TcpStream::connect(source.server.address()).expect("connect");
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .expect("timeout");
    let started = std::time::Instant::now();
    stream
        .write_all(b"GET /openmind-deploy/v1/manifest HTTP/1.1\r\n")
        .expect("partial");
    // Then nothing more: the server must not hold the connection open for good.
    let mut answer = String::new();
    let _ = stream.read_to_string(&mut answer);
    assert!(
        started.elapsed() < Duration::from_secs(15),
        "{:?}",
        started.elapsed()
    );
    assert!(
        answer.is_empty() || answer.starts_with("HTTP/1.1 400"),
        "{answer}"
    );
}

#[test]
fn a_package_replaced_by_a_link_is_not_served() {
    let payload = big_payload();
    let source = source_with(&[(&setup_name(), &payload)]);
    let elsewhere = source.folder.join("other.bin");
    std::fs::write(&elsewhere, b"not the package").expect("other");
    let served = source.folder.join(setup_name());
    std::fs::remove_file(&served).expect("rm");
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_file(&elsewhere, &served);
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(&elsewhere, &served);
    if linked.is_err() {
        eprintln!("this account may not create links; skipped");
        return;
    }
    let answer = raw(
        source.server.address(),
        format!(
            "GET /openmind-deploy/v1/packages/{} HTTP/1.1\r\nHost: x\r\n\r\n",
            setup_name()
        )
        .as_bytes(),
    );
    assert!(answer.starts_with("HTTP/1.1 404"), "{answer}");
}
