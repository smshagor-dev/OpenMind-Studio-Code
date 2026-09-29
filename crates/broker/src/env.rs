//! The process-local settings that point a tool at the gateway. They go only into the environment of a process OpenMind
//! starts (a terminal, a task, Run Code, Git, a language-server install); no file of any tool is written, and nothing
//! changes for programs started elsewhere. A tool the user already pointed somewhere themselves (their own index,
//! registry, module proxy or Cargo proxy — in the environment or the tool's own configuration file) is left alone and
//! reported.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Where the gateway listens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoints {
    pub port: u16,
    pub npm_port: u16,
    pub token: String,
}

impl Endpoints {
    pub fn base(&self) -> String {
        format!("http://127.0.0.1:{}/{}", self.port, self.token)
    }
}

/// What the process would inherit, and where the user's own tool configuration lives.
#[derive(Debug, Clone, Default)]
pub struct Inherited {
    /// Environment variables, keys upper-cased (Windows names are case-insensitive).
    pub vars: HashMap<String, String>,
    /// `%USERPROFILE%`
    pub home: Option<PathBuf>,
    /// `%APPDATA%`
    pub appdata: Option<PathBuf>,
    /// `%ProgramData%`
    pub program_data: Option<PathBuf>,
}

impl Inherited {
    /// The current process's environment and folders.
    pub fn current() -> Self {
        let vars: HashMap<String, String> = std::env::vars()
            .map(|(k, v)| (k.to_ascii_uppercase(), v))
            .collect();
        let path = |name: &str| vars.get(name).filter(|v| !v.is_empty()).map(PathBuf::from);
        Inherited {
            home: path("USERPROFILE").or_else(|| path("HOME")),
            appdata: path("APPDATA"),
            program_data: path("PROGRAMDATA"),
            vars,
        }
    }

    fn var(&self, name: &str) -> Option<&str> {
        self.vars
            .get(&name.to_ascii_uppercase())
            .map(String::as_str)
            .filter(|v| !v.trim().is_empty())
    }
}

/// A tool left on its own configuration, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub tool: &'static str,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessEnv {
    pub vars: Vec<(String, String)>,
    pub skipped: Vec<Skipped>,
}

/// Reads a small text file (the tools' own configuration); a missing or huge file reads as nothing.
fn read_small(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > 256 * 1024 {
        return None;
    }
    fs::read_to_string(path).ok()
}

/// `key = value` / `key=value` lines of an ini or rc file whose key is one of `keys` (comments ignored).
fn has_key(text: &str, keys: &[&str]) -> Option<String> {
    text.lines().find_map(|line| {
        let line = line.trim();
        if line.starts_with(['#', ';']) {
            return None;
        }
        let (key, value) = line.split_once('=')?;
        let key = key.trim().to_ascii_lowercase();
        keys.contains(&key.as_str())
            .then(|| value.trim().trim_matches('"').to_string())
    })
}

fn pip_own_index(inherited: &Inherited) -> Option<String> {
    if inherited.var("PIP_INDEX_URL").is_some() {
        return Some("PIP_INDEX_URL is set".into());
    }
    let mut files = Vec::new();
    if let Some(file) = inherited.var("PIP_CONFIG_FILE") {
        if !file.eq_ignore_ascii_case("nul") && file != "/dev/null" {
            files.push(PathBuf::from(file));
        }
    }
    if let Some(appdata) = &inherited.appdata {
        files.push(appdata.join("pip").join("pip.ini"));
    }
    if let Some(home) = &inherited.home {
        files.push(home.join("pip").join("pip.ini"));
    }
    if let Some(data) = &inherited.program_data {
        files.push(data.join("pip").join("pip.ini"));
    }
    files.into_iter().find_map(|file| {
        let text = read_small(&file)?;
        has_key(&text, &["index-url", "index_url"])
            .map(|_| format!("index-url is set in {}", file.display()))
    })
}

fn npm_own_registry(inherited: &Inherited) -> Option<String> {
    if inherited.var("NPM_CONFIG_REGISTRY").is_some() {
        return Some("NPM_CONFIG_REGISTRY is set".into());
    }
    let file = inherited.home.as_ref()?.join(".npmrc");
    let text = read_small(&file)?;
    has_key(&text, &["registry"]).map(|_| format!("registry is set in {}", file.display()))
}

