use super::*;

fn kind(exe: &str, files: &[&str]) -> InstallKind {
    let roots = [
        PathBuf::from(r"C:\Program Files"),
        PathBuf::from(r"C:\Program Files (x86)"),
    ];
    let files: Vec<PathBuf> = files.iter().map(PathBuf::from).collect();
    install_kind_for(Path::new(exe), &roots, &|path| {
        files.iter().any(|f| f == path)
    })
}

#[test]
fn the_setup_msi_and_portable_copies_are_told_apart() {
    let nsis = r"C:\Users\Ivan\AppData\Local\OpenMind Studio\OpenMindStudio.exe";
    assert_eq!(
        kind(
            nsis,
            &[r"C:\Users\Ivan\AppData\Local\OpenMind Studio\uninstall.exe"]
        ),
        InstallKind::Nsis
    );
    assert_eq!(
        kind(r"C:\Program Files\OpenMind Studio\OpenMindStudio.exe", &[]),
        InstallKind::Msi
    );
    assert_eq!(
        kind(r"c:\program files\OpenMind Studio\OpenMindStudio.exe", &[]),
        InstallKind::Msi
    );
    assert_eq!(
        kind(r"E:\Tools\OpenMind Studio\OpenMindStudio.exe", &[]),
        InstallKind::Portable
    );
    // A folder that only starts like Program Files is not it.
    assert_eq!(
        kind(r"C:\Program FilesX\OpenMind Studio\OpenMindStudio.exe", &[]),
        InstallKind::Portable
    );
    assert_eq!(kind("OpenMindStudio.exe", &[]), InstallKind::Portable);
}

#[test]
fn stale_downloads_are_removed() {
    let tmp = tempfile::tempdir().expect("tmp");
    let dir = tmp.path().join("temp").join("update");
    std::fs::create_dir_all(&dir).expect("dir");
    std::fs::write(dir.join("OpenMind-Studio-9.9.9.installer"), b"x").expect("write");
    clean_stale_downloads(&tmp.path().join("temp"));
    assert!(!dir.exists());
    assert!(
        tmp.path().join("temp").exists(),
        "only the update folder goes"
    );
}
