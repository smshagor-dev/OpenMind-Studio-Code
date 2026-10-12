use super::*;

#[test]
fn layouts_parse_in_both_spellings_and_say_where_state_lives() {
    assert_eq!(
        InstallLayout::parse("per-user"),
        Some(InstallLayout::PerUser)
    );
    assert_eq!(
        InstallLayout::parse("perMachine"),
        Some(InstallLayout::PerMachine)
    );
    assert_eq!(
        InstallLayout::parse(" NETWORK "),
        Some(InstallLayout::Network)
    );
    assert_eq!(
        InstallLayout::parse("portable"),
        Some(InstallLayout::Portable)
    );
    assert_eq!(InstallLayout::parse("everyone"), None);
    assert!(InstallLayout::Network.local_state());
    assert!(InstallLayout::PerMachine.local_state());
    assert!(!InstallLayout::PerUser.local_state());
    assert!(!InstallLayout::Portable.installer_managed());
    assert!(InstallLayout::PerUser.installer_managed());
}

#[test]
fn install_json_round_trips_and_keeps_its_first_date_on_a_rewrite() {
    let dir = tempfile::tempdir().expect("tempdir");
    assert_eq!(read(dir.path()), InstallRecord::Missing);
    write(dir.path(), InstallLayout::Network, "1.0.2").expect("write");
    let InstallRecord::Found(first) = read(dir.path()) else {
        panic!("not found");
    };
    assert_eq!(first.layout, InstallLayout::Network);
    assert_eq!(first.format, INSTALL_FORMAT);
    std::fs::write(
        install_file(dir.path()),
        serde_json::to_string(&InstallMetadata {
            installed_at: "2020-01-01T00:00:00Z".into(),
            ..first
        })
        .expect("json"),
    )
    .expect("write");
    write(dir.path(), InstallLayout::Network, "1.0.3").expect("update");
    let InstallRecord::Found(updated) = read(dir.path()) else {
        panic!("not found");
    };
    assert_eq!(updated.installed_at, "2020-01-01T00:00:00Z");
    assert_eq!(updated.app_version, "1.0.3");
    let text = std::fs::read_to_string(install_file(dir.path())).expect("read");
    assert!(text.contains("\"layout\": \"network\""), "{text}");
}

#[test]
fn a_damaged_foreign_or_newer_install_json_is_unreadable_never_a_layout() {
    let dir = tempfile::tempdir().expect("tempdir");
    for body in [
        "{ broken",
        r#"{"format":"other","schemaVersion":1,"layout":"network","installedAt":"x","appVersion":"1"}"#,
        r#"{"format":"openmind-install","schemaVersion":7,"layout":"network","installedAt":"x","appVersion":"1"}"#,
        r#"{"format":"openmind-install","schemaVersion":1,"layout":"cloud","installedAt":"x","appVersion":"1"}"#,
    ] {
        std::fs::write(install_file(dir.path()), body).expect("write");
        assert!(
            matches!(read(dir.path()), InstallRecord::Unreadable(_)),
            "{body}"
        );
    }
}

#[test]
fn a_copy_without_metadata_is_classified_from_its_installer() {
    assert_eq!(
        infer_layout(InstallerHint::Msi, false),
        InstallLayout::PerMachine
    );
    assert_eq!(
        infer_layout(InstallerHint::Nsis, false),
        InstallLayout::PerUser
    );
    // A per-user setup put on a network share: every computer would open one database next to the program.
    assert_eq!(
        infer_layout(InstallerHint::Nsis, true),
        InstallLayout::Network
    );
    // A portable copy on a share keeps asking (the data scope), as before.
    assert_eq!(
        infer_layout(InstallerHint::Portable, true),
        InstallLayout::Portable
    );
}

