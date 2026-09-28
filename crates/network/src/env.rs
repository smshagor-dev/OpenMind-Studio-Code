//! The environment a process OpenMind starts gets for the proxy. Applied to that process only — never to the user's
//! or machine's environment, and no tool's global configuration file is written.

use std::path::Path;

use crate::proxy::{Credentials, ResolvedProxy};

/// What besides the proxy the user asked for.
#[derive(Debug, Clone, Default)]
pub struct EnvExtras<'a> {
    /// A Go module proxy (`GOPROXY`), only when the user set one.
    pub go_proxy: Option<&'a str>,
    /// The offline wheelhouse (`PIP_FIND_LINKS`), only when the user turned it on.
    pub pip_find_links: Option<&'a Path>,
}

/// `(name, value)` pairs for the proxy in force. Empty when no proxy is in force (mode None, or nothing detected), so
/// the tools behave exactly as they would without OpenMind.
pub fn proxy_env(
    resolved: &ResolvedProxy,
    credentials: Option<&Credentials>,
    extras: &EnvExtras<'_>,
) -> Vec<(String, String)> {
    let mut vars: Vec<(String, String)> = Vec::new();
    let mut set = |name: &str, value: String| {
        vars.push((name.to_string(), value));
    };
    if resolved.active() {
        let http = resolved
            .http
            .as_ref()
            .or(resolved.https.as_ref())
            .map(|u| u.url(credentials));
        let https = resolved
            .https
            .as_ref()
            .or(resolved.http.as_ref())
            .map(|u| u.url(credentials));
        let no_proxy = resolved
            .no_proxy
            .iter()
            .filter(|rule| rule.as_str() != "<local>")
            .cloned()
            .collect::<Vec<_>>()
            .join(",");
        if let Some(http) = &http {
            set("HTTP_PROXY", http.clone());
            set("http_proxy", http.clone());
            // npm, pnpm and yarn read their own config variables.
            set("NPM_CONFIG_PROXY", http.clone());
        }
        if let Some(https) = &https {
            set("HTTPS_PROXY", https.clone());
            set("https_proxy", https.clone());
            set("NPM_CONFIG_HTTPS_PROXY", https.clone());
            // Cargo and pip take one proxy for everything; pip's variable only affects pip.
            set("CARGO_HTTP_PROXY", https.clone());
            set("PIP_PROXY", https.clone());
        }
        if let Some(socks) = &resolved.socks {
            let url = socks.url(credentials);
            set("ALL_PROXY", url.clone());
            set("all_proxy", url);
        }
        set("NO_PROXY", no_proxy.clone());
        set("no_proxy", no_proxy.clone());
        set("NPM_CONFIG_NOPROXY", no_proxy);
    }
    if let Some(go_proxy) = extras.go_proxy.map(str::trim).filter(|v| !v.is_empty()) {
        set("GOPROXY", go_proxy.to_string());
    }
    if let Some(links) = extras.pip_find_links {
        // pip splits PIP_FIND_LINKS on whitespace, so a folder with a space ("OpenMind Studio") must be a file URL.
        set("PIP_FIND_LINKS", file_url(links));
    }
    vars
}

/// `C:\a b\c` -> `file:///C:/a%20b/c` (only letters, digits, `-._~/:` stay as they are).
pub fn file_url(path: &Path) -> String {
    let text = path.display().to_string().replace('\\', "/");
    let mut url = String::from(if text.starts_with('/') {
        "file://"
    } else {
        "file:///"
    });
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~/:".contains(&byte) {
            url.push(byte as char);
        } else {
            url.push_str(&format!("%{byte:02X}"));
        }
    }
    url
}

