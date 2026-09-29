//! What the broker must never do, checked on its source: turn off TLS or certificate verification, ignore hashes, write a
//! tool's or the machine's configuration, change the process environment, the Registry or Windows' proxy.

use std::fs;
use std::path::{Path, PathBuf};

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).expect("dir").filter_map(Result::ok) {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs")
            && !path.to_string_lossy().ends_with("_tests.rs")
        {
            out.push(path);
        }
    }
}

#[test]
fn the_broker_never_weakens_security_or_changes_the_machine() {
    let mut files = Vec::new();
    rust_files(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut files,
    );
    assert!(!files.is_empty());
    let forbidden = [
        "sslVerify",
        "ssl_verify",
        "danger_accept",
        "dangerous",
        "InsecureSkipVerify",
        "NoVerifier",
        "--trusted-host",
        "strict-ssl",
        "GOINSECURE",
        "GONOSUMDB",
        "GOFLAGS=-insecure",
        "set_var(",
        "remove_var(",
        "RegSetValue",
        "RegCreateKey",
        "WinHttpSetDefaultProxyConfiguration",
        "InternetSetOption",
        "config --global",
        "config --system",
        "npm config set",
        "pip config set",
    ];
    for path in files {
        let text = fs::read_to_string(&path).expect("read");
        let code = text.split("#[cfg(test)]").next().unwrap_or_default();
        for needle in forbidden {
            assert!(
                !code.contains(needle),
                "{} contains {needle}",
                path.display()
            );
        }
    }
}
