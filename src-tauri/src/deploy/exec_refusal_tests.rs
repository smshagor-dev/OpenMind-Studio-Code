//! Provisioning refusals: an untrusted deployment, an older release, a setup swapped after its check, a destination
//! that can't be reached or written. Uses the helpers of `exec_tests.rs`.

use super::*;

#[test]
fn nothing_is_provisioned_from_an_untrusted_deployment() {
    let key = TestKey::new(13);
    let src = source(&key, &[(portable("1.0.3"), portable_zip("1.0.3"), "1.0.3")]);
    let work = tempfile::tempdir().expect("work");
    let dest = work.path().join("OpenMind Studio");
    let recorder = Recorder::default();
    let error = provision_checked(
        &key,
        work.path(),
        &recorder,
        &|_: &Path, _: &Path| panic!("no setup"),
        &Policy {
            trusted: false,
            ..Policy::default()
        },
        &request(&src, PackageKind::Portable, &dest),
    )
    .expect_err("untrusted");
    assert!(error.contains("isn't trusted"), "{error}");
    assert!(!dest.exists());
    assert!(
        !work.path().join("deploy").exists(),
        "nothing was even downloaded"
    );
    assert!(recorder.shortcuts.lock().expect("lock").is_empty());
}

#[test]
fn a_correctly_signed_but_older_release_is_never_installed_from_the_network() {
    let key = TestKey::new(14);
    let src = source(&key, &[(portable("1.0.2"), portable_zip("1.0.2"), "1.0.2")]);
    let work = tempfile::tempdir().expect("work");
    let dest = work.path().join("OpenMind Studio");
    let error = provision_checked(
        &key,
        work.path(),
        &Recorder::default(),
        &|_: &Path, _: &Path| panic!("no setup"),
        &Policy {
            minimum_version: "1.0.3",
            ..Policy::default()
        },
        &request(&src, PackageKind::Portable, &dest),
    )
    .expect_err("older");
    assert!(error.contains("older than this computer"), "{error}");
    assert!(!dest.exists());
}

#[cfg(windows)]
#[test]
fn the_verified_setup_cant_be_swapped_before_it_runs() {
    let key = TestKey::new(15);
    let src = source(&key, &[(setup("1.0.3"), b"setup 1.0.3".to_vec(), "1.0.3")]);
    let work = tempfile::tempdir().expect("work");
    let dest = work.path().join("Swap Target");
    let swapped = std::sync::atomic::AtomicBool::new(false);
    provision_checked(
        &key,
        work.path(),
        &Recorder::default(),
        &|setup: &Path, dest: &Path| {
            // Another process trying to replace or delete the verified file while the setup runs is refused.
            let write = std::fs::OpenOptions::new().write(true).open(setup);
            let delete = std::fs::remove_file(setup);
            swapped.store(
                write.is_ok() || delete.is_ok(),
                std::sync::atomic::Ordering::SeqCst,
            );
            fake_setup("1.0.3")(dest)
        },
        &Policy::default(),
        &request(&src, PackageKind::Installer, &dest),
    )
    .expect("installed");
    assert!(
        !swapped.load(std::sync::atomic::Ordering::SeqCst),
        "the file could be changed"
    );
    assert!(
        !work.path().join("deploy").exists()
            || std::fs::read_dir(work.path().join("deploy"))
                .expect("dir")
                .count()
                == 0
    );
}

#[test]
fn a_destination_that_cant_be_reached_or_written_fails_cleanly() {
    let key = TestKey::new(16);
    let src = source(&key, &[(portable("1.0.3"), portable_zip("1.0.3"), "1.0.3")]);
    let work = tempfile::tempdir().expect("work");
    // A drive letter this computer doesn't have (found at run time).
    if let Some(letter) = ('D'..='Z')
        .rev()
        .find(|l| !PathBuf::from(format!("{l}:\\")).exists())
    {
        let dest = PathBuf::from(format!(r"{letter}:\Apps\OpenMind Studio"));
        let error = provision_with(
            &key,
            work.path(),
            &Recorder::default(),
            &no_setup,
            &request(&src, PackageKind::Portable, &dest),
        )
        .expect_err("no such drive");
        assert!(error.contains("can't be created"), "{error}");
    }
    // A file where the parent folder should be: nothing can be created inside it.
    let blocker = work.path().join("not a folder");
    std::fs::write(&blocker, b"x").expect("file");
    let dest = blocker.join("OpenMind Studio");
    let error = provision_with(
        &key,
        work.path(),
        &Recorder::default(),
        &no_setup,
        &request(&src, PackageKind::Portable, &dest),
    )
    .expect_err("not writable");
    assert!(error.contains("can't be created"), "{error}");
}
