//! The crate only reads: no network, no PATH or Registry writes, and the only process it ever starts is the one the
//! user asked to Verify.

use std::fs;
use std::path::{Path, PathBuf};

fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).expect("read_dir").flatten() {
        let path = entry.path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn nothing_here_downloads_or_changes_the_system_path() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let manifest = fs::read_to_string(root.join("Cargo.toml")).expect("manifest");
    for dep in [
        "ureq",
        "reqwest",
        "hyper",
        "curl",
        "tokio",
        "winreg",
        "openmind-runtime-manager",
    ] {
        assert!(!manifest.contains(dep), "{dep} must not be a dependency");
    }
    let mut files = Vec::new();
    sources(&root.join("src"), &mut files);
    let forbidden = [
        "std::net",
        "TcpStream",
        "set_var",
        "remove_var",
        "winreg",
        "setx",
        "HKEY_",
        "https://",
        "http://",
    ];
    for file in &files {
        let text = fs::read_to_string(file).expect("source");
        // `recipes.rs` is data: the pinned addresses the app's installer downloads from. Addresses are allowed there,
        // network code (the other needles) is not.
        let is_recipes = file.file_name().is_some_and(|n| n == "recipes.rs");
        for needle in forbidden {
            if is_recipes && needle.ends_with("://") {
                continue;
            }
            let in_code = text
                .lines()
                .filter(|l| !l.trim_start().starts_with("//"))
                .any(|l| l.contains(needle));
            assert!(!in_code, "{} uses {needle}", file.display());
        }
        let spawns = text.contains("Command::new");
        let is_verify = file.file_name().is_some_and(|n| n == "verify.rs");
        assert!(!spawns || is_verify, "{} starts a process", file.display());
    }
}
