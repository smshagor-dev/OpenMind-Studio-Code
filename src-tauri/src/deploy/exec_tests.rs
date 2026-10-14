//! Provisioning end to end on this computer: a real package server on 127.0.0.1, real downloads, the real signature
//! check (a throwaway key), real ZIP extraction into folders with spaces and non-Latin letters. The setup program and
//! the Desktop shortcut are recorded instead of run, so nothing is installed into the user's system.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use openmind_deploy::advert::{
    release_name, DeploymentKind, Manifest, PackageEntry, PackageKind, MANIFEST_FORMAT,
};
use openmind_deploy::package::sha256_file;
use openmind_deploy::server::{Catalog, PackageServer};
use openmind_deploy::{source_deployment_id, Arch, PROTOCOL};

use super::*;
use crate::deploy::test_signing::TestKey;

pub(crate) fn portable_zip(version: &str) -> Vec<u8> {
    let mut buffer = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buffer);
        let options = zip::write::SimpleFileOptions::default();
        for (name, text) in [
            (
                "OpenMind Studio/OpenMindStudio.exe",
                format!("program {version}"),
            ),
            ("OpenMind Studio/README.txt", format!("readme {version}")),
            ("OpenMind Studio/lsp/bundle.json", format!("lsp {version}")),
        ] {
            zip.start_file(name, options).expect("entry");
            zip.write_all(text.as_bytes()).expect("write");
        }
        zip.finish().expect("finish");
    }
    buffer.into_inner()
}

pub(crate) struct Source {
    pub _dir: tempfile::TempDir,
    pub folder: PathBuf,
    pub manifest: Manifest,
    pub server: PackageServer,
}

/// A package source serving `packages` (name, bytes, version), signed by `key`.
pub(crate) fn source(key: &TestKey, packages: &[(String, Vec<u8>, &str)]) -> Source {
    let dir = tempfile::tempdir().expect("dir");
    let folder = dir.path().join("packages");
    std::fs::create_dir_all(&folder).expect("folder");
    let mut entries = Vec::new();
    let mut files = HashMap::new();
    for (name, bytes, version) in packages {
        let file = folder.join(name);
        std::fs::write(&file, bytes).expect("package");
        let (_, _, arch, kind) = openmind_deploy::advert::parse_release_name(name).expect("name");
        entries.push(PackageEntry {
            name: name.clone(),
            kind,
            arch,
            version: (*version).to_string(),
            size: bytes.len() as u64,
            sha256: sha256_file(&file).expect("hash"),
            signature: key.sign(bytes, version),
        });
        files.insert(name.clone(), file);
    }
    let manifest = Manifest {
        format: MANIFEST_FORMAT.into(),
        protocol: PROTOCOL,
        deployment_id: source_deployment_id("pc-source", "packages"),
        app_version: "1.0.3".into(),
        platform: "windows".into(),
        arch: Arch::X64,
        kind: DeploymentKind::PackageSource,
        share_path: None,
        packages: entries,
        runtimes: vec![],
    };
    let catalog = Catalog::new(manifest.clone(), files).expect("catalog");
    let server =
        PackageServer::start("127.0.0.1:0".parse().expect("addr"), catalog).expect("server");
    Source {
        _dir: dir,
        folder,
        manifest,
        server,
    }
}

fn portable(version: &str) -> String {
    release_name(version, "windows", Arch::X64, PackageKind::Portable)
}

fn setup(version: &str) -> String {
    release_name(version, "windows", Arch::X64, PackageKind::Installer)
}

/// Records what the app would have done.
#[derive(Default)]
pub(crate) struct Recorder {
    pub shortcuts: Mutex<Vec<PathBuf>>,
    pub setups: Mutex<Vec<(PathBuf, PathBuf)>>,
}

pub(crate) fn provision_with(
    key: &TestKey,
    temp: &Path,
    recorder: &Recorder,
    setup_behaviour: &(dyn Fn(&Path) -> i32 + Sync),
    request: &Request,
) -> Result<Outcome, String> {
    provision_checked(
        key,
        temp,
        recorder,
        &|_: &Path, dest: &Path| setup_behaviour(dest),
        &Policy::default(),
        request,
    )
}

