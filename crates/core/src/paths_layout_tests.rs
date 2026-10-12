use super::*;

#[test]
fn per_machine_installs_write_per_user_and_read_bundles_from_the_program() {
    let program = PathBuf::from(r"C:\Program Files\OpenMind Studio");
    let local =
        PathBuf::from(r"C:\Users\ana\AppData\Local\OpenMind\Studio\Installations\0123456789abcdef");
    let paths = AppPaths::per_machine_install(program.clone(), local.clone());
    assert_eq!(paths.layout, InstallLayout::PerMachine);
    assert_eq!(paths.root_dir, local);
    assert_eq!(paths.install_dir, program);
    for writable in [
        &paths.db_path,
        &paths.logs_dir,
        &paths.webview_dir,
        &paths.settings_file,
        &paths.runtimes_dir,
        &paths.extensions_dir,
        &paths.cache_dir,
        &paths.temp_dir,
    ] {
        assert!(writable.starts_with(&local), "{}", writable.display());
    }
    assert_eq!(paths.shipped("lsp"), program.join("lsp"));
}

#[test]
fn a_network_install_shares_runtimes_and_keeps_database_settings_and_logs_on_this_computer() {
    let share = PathBuf::from(r"\\lab-server\apps\OpenMind Studio");
    let local_dir =
        PathBuf::from(r"C:\Users\ana\AppData\Local\OpenMind\Studio\Installations\fedcba9876543210");
    let paths = AppPaths::network(
        share.clone(),
        MachineDataPaths::local(&local_dir, "fedcba9876543210"),
    );
    assert_eq!(paths.layout, InstallLayout::Network);
    assert_eq!(paths.scope, DataScope::PerMachine);
    assert_eq!(paths.root_dir, share);
    for shared in [
        &paths.runtimes_dir,
        &paths.extensions_dir,
        &paths.cache_dir,
        &paths.shared_settings_dir,
    ] {
        assert!(shared.starts_with(&share), "{}", shared.display());
    }
    for local in [
        &paths.db_path,
        &paths.logs_dir,
        &paths.webview_dir,
        &paths.temp_dir,
        &paths.search_index_dir,
        &paths.ai_dir,
        &paths.mariadb_data_dir,
        &paths.mariadb_config_dir,
        &paths.settings_dir,
        &paths.settings_file,
        &paths.keybindings_file,
        &paths.extension_logs_dir,
    ] {
        assert!(local.starts_with(&local_dir), "{}", local.display());
    }
    assert_eq!(paths.db_path, local_dir.join("openmind-studio.db"));
}

#[test]
fn a_network_install_starts_even_when_the_share_is_read_only() {
    let share = tempfile::tempdir().expect("share");
    let local = tempfile::tempdir().expect("local");
    // A "shared folder" whose runtimes path is a file: creating it fails, as on a read-only share.
    std::fs::write(share.path().join("runtimes"), "not a folder").expect("write");
    let paths = AppPaths::network(
        share.path().to_path_buf(),
        MachineDataPaths::local(local.path(), "k"),
    );
    paths.ensure_dirs().expect("the local folders are enough");
    assert!(local.path().join("logs").is_dir());
    assert!(local.path().join("settings").is_dir());
}

#[test]
fn a_per_user_install_keeps_the_one_profile_layout_next_to_the_program() {
    let root = PathBuf::from(r"C:\Users\ana\AppData\Local\OpenMind Studio");
    let paths = AppPaths::from_root(root.clone()).with_layout(InstallLayout::PerUser);
    assert_eq!(paths.layout, InstallLayout::PerUser);
    assert_eq!(paths.db_path, root.join("data").join("openmind-studio.db"));
    assert_eq!(paths.install_dir, root);
    assert_eq!(paths.shared_settings_dir, paths.settings_dir);
}

#[test]
fn a_shipped_folder_in_the_data_folder_wins_and_a_missing_one_stays_there() {
    let root = tempfile::tempdir().expect("root");
    // Nothing next to the test program and nothing in the data folder: the data folder's path (as before).
    assert_eq!(
        shipped_dir(root.path(), "no-such-bundle"),
        root.path().join("no-such-bundle")
    );
    std::fs::create_dir_all(root.path().join("lsp")).expect("dir");
    assert_eq!(shipped_dir(root.path(), "lsp"), root.path().join("lsp"));
}
