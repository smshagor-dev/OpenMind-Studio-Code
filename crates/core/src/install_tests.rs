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
    // Nothing was chosen: the field isn't written, so an older version reads the file unchanged.
    assert!(!text.contains("userDesktopShortcuts"), "{text}");
}

#[test]
fn per_user_desktop_shortcuts_default_to_network_installs_and_survive_an_update() {
    let dir = tempfile::tempdir().expect("tempdir");
    assert!(
        set_user_desktop_shortcuts(dir.path(), false).is_err(),
        "no install.json: nothing is guessed"
    );
    write(dir.path(), InstallLayout::Network, "1.0.2").expect("write");
    let InstallRecord::Found(meta) = read(dir.path()) else {
        panic!("not found");
    };
    assert!(meta.gives_user_desktop_shortcuts());
    let off = set_user_desktop_shortcuts(dir.path(), false).expect("off");
    assert!(!off.gives_user_desktop_shortcuts());
    // The setup of the next version rewrites the layout; the administrator's choice stays.
    write(dir.path(), InstallLayout::Network, "1.0.3").expect("update");
    let InstallRecord::Found(updated) = read(dir.path()) else {
        panic!("not found");
    };
    assert_eq!(updated.user_desktop_shortcuts, Some(false));
    assert_eq!(updated.app_version, "1.0.3");
    // Other layouts have their own installer shortcuts: off unless asked for.
    write(dir.path(), InstallLayout::PerUser, "1.0.3").expect("per-user");
    let InstallRecord::Found(mine) = read(dir.path()) else {
        panic!("not found");
    };
    assert_eq!(mine.user_desktop_shortcuts, Some(false));
    let fresh = tempfile::tempdir().expect("tempdir");
    write(fresh.path(), InstallLayout::PerUser, "1.0.3").expect("per-user");
    let InstallRecord::Found(per_user) = read(fresh.path()) else {
        panic!("not found");
    };
    assert!(!per_user.gives_user_desktop_shortcuts());
    // A file written by 1.0.2 (no field) still reads.
    let old = r#"{"format":"openmind-install","schemaVersion":1,"layout":"network","installedAt":"x","appVersion":"1.0.2"}"#;
    std::fs::write(install_file(fresh.path()), old).expect("old");
    assert!(
        matches!(read(fresh.path()), InstallRecord::Found(m) if m.gives_user_desktop_shortcuts())
    );
}

#[test]
fn a_local_path_has_no_other_universal_name() {
    let dir = tempfile::tempdir().expect("tempdir");
    assert_eq!(universal_path(dir.path()), dir.path());
    let unc = Path::new(r"\\fs01\apps\OpenMind Studio");
    assert_eq!(universal_path(unc), unc);
    // A folder that can't be resolved is used as given (it is local, so it has no network name either).
    let gone = dir.path().join("gone");
    assert_eq!(resolved_install_dir(&gone), gone);
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
fn a_for_me_setup_in_a_network_folder_records_a_network_installation() {
    use InstallLayout::*;
    assert_eq!(layout_for_folder(PerUser, true, None), Network);
    assert_eq!(layout_for_folder(PerUser, true, Some(Network)), Network);
    // A local folder stays the user's own copy.
    assert_eq!(layout_for_folder(PerUser, false, None), PerUser);
    // An update of a folder recorded as per-user keeps its data where it is.
    assert_eq!(layout_for_folder(PerUser, true, Some(PerUser)), PerUser);
    // Every other choice is recorded as asked.
    assert_eq!(layout_for_folder(Network, false, None), Network);
    assert_eq!(layout_for_folder(Portable, true, None), Portable);
    assert_eq!(layout_for_folder(PerMachine, true, None), PerMachine);
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

/// A second way to reach `target` (a junction on Windows, like a mapped drive or `subst` would give); `None` when the
/// system can't make one here.
fn alias_of(target: &Path, alias: &Path) -> Option<()> {
    #[cfg(windows)]
    {
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(alias)
            .arg(target)
            .output()
            .ok()?;
        made.status.success().then_some(())
    }
    #[cfg(not(windows))]
    {
        std::os::unix::fs::symlink(target, alias).ok()
    }
}

#[test]
fn one_installation_reached_two_ways_has_one_local_folder() {
    let temp = tempfile::tempdir().expect("tempdir");
    let installs = temp.path().join("Local State");
    let real = temp.path().join("share").join("OpenMind Studio");
    std::fs::create_dir_all(&real).expect("dir");
    let alias = temp.path().join("mapped");
    if alias_of(&temp.path().join("share"), &alias).is_none() {
        eprintln!("skipped: no junction/symlink possible here");
        return;
    }
    let through_alias = alias.join("OpenMind Studio");
    assert_ne!(
        install_key(&real),
        install_key(&through_alias),
        "the spellings differ"
    );
    assert_eq!(
        local_install_dir_in(&installs, &real),
        local_install_dir_in(&installs, &through_alias)
    );
}

#[test]
fn a_local_folder_made_from_the_path_as_started_keeps_being_used() {
    let temp = tempfile::tempdir().expect("tempdir");
    let installs = temp.path().join("Local State");
    let real = temp.path().join("share").join("OpenMind Studio");
    std::fs::create_dir_all(&real).expect("dir");
    let alias = temp.path().join("mapped");
    if alias_of(&temp.path().join("share"), &alias).is_none() {
        eprintln!("skipped: no junction/symlink possible here");
        return;
    }
    let through_alias = alias.join("OpenMind Studio");
    // An earlier version keyed the folder by the alias; that data stays where it is.
    let earlier = installs.join(install_key(&through_alias));
    std::fs::create_dir_all(&earlier).expect("dir");
    assert_eq!(local_install_dir_in(&installs, &through_alias), earlier);
    // Once the resolved folder exists too, it wins.
    let resolved = installs.join(install_key(&resolved_install_dir(&through_alias)));
    std::fs::create_dir_all(&resolved).expect("dir");
    assert_eq!(local_install_dir_in(&installs, &through_alias), resolved);
    // A path that can't be resolved is used as given.
    let gone = temp.path().join("gone").join("OpenMind Studio");
    assert_eq!(
        local_install_dir_in(&installs, &gone),
        installs.join(install_key(&gone))
    );
}