/// What the app's trust and version rules say in a test (the defaults: trusted, no minimum version).
pub(crate) struct Policy {
    pub trusted: bool,
    pub minimum_version: &'static str,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            trusted: true,
            minimum_version: "0.0.0",
        }
    }
}

pub(crate) fn provision_checked(
    key: &TestKey,
    temp: &Path,
    recorder: &Recorder,
    setup_behaviour: &(dyn Fn(&Path, &Path) -> i32 + Sync),
    policy: &Policy,
    request: &Request,
) -> Result<Outcome, String> {
    let verifier = key.verifier();
    let cancel = AtomicBool::new(false);
    let shortcut = |program: &Path| {
        recorder
            .shortcuts
            .lock()
            .expect("lock")
            .push(program.to_path_buf());
        Ok(format!("Created shortcut -> {}", program.display()))
    };
    let run_setup = |setup: &Path, dest: &Path| {
        recorder
            .setups
            .lock()
            .expect("lock")
            .push((setup.to_path_buf(), dest.to_path_buf()));
        Ok(setup_behaviour(setup, dest))
    };
    let trusted = |_: &openmind_deploy::advert::Manifest| policy.trusted;
    provision(
        request,
        &Effects {
            verifier: &verifier,
            shortcut: &shortcut,
            run_setup: &run_setup,
            temp_dir: temp.to_path_buf(),
            lock_dir: temp.join("locks"),
            trusted: &trusted,
            minimum_version: policy.minimum_version,
            cancel: &cancel,
        },
    )
}

fn no_setup(_: &Path) -> i32 {
    panic!("no setup expected")
}

fn request(source: &Source, kind: PackageKind, dest: &Path) -> Request {
    Request {
        manifest: source.manifest.clone(),
        source: Some(source.server.address()),
        kind: Some(kind),
        destination: Some(dest.to_path_buf()),
    }
}

#[test]
fn a_portable_package_installs_into_a_folder_with_spaces_and_non_latin_letters() {
    let key = TestKey::new(1);
    let src = source(&key, &[(portable("1.0.3"), portable_zip("1.0.3"), "1.0.3")]);
    let work = tempfile::tempdir().expect("work");
    let dest = work
        .path()
        .join("Apps With Spaces")
        .join("বাংলা Программы")
        .join("OpenMind Studio");
    let recorder = Recorder::default();
    let outcome = provision_with(
        &key,
        &work.path().join("temp"),
        &recorder,
        &no_setup,
        &request(&src, PackageKind::Portable, &dest),
    )
    .expect("installed");
    assert_eq!(outcome.action, "install");
    assert_eq!(
        std::fs::read_to_string(dest.join("OpenMindStudio.exe")).expect("exe"),
        "program 1.0.3"
    );
    assert!(dest.join("lsp").join("bundle.json").is_file());
    assert_eq!(
        recorder.shortcuts.lock().expect("lock").as_slice(),
        [dest.join("OpenMindStudio.exe")]
    );
    assert_eq!(
        outcome.data_location,
        dest.join("data").display().to_string()
    );
    // Nothing left beside it: no staging, no download.
    let siblings: Vec<String> = std::fs::read_dir(dest.parent().expect("parent"))
        .expect("dir")
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(siblings, ["OpenMind Studio"]);
    assert_eq!(
        std::fs::read_dir(work.path().join("temp").join("deploy"))
            .expect("temp")
            .count(),
        0
    );
}

