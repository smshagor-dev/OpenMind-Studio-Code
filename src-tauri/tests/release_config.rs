//! Release configuration checks (Milestone 16): the licence file exists and is what the installers show, the
//! installers are configured to package it, and the build records no commit hash.

use std::path::Path;

fn root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace root")
}

fn read(relative: &str) -> String {
    std::fs::read_to_string(root().join(relative)).unwrap_or_else(|err| panic!("{relative}: {err}"))
}

#[test]
fn the_root_licence_is_the_full_apache_text() {
    let license = read("LICENSE");
    assert!(license.contains("Apache License"));
    assert!(license.contains("Version 2.0, January 2004"));
    assert!(license.contains("END OF TERMS AND CONDITIONS"));
    assert!(license.contains("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION"));
}

#[test]
fn both_installers_package_the_licence_and_the_metadata_agrees() {
    let conf: serde_json::Value =
        serde_json::from_str(&read("src-tauri/tauri.conf.json")).expect("tauri.conf.json");
    let bundle = &conf["bundle"];
    assert_eq!(bundle["licenseFile"], "../LICENSE");
    assert_eq!(bundle["license"], "Apache-2.0");
    let targets: Vec<&str> = bundle["targets"]
        .as_array()
        .expect("targets")
        .iter()
        .filter_map(|t| t.as_str())
        .collect();
    assert!(
        targets.contains(&"nsis") && targets.contains(&"msi"),
        "{targets:?}"
    );
    assert_eq!(bundle["windows"]["nsis"]["installMode"], "currentUser");
    assert!(read("Cargo.toml").contains("license = \"Apache-2.0\""));
}

#[test]
fn the_build_script_records_no_commit_hash() {
    let build = read("src-tauri/build.rs");
    assert!(
        !build.to_lowercase().contains("git"),
        "build.rs must not read Git"
    );
    assert!(!build.contains("COMMIT"));
}
