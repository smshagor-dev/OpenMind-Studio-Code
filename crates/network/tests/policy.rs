//! What this crate must never do, checked on its source: change Windows' proxy, the Registry, PATH or the process's
//! own environment, start a program, or write a package manager's configuration. It only reads the system proxy.

use std::fs;
use std::path::Path;

fn sources() -> Vec<(String, String)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    fs::read_dir(&dir)
        .expect("src")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "rs"))
        .filter(|path| !path.to_string_lossy().ends_with("_tests.rs"))
        .map(|path| {
            (
                path.display().to_string(),
                fs::read_to_string(&path).expect("read"),
            )
        })
        .collect()
}

#[test]
fn the_crate_never_changes_the_system_or_starts_a_program() {
    let forbidden = [
        "set_var(",
        "remove_var(",
        "RegSetValue",
        "RegCreateKey",
        "RegDeleteValue",
        "WinHttpSetDefaultProxyConfiguration",
        "InternetSetOption",
        "Command::new",
        "npm config set",
        "pip config",
        "git config --global",
        ".npmrc",
        "pip.ini",
        "cargo/config",
    ];
    for (path, text) in sources() {
        let code = text.split("#[cfg(test)]").next().unwrap_or_default();
        for needle in forbidden {
            assert!(!code.contains(needle), "{path} contains {needle}");
        }
    }
}

#[test]
fn only_read_only_windows_proxy_calls_are_used() {
    let (_, system) = sources()
        .into_iter()
        .find(|(path, _)| path.ends_with("system.rs"))
        .expect("system.rs");
    for call in [
        "WinHttpGetIEProxyConfigForCurrentUser",
        "WinHttpGetDefaultProxyConfiguration",
    ] {
        assert!(system.contains(call), "{call}");
    }
    // No automatic proxy discovery: that would contact the network (WPAD) at detection time.
    assert!(!system.contains("WinHttpGetProxyForUrl"));
    assert!(!system.contains("WinHttpDetectAutoProxyConfigUrl"));
}

/// Every Rust source file of the app (all crates and the Tauri app), without its test module.
fn app_sources() -> Vec<(String, String)> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut dirs = vec![root.join("src-tauri/src")];
    for entry in fs::read_dir(root.join("crates"))
        .expect("crates")
        .filter_map(Result::ok)
    {
        dirs.push(entry.path().join("src"));
    }
    let mut out = Vec::new();
    while let Some(dir) = dirs.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for path in entries.filter_map(Result::ok).map(|e| e.path()) {
            if path.is_dir() {
                dirs.push(path);
            } else if path.extension().is_some_and(|ext| ext == "rs")
                && !path.to_string_lossy().ends_with("_tests.rs")
            {
                let text = fs::read_to_string(&path).expect("read");
                let code = text
                    .split("#[cfg(test)]")
                    .next()
                    .unwrap_or_default()
                    .to_string();
                out.push((path.display().to_string(), code));
            }
        }
    }
    out
}

#[test]
fn nothing_in_the_app_changes_windows_proxy_path_or_a_tools_global_configuration() {
    let sources = app_sources();
    assert!(sources.len() > 100, "the scan found the app's sources");
    let forbidden = [
        // Windows' proxy (per user and WinHTTP) and the environment of the user or machine.
        "WinHttpSetDefaultProxyConfiguration",
        "InternetSetOption",
        "netsh",
        "setx",
        // Global tool configuration.
        "\"--global\"",
        "config --global",
        "npm config set",
        "pip config",
        "go env -w",
        "\"env\", \"-w\"",
        // A proxy (and so its password) on a command line, where other processes can read it.
        "http.proxy=",
        "\"--proxy\"",
        "--proxy=",
    ];
    for (path, code) in &sources {
        for needle in forbidden {
            assert!(!code.contains(needle), "{path} contains {needle}");
        }
    }
    // The Registry is never written, except by the optional shell integration (the user's own PATH and "Open with
    // OpenMind Studio"), which does it only on an explicit request: one file, current user only.
    let integration = |path: &str| {
        path.replace('\\', "/")
            .ends_with("src-tauri/src/integration/registry.rs")
    };
    for (path, code) in &sources {
        if integration(path) {
            assert!(
                !code.contains("HKEY_LOCAL_MACHINE"),
                "{path} must stay per user"
            );
            continue;
        }
        for call in [
            "RegSetValue",
            "RegCreateKey",
            "RegDeleteValue",
            "RegDeleteKey",
            "RegDeleteTree",
        ] {
            assert!(!code.contains(call), "{path} calls {call}");
        }
    }
    assert!(
        sources.iter().any(|(path, _)| integration(path)),
        "the integration store was scanned"
    );
    // Only the shell-integration commands use it.
    for (path, code) in &sources {
        let path = path.replace('\\', "/");
        if code.contains("UserRegistry") {
            assert!(
                path.ends_with("src-tauri/src/commands/integration.rs")
                    || path.contains("src-tauri/src/integration/"),
                "{path} uses the Registry store"
            );
        }
    }
}
