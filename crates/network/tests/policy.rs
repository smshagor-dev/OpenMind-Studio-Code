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