fn go_own_proxy(inherited: &Inherited) -> Option<String> {
    if inherited.var("GOPROXY").is_some() {
        return Some("GOPROXY is set".into());
    }
    let file = inherited.appdata.as_ref()?.join("go").join("env");
    let text = read_small(&file)?;
    has_key(&text, &["goproxy"]).map(|_| format!("GOPROXY is set in {}", file.display()))
}

fn cargo_own_route(inherited: &Inherited) -> Option<String> {
    if inherited.var("CARGO_HTTP_PROXY").is_some() {
        return Some("CARGO_HTTP_PROXY is set".into());
    }
    let home = inherited
        .var("CARGO_HOME")
        .map(PathBuf::from)
        .or_else(|| inherited.home.as_ref().map(|home| home.join(".cargo")))?;
    ["config.toml", "config"].iter().find_map(|name| {
        let file = home.join(name);
        let text = read_small(&file)?;
        let proxy = text.contains("[http]") && has_key(&text, &["proxy"]).is_some();
        let mirror = has_key(&text, &["replace-with"]).is_some();
        (proxy || mirror)
            .then(|| format!("a proxy or registry mirror is set in {}", file.display()))
    })
}

/// The settings for one process OpenMind starts.
pub fn process_env(endpoints: &Endpoints, inherited: &Inherited) -> ProcessEnv {
    let base = endpoints.base();
    let mut env = ProcessEnv::default();
    let mut set = |name: &str, value: String| env.vars.push((name.to_string(), value));

    // Requests to the gateway itself never go through a proxy the user set for other programs.
    let no_proxy = inherited
        .var("NO_PROXY")
        .map(|value| format!("{value},127.0.0.1,localhost"))
        .unwrap_or_else(|| "127.0.0.1,localhost".to_string());
    set("NO_PROXY", no_proxy);

    let mut skipped = Vec::new();
    match pip_own_index(inherited) {
        Some(reason) => skipped.push(Skipped {
            tool: "pip",
            reason,
        }),
        None => set("PIP_INDEX_URL", format!("{base}/pypi/simple/")),
    }
    match npm_own_registry(inherited) {
        Some(reason) => skipped.push(Skipped {
            tool: "npm",
            reason,
        }),
        None => {
            let registry = format!("http://127.0.0.1:{}/", endpoints.npm_port);
            set("NPM_CONFIG_REGISTRY", registry.clone());
            if inherited.var("PNPM_CONFIG_REGISTRY").is_none() {
                set("PNPM_CONFIG_REGISTRY", registry);
            }
        }
    }
    match go_own_proxy(inherited) {
        Some(reason) => skipped.push(Skipped { tool: "go", reason }),
        None => set("GOPROXY", format!("{base}/go")),
    }
    match cargo_own_route(inherited) {
        Some(reason) => skipped.push(Skipped {
            tool: "cargo",
            reason,
        }),
        None => set(
            "CARGO_HTTP_PROXY",
            format!(
                "http://cargo:{}@127.0.0.1:{}",
                endpoints.token, endpoints.port
            ),
        ),
    }
    set(
        "OPENMIND_COMPOSER_PROXY",
        format!(
            "http://composer:{}@127.0.0.1:{}",
            endpoints.token, endpoints.port
        ),
    );
    set("OPENMIND_FETCH_URL", format!("{base}/fetch"));

    // Git: fetches through the gateway, pushes on Git's own connection, the gateway never through another proxy.
    let first: usize = inherited
        .var("GIT_CONFIG_COUNT")
        .and_then(|count| count.trim().parse().ok())
        .unwrap_or(0);
    let git = [
        (
            format!("url.{base}/git/https/.insteadOf"),
            "https://".to_string(),
        ),
        (
            "url.https://.pushInsteadOf".to_string(),
            "https://".to_string(),
        ),
        (
            format!("http.http://127.0.0.1:{}/.proxy", endpoints.port),
            String::new(),
        ),
    ];
    for (offset, (key, value)) in git.iter().enumerate() {
        set(&format!("GIT_CONFIG_KEY_{}", first + offset), key.clone());
        set(
            &format!("GIT_CONFIG_VALUE_{}", first + offset),
            value.clone(),
        );
    }
    set("GIT_CONFIG_COUNT", (first + git.len()).to_string());
    env.skipped = skipped;
    env
}