#[test]
fn an_upgrade_swaps_the_program_and_keeps_the_users_data_and_runtimes() {
    let key = TestKey::new(2);
    let work = tempfile::tempdir().expect("work");
    let dest = work.path().join("OpenMind Studio");
    let recorder = Recorder::default();
    let old = source(&key, &[(portable("1.0.2"), portable_zip("1.0.2"), "1.0.2")]);
    provision_with(
        &key,
        work.path(),
        &recorder,
        &no_setup,
        &request(&old, PackageKind::Portable, &dest),
    )
    .expect("1.0.2");
    std::fs::create_dir_all(dest.join("data")).expect("data");
    std::fs::write(dest.join("data").join("openmind-studio.db"), b"my history").expect("db");
    std::fs::create_dir_all(dest.join("runtimes").join("python")).expect("runtimes");
    let new = source(&key, &[(portable("1.0.3"), portable_zip("1.0.3"), "1.0.3")]);
    let outcome = provision_with(
        &key,
        work.path(),
        &recorder,
        &no_setup,
        &request(&new, PackageKind::Portable, &dest),
    )
    .expect("upgrade");
    assert_eq!(outcome.action, "upgrade");
    assert_eq!(
        std::fs::read_to_string(dest.join("OpenMindStudio.exe")).expect("exe"),
        "program 1.0.3"
    );
    assert_eq!(
        std::fs::read(dest.join("data").join("openmind-studio.db")).expect("db"),
        b"my history"
    );
    assert!(dest.join("runtimes").join("python").is_dir());
}

#[test]
fn a_package_signed_by_another_key_or_tampered_installs_nothing() {
    let release = TestKey::new(3);
    let attacker = TestKey::new(4);
    let work = tempfile::tempdir().expect("work");
    let recorder = Recorder::default();
    // Signed by someone else.
    let forged = source(
        &attacker,
        &[(portable("1.0.3"), portable_zip("1.0.3"), "1.0.3")],
    );
    let dest = work.path().join("forged");
    let error = provision_with(
        &release,
        work.path(),
        &recorder,
        &no_setup,
        &request(&forged, PackageKind::Portable, &dest),
    )
    .expect_err("refused");
    assert!(error.contains("refused and deleted"), "{error}");
    assert!(!dest.exists());
    // Correctly signed, then changed on the source after it was announced.
    let changed = source(
        &release,
        &[(portable("1.0.3"), portable_zip("1.0.3"), "1.0.3")],
    );
    let mut bytes = portable_zip("1.0.3");
    let last = bytes.len() - 1;
    bytes[last] ^= 0x5a;
    std::fs::write(changed.folder.join(portable("1.0.3")), &bytes).expect("tamper");
    let dest = work.path().join("tampered");
    let error = provision_with(
        &release,
        work.path(),
        &recorder,
        &no_setup,
        &request(&changed, PackageKind::Portable, &dest),
    )
    .expect_err("refused");
    assert!(error.contains("couldn't be downloaded"), "{error}");
    assert!(!dest.exists());
    assert_eq!(
        std::fs::read_dir(work.path().join("deploy"))
            .map(|d| d.count())
            .unwrap_or(0),
        0
    );
    assert!(recorder.shortcuts.lock().expect("lock").is_empty());
}

fn fake_setup(version: &'static str) -> impl Fn(&Path) -> i32 + Sync {
    move |dest: &Path| {
        std::fs::create_dir_all(dest).expect("dest");
        std::fs::write(dest.join("OpenMindStudio.exe"), version).expect("exe");
        std::fs::write(dest.join("uninstall.exe"), b"").expect("uninstall");
        openmind_core::install::write(dest, openmind_core::InstallLayout::PerUser, version)
            .expect("install.json");
        0
    }
}

