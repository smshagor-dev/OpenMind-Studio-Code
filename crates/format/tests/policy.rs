//! The formatting crate must not change the machine or the process environment: it may only read PATH, and put
//! runtime folders in front of PATH for one child process. This scans the source for anything that would do more.

use std::path::Path;

fn sources() -> Vec<(String, String)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    std::fs::read_dir(dir)
        .expect("src")
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|e| e == "rs"))
        .map(|entry| {
            (
                entry.file_name().to_string_lossy().into_owned(),
                std::fs::read_to_string(entry.path()).expect("read"),
            )
        })
        .collect()
}

fn code_of(text: &str) -> String {
    // Everything before the unit tests, so the scan doesn't look at its own examples.
    text.split("#[cfg(test)]").next().unwrap_or("").to_string()
}

#[test]
fn nothing_writes_the_environment_the_registry_or_the_disk() {
    for (name, text) in sources() {
        let code = code_of(&text);
        for forbidden in [
            "set_var",
            "remove_var",
            "winreg",
            "HKEY_",
            "std::fs::write",
            "fs::write(",
            "File::create",
            "OpenOptions",
            "reqwest",
            "ureq",
            "TcpStream",
        ] {
            assert!(!code.contains(forbidden), "{name} uses {forbidden}");
        }
    }
}

#[test]
fn the_child_gets_its_own_path_and_a_hidden_window() {
    let run = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/run.rs"))
        .expect("run.rs");
    assert!(
        run.contains("command.env(\"PATH\""),
        "PATH is set on the child command only"
    );
    assert!(run.contains("CREATE_NO_WINDOW"));
}

#[test]
fn a_formatter_is_never_started_through_a_shell() {
    let run = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/run.rs"))
        .expect("run.rs");
    let code = code_of(&run);
    assert!(!code.contains("\"cmd\"") && !code.contains("powershell") && !code.contains("\"sh\""));
}