/// `-c http.proxy=...` arguments for one Git command (Git also honours the environment above; this form is for a
/// single command and writes no configuration).
pub fn git_proxy_args(resolved: &ResolvedProxy, credentials: Option<&Credentials>) -> Vec<String> {
    resolved
        .https
        .as_ref()
        .or(resolved.http.as_ref())
        .map(|url| {
            vec![
                "-c".to_string(),
                format!("http.proxy={}", url.url(credentials)),
            ]
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy::{resolve_manual, ProxySettings};

    fn manual(http: &str) -> ResolvedProxy {
        resolve_manual(&ProxySettings {
            http: http.into(),
            no_proxy: "intranet.lab,<local>".into(),
            ..ProxySettings::default()
        })
    }

    fn get<'a>(vars: &'a [(String, String)], name: &str) -> Option<&'a str> {
        vars.iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    #[test]
    fn a_manual_proxy_sets_the_common_and_tool_variables() {
        let vars = proxy_env(&manual("proxy.lab:3128"), None, &EnvExtras::default());
        for name in [
            "HTTP_PROXY",
            "http_proxy",
            "HTTPS_PROXY",
            "https_proxy",
            "NPM_CONFIG_PROXY",
            "NPM_CONFIG_HTTPS_PROXY",
            "CARGO_HTTP_PROXY",
            "PIP_PROXY",
        ] {
            assert_eq!(get(&vars, name), Some("http://proxy.lab:3128"), "{name}");
        }
        let no_proxy = get(&vars, "NO_PROXY").expect("NO_PROXY");
        assert!(
            no_proxy.contains("intranet.lab")
                && no_proxy.contains("localhost")
                && no_proxy.contains("127.0.0.1")
        );
        assert!(
            !no_proxy.contains("<local>"),
            "tools don't understand <local>"
        );
        assert_eq!(get(&vars, "no_proxy"), Some(no_proxy));
        assert_eq!(get(&vars, "NPM_CONFIG_NOPROXY"), Some(no_proxy));
        assert!(get(&vars, "ALL_PROXY").is_none());
        assert!(
            get(&vars, "GOPROXY").is_none(),
            "GOPROXY only when the user set one"
        );
    }

    #[test]
    fn credentials_go_into_the_process_variables_only() {
        let creds = Credentials {
            username: "ivan".into(),
            password: "pa ss".into(),
        };
        let vars = proxy_env(&manual("p:8080"), Some(&creds), &EnvExtras::default());
        assert_eq!(
            get(&vars, "HTTPS_PROXY"),
            Some("http://ivan:pa%20ss@p:8080")
        );
    }

    #[test]
    fn nothing_is_set_without_a_proxy_but_extras_still_apply() {
        let wheels = std::path::PathBuf::from("C:/OpenMind/cache/offline/wheels");
        let vars = proxy_env(
            &ResolvedProxy::off(),
            None,
            &EnvExtras {
                go_proxy: Some("https://goproxy.lab,direct"),
                pip_find_links: Some(&wheels),
            },
        );
        assert_eq!(get(&vars, "GOPROXY"), Some("https://goproxy.lab,direct"));
        assert!(get(&vars, "PIP_FIND_LINKS")
            .is_some_and(|v| v.starts_with("file://") && !v.contains(' ')));
        assert!(get(&vars, "HTTP_PROXY").is_none());
        assert!(proxy_env(&ResolvedProxy::off(), None, &EnvExtras::default()).is_empty());
    }

    #[test]
    fn socks_goes_to_all_proxy_and_git_gets_a_one_command_flag() {
        let resolved = resolve_manual(&ProxySettings {
            socks: "socks5://s:1080".into(),
            ..ProxySettings::default()
        });
        let vars = proxy_env(&resolved, None, &EnvExtras::default());
        assert_eq!(get(&vars, "ALL_PROXY"), Some("socks5://s:1080"));
        assert_eq!(
            git_proxy_args(&manual("p:8080"), None),
            vec!["-c", "http.proxy=http://p:8080"]
        );
        assert!(git_proxy_args(&ResolvedProxy::off(), None).is_empty());
    }

    #[test]
    fn the_wheel_folder_is_a_file_url_pip_can_read_even_with_spaces() {
        assert_eq!(
            file_url(Path::new(r"C:\omm21\OpenMind Studio\cache\offline\wheels")),
            "file:///C:/omm21/OpenMind%20Studio/cache/offline/wheels"
        );
        assert_eq!(
            file_url(Path::new("/opt/My App/w")),
            "file:///opt/My%20App/w"
        );
        assert_eq!(
            file_url(Path::new(r"D:\Проекты")),
            "file:///D:/%D0%9F%D1%80%D0%BE%D0%B5%D0%BA%D1%82%D1%8B"
        );
    }
}
