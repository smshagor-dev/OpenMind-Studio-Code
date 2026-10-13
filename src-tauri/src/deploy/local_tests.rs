use super::*;
use openmind_deploy::advert::{release_name, PackageKind};

fn fake_verifier(_: &[u8], signature: &str, _: &str) -> Result<(), String> {
    (signature == "signed")
        .then_some(())
        .ok_or_else(|| "not signed".into())
}

fn copy(root: &Path, layout: InstallLayout, universal: &str) -> ThisCopy {
    ThisCopy {
        exe: root.join("OpenMindStudio.exe"),
        install_dir: root.to_path_buf(),
        universal_dir: PathBuf::from(universal),
        on_network: universal.starts_with(r"\\"),
        layout,
        data_scope: DataScope::Personal,
        version: "1.0.3".into(),
        build_arch: Arch::X64,
        os_arch: Arch::X64,
        hostname: "PC-01".into(),
        user: "Student".into(),
        profile_id: "abc".into(),
        data_root: root.join("data"),
        db_path: root.join("data").join("openmind-studio.db"),
        logs_dir: root.join("logs"),
        temp_dir: root.join("temp"),
        cache_dir: root.join("cache"),
        runtimes_dir: root.join("runtimes"),
        runtime_store: if layout == InstallLayout::Network {
            RuntimeStore::Shared
        } else {
            RuntimeStore::Local
        },
        packages_dir: root.join("deploy").join("packages"),
    }
}

#[test]
fn a_shared_installation_offers_itself_by_its_network_path_and_its_ready_runtimes() {
    let dir = tempfile::tempdir().expect("dir");
    let runtimes = dir.path().join("runtimes");
    std::fs::create_dir_all(runtimes.join("python/versions/3.14.7")).expect("python");
    std::fs::create_dir_all(runtimes.join("python/versions/3.13.1.installing")).expect("staging");
    std::fs::create_dir_all(runtimes.join("node/versions/24.21.0")).expect("node");
    std::fs::write(runtimes.join("node/versions/24.21.0.lock"), b"").expect("lock");
    let this = copy(
        dir.path(),
        InstallLayout::Network,
        r"\\lab-server\apps\OpenMind Studio",
    );
    let offer = build_offer(
        &this,
        std::slice::from_ref(&this.packages_dir),
        &fake_verifier,
    )
    .expect("offer");
    assert_eq!(offer.manifest.kind, DeploymentKind::NetworkShare);
    assert_eq!(
        offer.manifest.share_path.as_deref(),
        Some(r"\\lab-server\apps\OpenMind Studio")
    );
    let kinds: Vec<String> = offer
        .manifest
        .runtimes
        .iter()
        .map(|r| format!("{}/{}", r.kind, r.version))
        .collect();
    assert_eq!(kinds, ["node/24.21.0", "python/3.14.7"]);
    // Every computer running the share announces the same deployment.
    let other = copy(
        dir.path(),
        InstallLayout::Network,
        r"\\LAB-SERVER\Apps\OpenMind Studio\",
    );
    let other_offer = build_offer(&other, &[], &fake_verifier).expect("offer");
    assert_eq!(
        other_offer.manifest.deployment_id,
        offer.manifest.deployment_id
    );
    let advert = offer.advert("0123456789abcdef", 0);
    advert.validate().expect("valid advert");
    assert_eq!(advert.runtimes, 2);
}

#[test]
fn a_computer_offers_only_signed_packages_and_nothing_otherwise() {
    let dir = tempfile::tempdir().expect("dir");
    let this = copy(
        dir.path(),
        InstallLayout::PerUser,
        r"C:\Apps\OpenMind Studio",
    );
    let error = build_offer(
        &this,
        std::slice::from_ref(&this.packages_dir),
        &fake_verifier,
    )
    .err()
    .expect("nothing");
    assert!(error.contains("nothing to offer"), "{error}");

    std::fs::create_dir_all(&this.packages_dir).expect("packages");
    let setup = release_name("1.0.3", "windows", Arch::X64, PackageKind::Installer);
    std::fs::write(this.packages_dir.join(&setup), b"setup").expect("setup");
    std::fs::write(this.packages_dir.join(format!("{setup}.sig")), "signed").expect("sig");
    let forged = release_name("1.0.3", "windows", Arch::X86, PackageKind::Installer);
    std::fs::write(this.packages_dir.join(&forged), b"forged").expect("forged");
    std::fs::write(this.packages_dir.join(format!("{forged}.sig")), "forged").expect("sig");
    let offer = build_offer(
        &this,
        std::slice::from_ref(&this.packages_dir),
        &fake_verifier,
    )
    .expect("offer");
    assert_eq!(offer.manifest.kind, DeploymentKind::PackageSource);
    assert_eq!(offer.manifest.packages.len(), 1);
    assert_eq!(offer.problems.len(), 1, "{:?}", offer.problems);
    assert!(offer.files.contains_key(&setup));
    assert!(
        offer.manifest.runtimes.is_empty(),
        "a local store isn't offered"
    );
    let advert = offer.advert("0123456789abcdef", 52000);
    advert.validate().expect("valid");
    assert_eq!((advert.http_port, advert.packages), (52000, 1));
    // Nothing of this computer rides along.
    let text = serde_json::to_string(&offer.manifest).expect("json");
    assert!(
        !text.contains("PC-01")
            && !text.contains("Student")
            && !text.contains(&dir.path().display().to_string())
    );
}

#[test]
fn a_network_layout_on_a_local_path_is_not_announced_as_a_share() {
    let dir = tempfile::tempdir().expect("dir");
    let this = copy(
        dir.path(),
        InstallLayout::Network,
        r"C:\Share\OpenMind Studio",
    );
    assert_eq!(this.share_path(), None);
}

#[test]
fn the_windows_architecture_is_read_from_the_system() {
    let arch = os_arch();
    assert!(arch.runs(Arch::of_this_build()), "{arch:?}");
}
