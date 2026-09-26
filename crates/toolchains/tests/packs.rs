//! Manifest -> versions -> active version -> PATH folders, against real temp folders.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use openmind_toolchains::{load, verify, ToolStatus, VersionStatus, DEFAULT_MAX_VERSIONS};

const PLATFORM: &str = "windows-x64";

fn app() -> tempfile::TempDir {
    tempfile::tempdir().expect("app folder")
}

fn put(root: &Path, relative: &str) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
    fs::write(path, "x").expect("file");
}

fn manifest(root: &Path, json: &str) {
    let path = root.join("tools/toolchains.json");
    fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
    fs::write(path, json).expect("manifest");
}

fn versions_json(id: &str, versions: &[&str], extra: &str) -> String {
    let list: Vec<String> = versions
        .iter()
        .map(|v| {
            format!(
                r#"{{"version":"{v}","platform":"{PLATFORM}","path":"tools/{id}/{v}/bin/{id}.exe","bundled":true}}"#
            )
        })
        .collect();
    format!(
        r#"{{"tools":[{{"id":"{id}"{extra},"versions":[{}]}}]}}"#,
        list.join(",")
    )
}

fn none() -> HashMap<String, String> {
    HashMap::new()
}

#[test]
fn no_manifest_means_every_known_tool_is_missing_or_external_and_nothing_is_invented() {
    let dir = app();
    let packs = load(dir.path(), PLATFORM, &none());
    assert!(!packs.manifest_found && packs.manifest_error.is_none());
    let git = packs.tool("git").expect("git");
    assert_eq!(git.status, ToolStatus::Missing);
    assert!(git.versions.is_empty() && git.active_version.is_none() && git.path.is_none());
    assert_eq!(
        packs.tool("android-sdk").expect("sdk").status,
        ToolStatus::External
    );
    assert_eq!(
        packs.tool("flutter-sdk").expect("sdk").status,
        ToolStatus::External
    );
    assert!(packs.tools.iter().all(|t| t.status != ToolStatus::Active));
    assert!(packs.injection().path_prepend.is_empty());
    assert!(
        !dir.path().join("tools").exists(),
        "loading creates nothing"
    );
}

#[test]
fn the_newest_stable_version_is_active_by_default() {
    let dir = app();
    for v in ["2.45.0", "2.47.1", "2.46.2"] {
        put(dir.path(), &format!("tools/git/{v}/bin/git.exe"));
    }
    manifest(
        dir.path(),
        &versions_json("git", &["2.45.0", "2.47.1", "2.46.2"], ""),
    );
    let git = load(dir.path(), PLATFORM, &none());
    let git = git.tool("git").expect("git");
    assert_eq!(git.status, ToolStatus::Active);
    assert_eq!(git.active_version.as_deref(), Some("2.47.1"));
    let order: Vec<&str> = git.versions.iter().map(|v| v.version.as_str()).collect();
    assert_eq!(order, ["2.47.1", "2.46.2", "2.45.0"], "newest first");
    assert!(git.versions[0].latest && !git.versions[1].latest);
    assert_eq!(git.versions[0].status, VersionStatus::Active);
    assert_eq!(git.versions[1].status, VersionStatus::Bundled);
}

#[test]
fn a_prerelease_is_never_the_default() {
    let dir = app();
    for v in ["3.0.0-rc1", "2.9.0"] {
        put(dir.path(), &format!("tools/composer/{v}/bin/composer.exe"));
    }
    manifest(
        dir.path(),
        &versions_json("composer", &["3.0.0-rc1", "2.9.0"], ""),
    );
    let packs = load(dir.path(), PLATFORM, &none());
    assert_eq!(
        packs.tool("composer").expect("c").active_version.as_deref(),
        Some("2.9.0")
    );
}

#[test]
fn at_most_five_versions_are_kept_and_the_oldest_are_reported() {
    let dir = app();
    let all = [
        "1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0", "1.6.0",
    ];
    for v in all {
        put(dir.path(), &format!("tools/debugpy/{v}/bin/debugpy.exe"));
    }
    manifest(dir.path(), &versions_json("debugpy", &all, ""));
    let packs = load(dir.path(), PLATFORM, &none());
    let tool = packs.tool("debugpy").expect("debugpy");
    assert_eq!(tool.versions.len(), DEFAULT_MAX_VERSIONS);
    assert_eq!(tool.versions[0].version, "1.6.0");
    assert_eq!(tool.versions[4].version, "1.2.0");
    assert_eq!(tool.ignored_versions, 2);
    assert!(packs.warnings.iter().any(|w| w.contains("2 oldest")));
}

