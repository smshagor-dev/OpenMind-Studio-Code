use std::process::Command;

/// Runs a tool and returns its trimmed first line, or `fallback` when it is missing or fails.
fn first_line(program: &str, args: &[&str], fallback: &str) -> String {
    Command::new(program)
        .args(args)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|text| text.lines().next().map(|line| line.trim().to_string()))
        .filter(|line| !line.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn main() {
    // The build's commit and compiler, for Help > About and "Copy system info". Only read at build time.
    let commit = first_line("git", &["rev-parse", "--short", "HEAD"], "unknown");
    let rustc = first_line("rustc", &["--version"], "unknown");
    println!("cargo:rustc-env=OPENMIND_COMMIT={commit}");
    println!("cargo:rustc-env=OPENMIND_RUSTC={rustc}");
    println!("cargo:rerun-if-changed=../.git/HEAD");
    tauri_build::build()
}
