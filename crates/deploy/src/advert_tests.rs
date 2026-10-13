use super::*;

pub(crate) fn share_advert() -> Advert {
    Advert {
        protocol: PROTOCOL,
        deployment_id: crate::share_deployment_id(r"\\server\apps\openmind studio"),
        instance: "0123456789abcdef".into(),
        app_version: "1.0.3".into(),
        platform: "windows".into(),
        arch: Arch::X64,
        kind: DeploymentKind::NetworkShare,
        share_path: Some(r"\\server\apps\OpenMind Studio".into()),
        http_port: 0,
        packages: 0,
        runtimes: 3,
    }
}

pub(crate) fn package(version: &str, arch: Arch, kind: PackageKind) -> PackageEntry {
    PackageEntry {
        name: release_name(version, "windows", arch, kind),
        kind,
        arch,
        version: version.into(),
        size: 1024,
        sha256: "ab".repeat(32),
        signature: "dW50cnVzdGVkIGNvbW1lbnQ=".into(),
    }
}

pub(crate) fn source_manifest() -> Manifest {
    Manifest {
        format: MANIFEST_FORMAT.into(),
        protocol: PROTOCOL,
        deployment_id: crate::source_deployment_id("aaaa", r"c:\packages"),
        app_version: "1.0.3".into(),
        platform: "windows".into(),
        arch: Arch::X64,
        kind: DeploymentKind::PackageSource,
        share_path: None,
        packages: vec![
            package("1.0.3", Arch::X64, PackageKind::Installer),
            package("1.0.3", Arch::X86, PackageKind::Installer),
            package("1.0.3", Arch::X64, PackageKind::Portable),
        ],
        runtimes: vec![RuntimeEntry {
            kind: "python".into(),
            version: "3.14.7".into(),
        }],
    }
}

#[test]
fn a_well_formed_advert_and_manifest_pass() {
    share_advert().validate().expect("advert");
    source_manifest().validate().expect("manifest");
}

#[test]
fn every_untrusted_field_is_checked() {
    type Change = Box<dyn Fn(&mut Advert)>;
    let cases: Vec<(&str, Change)> = vec![
        ("protocol version", Box::new(|a| a.protocol = 2)),
        (
            "deployment id",
            Box::new(|a| a.deployment_id = "../x".into()),
        ),
        ("instance", Box::new(|a| a.instance = "XYZ".into())),
        ("app version", Box::new(|a| a.app_version = "1.0".into())),
        ("platform", Box::new(|a| a.platform = "dos".into())),
        (
            "share path",
            Box::new(|a| a.share_path = Some(r"C:\local".into())),
        ),
        (
            "share path",
            Box::new(|a| a.share_path = Some(r"\\server\..\x".into())),
        ),
        ("share path", Box::new(|a| a.share_path = None)),
        ("package server port", Box::new(|a| a.http_port = 8080)),
        ("package count", Box::new(|a| a.packages = 999)),
    ];
    for (field, change) in cases {
        let mut advert = share_advert();
        change(&mut advert);
        assert_eq!(advert.validate(), Err(field.to_string()), "{field}");
    }
}

#[test]
fn unknown_fields_are_refused_so_nothing_extra_rides_along() {
    let mut value = serde_json::to_value(share_advert()).expect("json");
    value["token"] = serde_json::Value::String("secret".into());
    assert!(serde_json::from_value::<Advert>(value).is_err());
}

#[test]
fn share_paths_must_be_network_paths_without_tricks() {
    for good in [
        r"\\server\apps",
        r"\\192.168.1.5\Apps With Spaces\OpenMind Studio",
        r"\\srv\Программы\ওপেনমাইন্ড",
    ] {
        assert!(valid_share_path(good, "windows"), "{good}");
    }
    for bad in [
        "",
        r"C:\x",
        r"\\server",
        r"\\?\C:\x",
        r"\\.\pipe\x",
        r"\\server\share\..\x",
        r"\\server\a:b",
        "\\\\server\\share\u{0}x",
        r"\\server\\share",
    ] {
        assert!(!valid_share_path(bad, "windows"), "{bad:?}");
    }
}

#[test]
fn package_names_are_exactly_the_release_names() {
    let mut entry = package("1.0.3", Arch::X64, PackageKind::Installer);
    assert_eq!(entry.name, "OpenMind-Studio_1.0.3_windows_x64_setup.exe");
    entry.validate("windows").expect("ok");
    for bad in [
        "../OpenMind-Studio_1.0.3_windows_x64_setup.exe",
        "evil.exe",
        "OpenMind-Studio_1.0.3_windows_x86_setup.exe",
    ] {
        let mut changed = entry.clone();
        changed.name = bad.into();
        assert_eq!(
            changed.validate("windows"),
            Err("package name".into()),
            "{bad}"
        );
    }
    entry.sha256 = "AB".repeat(32);
    assert_eq!(entry.validate("windows"), Err("package checksum".into()));
}

#[test]
fn release_names_read_back() {
    assert_eq!(
        parse_release_name("OpenMind-Studio_1.0.3_windows_x86_portable.zip"),
        Some((
            "1.0.3".into(),
            "windows".into(),
            Arch::X86,
            PackageKind::Portable
        ))
    );
    assert_eq!(
        parse_release_name("OpenMind-Studio_1.1.0-beta.2_windows_x64_setup.exe"),
        Some((
            "1.1.0-beta.2".into(),
            "windows".into(),
            Arch::X64,
            PackageKind::Installer
        ))
    );
    for other in [
        "OpenMind-Studio_1.0.3_windows_x64.msi",
        "OpenMind-Studio_1.0_windows_x64_setup.exe",
        "OpenMind-Studio_1.0.3_beos_x64_setup.exe",
        "setup.exe",
    ] {
        assert_eq!(parse_release_name(other), None, "{other}");
    }
}

#[test]
fn a_manifest_with_two_files_of_one_name_is_refused() {
    let mut manifest = source_manifest();
    manifest.packages.push(manifest.packages[0].clone());
    assert_eq!(manifest.validate(), Err("duplicate package".into()));
}