#[test]
fn fewer_than_five_is_shown_as_it_is() {
    let dir = app();
    put(dir.path(), "tools/git/2.47.0/bin/git.exe");
    manifest(dir.path(), &versions_json("git", &["2.47.0"], ""));
    let tool = load(dir.path(), PLATFORM, &none());
    assert_eq!(tool.tool("git").expect("git").versions.len(), 1);
}

#[test]
fn the_users_choice_wins_and_an_unusable_choice_is_ignored() {
    let dir = app();
    for v in ["2.46.0", "2.47.0"] {
        put(dir.path(), &format!("tools/git/{v}/bin/git.exe"));
    }
    manifest(dir.path(), &versions_json("git", &["2.46.0", "2.47.0"], ""));
    let chosen = HashMap::from([("git".to_string(), "2.46.0".to_string())]);
    let packs = load(dir.path(), PLATFORM, &chosen);
    assert_eq!(
        packs.tool("git").expect("git").active_version.as_deref(),
        Some("2.46.0")
    );
    assert!(packs.can_select("git", "2.47.0") && !packs.can_select("git", "9.9.9"));
    let stale = HashMap::from([("git".to_string(), "1.0.0".to_string())]);
    let packs = load(dir.path(), PLATFORM, &stale);
    assert_eq!(
        packs.tool("git").expect("git").active_version.as_deref(),
        Some("2.47.0")
    );
    let packager = versions_json("git", &["2.46.0", "2.47.0"], r#","activeVersion":"2.46.0""#);
    manifest(dir.path(), &packager);
    let packs = load(dir.path(), PLATFORM, &none());
    assert_eq!(
        packs.tool("git").expect("git").active_version.as_deref(),
        Some("2.46.0")
    );
}

#[test]
fn a_missing_program_is_broken_never_active() {
    let dir = app();
    put(dir.path(), "tools/git/2.46.0/bin/git.exe");
    // 2.47.0 is listed but its file was never copied.
    manifest(dir.path(), &versions_json("git", &["2.46.0", "2.47.0"], ""));
    let packs = load(dir.path(), PLATFORM, &none());
    let git = packs.tool("git").expect("git");
    let newest = &git.versions[0];
    assert_eq!(newest.version, "2.47.0");
    assert_eq!(newest.status, VersionStatus::Broken);
    assert_eq!(
        git.active_version.as_deref(),
        Some("2.46.0"),
        "falls back to a version that exists"
    );
    assert!(!packs.can_select("git", "2.47.0"));

    let empty = app();
    manifest(empty.path(), &versions_json("git", &["2.47.0"], ""));
    let packs = load(empty.path(), PLATFORM, &none());
    let git = packs.tool("git").expect("git");
    assert_eq!(git.status, ToolStatus::Broken);
    assert!(git.active_version.is_none() && git.path.is_none());
    assert!(packs.active_program("git").is_none());
    assert!(
        packs.injection().path_prepend.is_empty(),
        "a broken tool injects nothing"
    );
}

#[test]
fn other_platforms_and_unbundled_entries_are_ignored() {
    let dir = app();
    put(dir.path(), "tools/git/2.47.0/bin/git.exe");
    manifest(
        dir.path(),
        r#"{"tools":[{"id":"git","versions":[
        {"version":"2.47.0","platform":"linux-x64","path":"tools/git/2.47.0/bin/git.exe"},
        {"version":"2.46.0","platform":"windows-x64","path":"tools/git/2.47.0/bin/git.exe","bundled":false}]}]}"#,
    );
    let packs = load(dir.path(), PLATFORM, &none());
    assert_eq!(packs.tool("git").expect("git").status, ToolStatus::Missing);
}

#[test]
fn a_path_outside_the_app_folder_is_refused() {
    let dir = app();
    manifest(
        dir.path(),
        r#"{"tools":[{"id":"git","versions":[{"version":"1.0.0","platform":"windows-x64","path":"../outside/git.exe"}]}]}"#,
    );
    let packs = load(dir.path(), PLATFORM, &none());
    assert!(packs.tool("git").expect("git").versions.is_empty());
    assert!(packs
        .warnings
        .iter()
        .any(|w| w.contains("not inside the app folder")));
}