#[test]
fn the_install_key_is_one_folder_whatever_its_spelling() {
    let a = install_key(Path::new(r"C:\Program Files\OpenMind Studio"));
    assert_eq!(a.len(), 16);
    assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    assert_eq!(
        a,
        install_key(Path::new(r"\\?\C:\Program Files\OpenMind Studio\"))
    );
    assert_eq!(
        a,
        install_key(Path::new("C:/Program Files/OpenMind Studio"))
    );
    if cfg!(windows) {
        assert_eq!(
            a,
            install_key(Path::new(r"c:\program files\openmind studio"))
        );
    }
    assert_ne!(a, install_key(Path::new(r"D:\OpenMind Studio")));
    assert_eq!(
        install_key(Path::new(r"\\?\UNC\lab-server\apps\OpenMind Studio")),
        install_key(Path::new(r"\\lab-server\apps\OpenMind Studio"))
    );
}

#[test]
fn unc_paths_are_remote_and_local_ones_are_not() {
    assert!(is_remote_path(Path::new(
        r"\\lab-server\apps\OpenMind Studio"
    )));
    assert!(is_remote_path(Path::new(
        r"\\?\UNC\lab-server\apps\OpenMind Studio"
    )));
    assert!(is_remote_path(Path::new("//lab-server/apps")));
    let local = tempfile::tempdir().expect("tempdir");
    assert!(!is_remote_path(local.path()));
    assert!(!is_remote_path(Path::new(r"\\.\PhysicalDrive0")));
}

#[test]
fn a_temporary_extraction_folder_is_recognised() {
    let temp = Path::new(r"C:\Users\x\AppData\Local\Temp");
    assert!(runs_from_temporary_folder(
        Path::new(
            r"C:\Users\x\AppData\Local\Temp\Temp1_OpenMindStudio-1.0.2-portable-win-x64.zip\OpenMind Studio"
        ),
        temp
    ));
    assert!(runs_from_temporary_folder(
        Path::new(r"D:\scratch\Temp2_omstudio.zip\OpenMind Studio"),
        Path::new(r"C:\nowhere")
    ));
    assert!(!runs_from_temporary_folder(
        Path::new(r"D:\Apps\OpenMind Studio"),
        temp
    ));
    assert!(!runs_from_temporary_folder(
        Path::new(r"C:\Users\x\AppData\Local\Templates\OpenMind"),
        temp
    ));
}

#[test]
fn the_local_state_record_keeps_its_first_start_and_its_scope() {
    let local = tempfile::tempdir().expect("tempdir");
    assert_eq!(read_state(local.path()), None);
    record_start(
        local.path(),
        Path::new(r"\\lab\apps\OpenMind Studio"),
        InstallLayout::Portable,
        Some(crate::DataScope::PerMachine),
        "1.0.2",
    )
    .expect("record");
    let first = read_state(local.path()).expect("state");
    assert_eq!(first.data_scope, Some(crate::DataScope::PerMachine));
    std::thread::sleep(Duration::from_millis(1100));
    record_start(
        local.path(),
        Path::new(r"\\lab\apps\OpenMind Studio"),
        InstallLayout::Portable,
        Some(crate::DataScope::PerMachine),
        "1.0.3",
    )
    .expect("record");
    let second = read_state(local.path()).expect("state");
    assert_eq!(second.first_started_at, first.first_started_at);
    assert_eq!(second.app_version, "1.0.3");
    std::fs::write(local.path().join(STATE_FILE), "{ damaged").expect("write");
    assert_eq!(read_state(local.path()), None);
}

#[test]
fn a_missing_file_is_missing_and_a_folder_is_a_failure_not_missing() {
    let dir = tempfile::tempdir().expect("tempdir");
    assert!(matches!(
        read_text_retrying(&dir.path().join("none.json"), 3, Duration::from_millis(1)),
        ReadText::Missing
    ));
    // A path that exists but can't be read as a file (here: a folder) is reported, after the retries.
    std::fs::create_dir(dir.path().join("folder.json")).expect("dir");
    assert!(matches!(
        read_text_retrying(&dir.path().join("folder.json"), 3, Duration::from_millis(1)),
        ReadText::Failed(_)
    ));
}