#[test]
fn the_setup_runs_silently_into_the_chosen_folder_and_upgrades_or_refuses_by_version() {
    let key = TestKey::new(5);
    let work = tempfile::tempdir().expect("work");
    let dest = work.path().join("G Apps").join("OpenMind Studio");
    let recorder = Recorder::default();
    let v102 = source(&key, &[(setup("1.0.2"), b"setup 1.0.2".to_vec(), "1.0.2")]);
    let outcome = provision_with(
        &key,
        work.path(),
        &recorder,
        &fake_setup("1.0.2"),
        &request(&v102, PackageKind::Installer, &dest),
    )
    .expect("install");
    assert_eq!(outcome.action, "install");
    let setups = recorder.setups.lock().expect("lock").clone();
    assert_eq!(setups.len(), 1);
    assert_eq!(setups[0].1, dest, "the setup was told the chosen folder");
    assert!(
        !setups[0].0.exists(),
        "the downloaded setup is removed afterwards"
    );

    let v103 = source(&key, &[(setup("1.0.3"), b"setup 1.0.3".to_vec(), "1.0.3")]);
    let outcome = provision_with(
        &key,
        work.path(),
        &recorder,
        &fake_setup("1.0.3"),
        &request(&v103, PackageKind::Installer, &dest),
    )
    .expect("upgrade");
    assert_eq!(outcome.action, "upgrade");
    let again = provision_with(
        &key,
        work.path(),
        &recorder,
        &fake_setup("1.0.3"),
        &request(&v103, PackageKind::Installer, &dest),
    )
    .expect("repair");
    assert_eq!(again.action, "repair");
    let error = provision_with(
        &key,
        work.path(),
        &recorder,
        &no_setup,
        &request(&v102, PackageKind::Installer, &dest),
    )
    .expect_err("downgrade");
    assert!(error.contains("never downgraded"), "{error}");
    // The setup itself refuses (in use on another computer): reported, nothing claimed.
    let error = provision_with(
        &key,
        work.path(),
        &recorder,
        &|_: &Path| 3,
        &request(&v103, PackageKind::Installer, &dest),
    )
    .expect_err("setup refused");
    assert!(error.contains("refused to change"), "{error}");
}

#[test]
fn a_folder_with_other_files_or_another_kind_of_copy_is_never_written_into() {
    let key = TestKey::new(6);
    let src = source(
        &key,
        &[
            (portable("1.0.3"), portable_zip("1.0.3"), "1.0.3"),
            (setup("1.0.3"), b"setup".to_vec(), "1.0.3"),
        ],
    );
    let work = tempfile::tempdir().expect("work");
    let recorder = Recorder::default();
    let mine = work.path().join("My Documents");
    std::fs::create_dir_all(&mine).expect("dir");
    std::fs::write(mine.join("thesis.docx"), b"important").expect("file");
    let error = provision_with(
        &key,
        work.path(),
        &recorder,
        &no_setup,
        &request(&src, PackageKind::Portable, &mine),
    )
    .expect_err("not ours");
    assert!(error.contains("aren't OpenMind Studio"), "{error}");
    assert_eq!(std::fs::read_dir(&mine).expect("dir").count(), 1);
    let installed = work.path().join("Installed");
    fake_setup("1.0.2")(&installed);
    let error = provision_with(
        &key,
        work.path(),
        &recorder,
        &no_setup,
        &request(&src, PackageKind::Portable, &installed),
    )
    .expect_err("kind");
    assert!(error.contains("setup package"), "{error}");
    let relative = Request {
        destination: Some(PathBuf::from("relative\\folder")),
        ..request(&src, PackageKind::Portable, &mine)
    };
    assert!(provision_with(&key, work.path(), &recorder, &no_setup, &relative).is_err());
}

#[test]
fn two_provisionings_of_one_folder_never_run_at_once() {
    let key = TestKey::new(10);
    let src = source(&key, &[(setup("1.0.3"), b"setup".to_vec(), "1.0.3")]);
    let work = tempfile::tempdir().expect("work");
    let dest = work.path().join("Shared Target");
    let recorder = Recorder::default();
    let slow = |dest: &Path| {
        std::thread::sleep(std::time::Duration::from_millis(3500));
        fake_setup("1.0.3")(dest)
    };
    let outcomes: Vec<Result<Outcome, String>> = std::thread::scope(|scope| {
        let runs: Vec<_> = (0..2)
            .map(|_| {
                scope.spawn(|| {
                    // Two processes on one computer: the same temporary and lock folders (each download still gets a
                    // folder of its own).
                    provision_with(
                        &key,
                        work.path(),
                        &recorder,
                        &slow,
                        &request(&src, PackageKind::Installer, &dest),
                    )
                })
            })
            .collect();
        runs.into_iter()
            .map(|r| r.join().expect("thread"))
            .collect()
    });
    let done = outcomes.iter().filter(|o| o.is_ok()).count();
    let refused: Vec<&String> = outcomes.iter().filter_map(|o| o.as_ref().err()).collect();
    assert_eq!(done, 1, "{outcomes:?}");
    assert!(refused[0].contains("being provisioned"), "{refused:?}");
    assert_eq!(recorder.setups.lock().expect("lock").len(), 1);
}