#[test]
fn an_invalid_manifest_fails_safely() {
    let dir = app();
    manifest(dir.path(), "{ this is not json");
    let packs = load(dir.path(), PLATFORM, &none());
    assert!(packs.manifest_found);
    assert!(packs
        .manifest_error
        .as_deref()
        .unwrap_or("")
        .contains("not valid JSON"));
    assert!(packs.tools.iter().all(|t| t.status != ToolStatus::Active));
    assert!(!packs.tools.is_empty(), "the known tools are still listed");
}

#[test]
fn an_unknown_tool_in_the_manifest_is_reported_and_ignored() {
    let dir = app();
    manifest(dir.path(), r#"{"tools":[{"id":"mystery","versions":[]}]}"#);
    let packs = load(dir.path(), PLATFORM, &none());
    assert!(packs.tool("mystery").is_none());
    assert!(packs.warnings.iter().any(|w| w.contains("mystery")));
}

#[test]
fn injection_lists_only_the_folders_of_active_programs() {
    let dir = app();
    put(dir.path(), "tools/git/2.47.0/bin/git.exe");
    put(dir.path(), "tools/composer/2.9.0/bin/composer.exe");
    let both = r#"{"tools":[
      {"id":"git","versions":[{"version":"2.47.0","platform":"windows-x64","path":"tools/git/2.47.0/bin/git.exe"}]},
      {"id":"composer","versions":[{"version":"2.9.0","platform":"windows-x64","path":"tools/composer/2.9.0/bin/composer.exe"}]}]}"#;
    manifest(dir.path(), both);
    let packs = load(dir.path(), PLATFORM, &none());
    let injection = packs.injection();
    assert_eq!(injection.path_prepend.len(), 2);
    for p in &injection.path_prepend {
        assert!(p.starts_with(dir.path()), "{}", p.display());
    }
}

#[test]
fn verify_reports_a_missing_file_and_does_not_run_without_arguments() {
    let dir = app();
    let missing = verify(&dir.path().join("nope.exe"), None);
    assert!(!missing.ok && !missing.executed);
    put(dir.path(), "tools/x/x.exe");
    let present = verify(&dir.path().join("tools/x/x.exe"), None);
    assert!(
        present.ok && !present.executed,
        "a file with no verify arguments is not executed"
    );
}

#[cfg(windows)]
#[test]
fn verify_runs_a_program_only_when_the_manifest_gives_arguments() {
    let cmd = std::path::PathBuf::from(std::env::var("ComSpec").expect("ComSpec"));
    let args = vec!["/C".to_string(), "echo v1.2.3".to_string()];
    let result = verify(&cmd, Some(&args));
    assert!(result.ok && result.executed, "{result:?}");
    assert_eq!(result.output.as_deref(), Some("v1.2.3"));
    let failing = vec!["/C".to_string(), "exit 3".to_string()];
    assert!(!verify(&cmd, Some(&failing)).ok);
}

#[test]
fn git_composer_and_debugpy_each_keep_their_own_active_version() {
    let dir = app();
    let mut tools = Vec::new();
    for (id, file) in [
        ("git", "git.exe"),
        ("composer", "composer.phar"),
        ("debugpy", "__main__.py"),
    ] {
        let mut versions = Vec::new();
        for v in ["1.0.0", "1.1.0"] {
            put(dir.path(), &format!("tools/{id}/{v}/{file}"));
            versions.push(format!(
                r#"{{"version":"{v}","platform":"windows-x64","path":"tools/{id}/{v}/{file}"}}"#
            ));
        }
        tools.push(format!(
            r#"{{"id":"{id}","versions":[{}]}}"#,
            versions.join(",")
        ));
    }
    manifest(dir.path(), &format!(r#"{{"tools":[{}]}}"#, tools.join(",")));
    let chosen = HashMap::from([
        ("git".to_string(), "1.0.0".to_string()),
        ("composer".to_string(), "1.1.0".to_string()),
    ]);
    let packs = load(dir.path(), PLATFORM, &chosen);
    let active = |id: &str| packs.tool(id).expect(id).active_version.clone();
    assert_eq!(active("git").as_deref(), Some("1.0.0"));
    assert_eq!(active("composer").as_deref(), Some("1.1.0"));
    assert_eq!(
        active("debugpy").as_deref(),
        Some("1.1.0"),
        "no choice: the latest"
    );
    // A debugger's files are not a command: they never go on a PATH.
    let injected = packs.injection().path_prepend;
    assert_eq!(injected.len(), 2);
    assert!(injected
        .iter()
        .all(|p| !p.to_string_lossy().contains("debugpy")));
}