/// The `openmind-fetch` launchers (cmd/PowerShell and Git Bash), written into OpenMind's own shim folder. They ask the
/// gateway through `curl` (Windows' own, or Git's) — the download itself is made by the broker.
pub fn fetch_shims() -> [(&'static str, &'static str); 2] {
    [
        (
            "openmind-fetch.cmd",
            "@echo off\r\nsetlocal\r\nif not defined OPENMIND_FETCH_URL (\r\n  echo openmind-fetch: run this in an OpenMind Studio terminal.>&2\r\n  exit /b 1\r\n)\r\nif \"%~1\"==\"\" (\r\n  echo usage: openmind-fetch ^<https-url^> [output-file] [sha256]>&2\r\n  exit /b 2\r\n)\r\nset \"OM_CURL=%SystemRoot%\\System32\\curl.exe\"\r\nif \"%~3\"==\"\" (set \"OM_SHA=\") else (set \"OM_SHA=--data-urlencode sha256=%~3\")\r\nif \"%~2\"==\"\" (\r\n  \"%OM_CURL%\" -fSL --get --data-urlencode \"url=%~1\" %OM_SHA% -OJ \"%OPENMIND_FETCH_URL%\"\r\n) else (\r\n  \"%OM_CURL%\" -fSL --get --data-urlencode \"url=%~1\" %OM_SHA% -o \"%~2\" \"%OPENMIND_FETCH_URL%\"\r\n)\r\n",
        ),
        (
            "openmind-fetch",
            "#!/bin/sh\n[ -n \"$OPENMIND_FETCH_URL\" ] || { echo \"openmind-fetch: run this in an OpenMind Studio terminal.\" >&2; exit 1; }\n[ -n \"$1\" ] || { echo \"usage: openmind-fetch <https-url> [output-file] [sha256]\" >&2; exit 2; }\nif [ -n \"$3\" ]; then\n  if [ -n \"$2\" ]; then exec curl -fSL --get --data-urlencode \"url=$1\" --data-urlencode \"sha256=$3\" -o \"$2\" \"$OPENMIND_FETCH_URL\"; fi\n  exec curl -fSL --get --data-urlencode \"url=$1\" --data-urlencode \"sha256=$3\" -OJ \"$OPENMIND_FETCH_URL\"\nfi\nif [ -n \"$2\" ]; then exec curl -fSL --get --data-urlencode \"url=$1\" -o \"$2\" \"$OPENMIND_FETCH_URL\"; fi\nexec curl -fSL --get --data-urlencode \"url=$1\" -OJ \"$OPENMIND_FETCH_URL\"\n",
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoints() -> Endpoints {
        Endpoints {
            port: 4000,
            npm_port: 4001,
            token: "t0k".into(),
        }
    }

    fn get<'a>(env: &'a ProcessEnv, name: &str) -> Option<&'a str> {
        env.vars
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    #[test]
    fn every_tool_is_pointed_at_the_gateway_by_default() {
        let env = process_env(&endpoints(), &Inherited::default());
        assert_eq!(
            get(&env, "PIP_INDEX_URL"),
            Some("http://127.0.0.1:4000/t0k/pypi/simple/")
        );
        assert_eq!(
            get(&env, "NPM_CONFIG_REGISTRY"),
            Some("http://127.0.0.1:4001/")
        );
        assert_eq!(
            get(&env, "PNPM_CONFIG_REGISTRY"),
            Some("http://127.0.0.1:4001/")
        );
        assert_eq!(get(&env, "GOPROXY"), Some("http://127.0.0.1:4000/t0k/go"));
        assert_eq!(
            get(&env, "CARGO_HTTP_PROXY"),
            Some("http://cargo:t0k@127.0.0.1:4000")
        );
        assert_eq!(get(&env, "NO_PROXY"), Some("127.0.0.1,localhost"));
        assert_eq!(get(&env, "GIT_CONFIG_COUNT"), Some("3"));
        assert_eq!(
            get(&env, "GIT_CONFIG_KEY_0"),
            Some("url.http://127.0.0.1:4000/t0k/git/https/.insteadOf")
        );
        assert_eq!(
            get(&env, "GIT_CONFIG_KEY_1"),
            Some("url.https://.pushInsteadOf")
        );
        assert_eq!(
            get(&env, "GIT_CONFIG_KEY_2"),
            Some("http.http://127.0.0.1:4000/.proxy")
        );
        assert_eq!(get(&env, "GIT_CONFIG_VALUE_2"), Some(""));
        assert!(env.skipped.is_empty());
        // The old blanket proxy variables are gone: user code is never routed.
        for old in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "PIP_PROXY",
            "NPM_CONFIG_PROXY",
            "NPM_CONFIG_HTTPS_PROXY",
        ] {
            assert_eq!(get(&env, old), None, "{old}");
        }
    }

    #[test]
    fn existing_git_config_entries_and_no_proxy_are_kept() {
        let mut inherited = Inherited::default();
        inherited.vars.insert("GIT_CONFIG_COUNT".into(), "2".into());
        inherited.vars.insert("NO_PROXY".into(), ".corp".into());
        let env = process_env(&endpoints(), &inherited);
        assert_eq!(get(&env, "GIT_CONFIG_COUNT"), Some("5"));
        assert!(get(&env, "GIT_CONFIG_KEY_2").is_some_and(|k| k.ends_with(".insteadOf")));
        assert_eq!(
            get(&env, "GIT_CONFIG_KEY_0"),
            None,
            "the user's own entries are untouched"
        );
        assert_eq!(get(&env, "NO_PROXY"), Some(".corp,127.0.0.1,localhost"));
    }

    #[test]
    fn a_tool_the_user_configured_is_left_alone_and_reported() {
        let tmp = tempfile::tempdir().expect("tmp");
        let appdata = tmp.path().join("AppData");
        let home = tmp.path().join("home");
        fs::create_dir_all(appdata.join("pip")).expect("dir");
        fs::create_dir_all(appdata.join("go")).expect("dir");
        fs::create_dir_all(home.join(".cargo")).expect("dir");
        fs::write(
            appdata.join("pip").join("pip.ini"),
            "[global]\nindex-url = https://mirror.uni/simple\n",
        )
        .expect("pip");
        fs::write(home.join(".npmrc"), "@acme:registry=https://npm.acme\n").expect("npmrc");
        fs::write(
            appdata.join("go").join("env"),
            "GOPROXY=https://goproxy.uni\n",
        )
        .expect("go");
        fs::write(
            home.join(".cargo").join("config.toml"),
            "[http]\nproxy = \"proxy.uni:8080\"\n",
        )
        .expect("cargo");
        let inherited = Inherited {
            vars: HashMap::new(),
            home: Some(home),
            appdata: Some(appdata),
            program_data: None,
        };
        let env = process_env(&endpoints(), &inherited);
        let tools: Vec<&str> = env.skipped.iter().map(|s| s.tool).collect();
        assert_eq!(tools, vec!["pip", "go", "cargo"]);
        assert_eq!(get(&env, "PIP_INDEX_URL"), None);
        assert_eq!(get(&env, "GOPROXY"), None);
        assert_eq!(get(&env, "CARGO_HTTP_PROXY"), None);
        // A scoped registry alone is not the default registry: npm still uses the gateway.
        assert!(get(&env, "NPM_CONFIG_REGISTRY").is_some());
        let mut inherited = inherited;
        inherited
            .vars
            .insert("NPM_CONFIG_REGISTRY".into(), "https://npm.uni/".into());
        let env = process_env(&endpoints(), &inherited);
        assert!(env.skipped.iter().any(|s| s.tool == "npm"));
        assert_eq!(get(&env, "NPM_CONFIG_REGISTRY"), None);
    }

    #[test]
    fn the_fetch_launchers_never_disable_certificate_checks() {
        for (name, text) in fetch_shims() {
            assert!(
                !text.contains("-k ") && !text.contains("--insecure"),
                "{name}"
            );
            assert!(text.contains("--data-urlencode \"url="), "{name}");
        }
    }
}