#[test]
fn a_shared_installation_gets_only_a_shortcut_and_local_data() {
    let work = tempfile::tempdir().expect("work");
    let share = work.path().join("share").join("OpenMind Studio");
    std::fs::create_dir_all(&share).expect("share");
    let exe = share.join("OpenMindStudio.exe");
    std::fs::write(&exe, b"program").expect("exe");
    let recorder = Recorder::default();
    let key = TestKey::new(11);
    let verifier = key.verifier();
    let cancel = AtomicBool::new(false);
    let shortcut = |program: &Path| {
        recorder
            .shortcuts
            .lock()
            .expect("lock")
            .push(program.to_path_buf());
        Ok("ok".to_string())
    };
    let effects = Effects {
        verifier: &verifier,
        shortcut: &shortcut,
        run_setup: &|_: &Path, _: &Path| -> Result<i32, String> { panic!("no setup") },
        temp_dir: work.path().to_path_buf(),
        lock_dir: work.path().join("locks"),
        trusted: &|_: &openmind_deploy::advert::Manifest| true,
        minimum_version: "0.0.0",
        cancel: &cancel,
    };
    let outcome = use_share(&exe, "1.0.3", &effects).expect("shortcut");
    assert_eq!(outcome.action, "shortcut");
    assert_eq!(
        recorder.shortcuts.lock().expect("lock").as_slice(),
        std::slice::from_ref(&exe)
    );
    assert!(
        !outcome
            .data_location
            .starts_with(&share.display().to_string()),
        "data is never in the share"
    );
    let missing = use_share(&share.join("gone.exe"), "1.0.3", &effects).expect_err("missing");
    assert!(missing.contains("can't be reached"), "{missing}");
}

/// Every drive letter this computer has right now that is local and writable — found at run time, never a fixed list.
fn writable_local_drives() -> Vec<(char, PathBuf)> {
    ('A'..='Z')
        .filter_map(|letter| {
            let root = PathBuf::from(format!("{letter}:\\"));
            if !root.is_dir() || openmind_core::install::is_remote_path(&root) {
                return None;
            }
            let probe = root.join(format!("OMDeployTest-{}", openmind_deploy::random_hex(4)));
            std::fs::create_dir(&probe).ok().map(|()| (letter, probe))
        })
        .collect()
}

#[test]
fn provisioning_works_on_every_writable_drive_of_this_computer() {
    let key = TestKey::new(12);
    let src = source(&key, &[(portable("1.0.3"), portable_zip("1.0.3"), "1.0.3")]);
    let drives = writable_local_drives();
    assert!(
        !drives.is_empty(),
        "at least the drive holding the temporary folder is writable"
    );
    let recorder = Recorder::default();
    let mut tried = Vec::new();
    for (letter, probe) in &drives {
        let dest = probe
            .join("Apps With Spaces")
            .join("Программы বাংলা")
            .join("OpenMind Studio");
        let outcome = provision_with(
            &key,
            &probe.join("temp"),
            &recorder,
            &no_setup,
            &request(&src, PackageKind::Portable, &dest),
        );
        let installed = outcome.as_ref().map(|o| o.program.clone());
        let ok = dest.join("OpenMindStudio.exe").is_file();
        let _ = std::fs::remove_dir_all(probe);
        assert!(ok, "drive {letter}: {outcome:?}");
        assert_eq!(installed.expect("program"), dest.join("OpenMindStudio.exe"));
        tried.push(*letter);
    }
    eprintln!("provisioned on drives {tried:?}");
}

// Refusals added by the security audit (untrusted, older, swapped, unreachable).
#[path = "exec_refusal_tests.rs"]
mod refusals;
