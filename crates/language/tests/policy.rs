//! The "built in, no extra download" policy: language and project support ships inside the app, only *looks* at
//! the machine, and never fetches, installs or runs anything. Large SDKs are reported missing, never bundled or faked.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use openmind_language::tools::status_of;
use openmind_language::{
    file_status, language_for, workspace_status, Os, Source, ToolEnv, LANGUAGES,
};

fn empty_env(os: Os) -> ToolEnv {
    ToolEnv {
        os,
        project_dirs: vec![],
        portable_dirs: vec![],
        system_dirs: vec![],
        pathext: if os == Os::Windows {
            vec![".exe".into()]
        } else {
            vec![]
        },
        vars: HashMap::new(),
    }
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).expect("read_dir").flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn the_crate_has_no_network_or_process_code_at_all() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let manifest = fs::read_to_string(root.join("Cargo.toml")).expect("manifest");
    for dep in [
        "ureq",
        "reqwest",
        "hyper",
        "curl",
        "tokio",
        "openmind-runtime-manager",
    ] {
        assert!(!manifest.contains(dep), "{dep} must not be a dependency");
    }
    let mut files = Vec::new();
    rust_files(&root.join("src"), &mut files);
    assert!(files.len() > 10);
    let forbidden = [
        "std::net",
        "TcpStream",
        "UdpSocket",
        "std::process",
        "Command::new",
        "https://",
        "http://",
    ];
    for file in files {
        let text = fs::read_to_string(&file).expect("source");
        for needle in forbidden {
            // Prose in doc comments may name a URL; code may not.
            let in_code = text
                .lines()
                .filter(|l| !l.trim_start().starts_with("//"))
                .any(|l| l.contains(needle));
            assert!(!in_code, "{} uses {needle}", file.display());
        }
    }
}

#[test]
fn the_registry_is_static_data_that_needs_nothing_at_runtime() {
    assert!(LANGUAGES.len() >= 50);
    // Looking a language up needs no folder, no environment and no network.
    assert_eq!(language_for("src/main.rs").map(|l| l.id), Some("rust"));
    assert_eq!(language_for("Dockerfile").map(|l| l.id), Some("dockerfile"));
}

#[test]
fn large_sdks_are_reported_missing_with_a_hint_and_never_supplied() {
    let env = empty_env(Os::Windows);
    for id in [
        "flutter",
        "java",
        "dotnet",
        "go",
        "cargo",
        "rustc",
        "docker",
        "ruby",
        "gcc",
        "xcodebuild",
        "android-sdk",
    ] {
        let status = status_of(id, &env);
        assert!(
            status.found.is_none(),
            "{id} must not be found on an empty machine"
        );
        assert!(!status.hint.is_empty(), "{id} needs a setup hint");
    }
}

#[test]
fn node_python_and_php_are_the_runtime_managers_tools() {
    for id in ["node", "python", "php"] {
        let missing = status_of(id, &empty_env(Os::Windows));
        assert!(
            missing.hint.contains("Runtime Manager") || missing.hint.contains("PHP Server"),
            "{id}: {}",
            missing.hint
        );
    }
    let dir = tempfile::tempdir().expect("dir");
    fs::write(dir.path().join("python.exe"), "").expect("exe");
    let mut env = empty_env(Os::Windows);
    env.portable_dirs = vec![dir.path().to_path_buf()];
    let found = status_of("python", &env).found.expect("portable python");
    assert_eq!(found.source, Source::Portable);
}

#[test]
fn a_scan_with_no_tools_disables_commands_with_a_setup_reason_and_changes_nothing() {
    let dir = tempfile::tempdir().expect("dir");
    fs::write(dir.path().join("Cargo.toml"), "[package]\nname = \"a\"\n").expect("cargo");
    fs::write(dir.path().join("go.mod"), "module a\n").expect("go");
    let before: Vec<_> = fs::read_dir(dir.path())
        .expect("ls")
        .flatten()
        .map(|e| e.file_name())
        .collect();
    let status = workspace_status(dir.path(), &empty_env(Os::Windows));
    let after: Vec<_> = fs::read_dir(dir.path())
        .expect("ls")
        .flatten()
        .map(|e| e.file_name())
        .collect();
    assert_eq!(before.len(), after.len(), "a scan writes nothing");
    assert!(!status.projects.is_empty());
    for project in &status.projects {
        for command in &project.command_status {
            if !command.missing.is_empty() {
                assert!(
                    !command.available,
                    "{} can't run without its tool",
                    command.command.id
                );
                let reason = command.reason.as_deref().unwrap_or("");
                assert!(reason.contains("not found"), "{reason}");
            }
        }
        assert!(project.command_status.iter().any(|c| !c.available));
    }
    let env = empty_env(Os::Windows);
    let file = file_status(dir.path(), &dir.path().join("main.go"), &env, &status);
    assert!(file
        .formatters
        .iter()
        .all(|f| f.found.is_none() && !f.hint.is_empty()));
}
