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
    /// OpenMind's npm configuration file ([`npm_rc_text`]): the gateway as registry, at npm's *global* level, below the
    /// user's and the project's own `.npmrc`. `None` when it couldn't be written.
    pub npm_rc: Option<PathBuf>,
}

impl Endpoints {
    pub fn base(&self) -> String {
        format!("http://127.0.0.1:{}/{}", self.port, self.token)
    }

    /// `http://<tool>:<token>@127.0.0.1:<port>`: the tunnel for one tool.
    pub fn tunnel(&self, tool: &str) -> String {
        format!("http://{tool}:{}@127.0.0.1:{}", self.token, self.port)
    }
}

/// The text of OpenMind's npm configuration file: the gateway's npm port as the default registry, and this run's token
/// for it (npm and pnpm send it only to that address; the gateway refuses npm requests without it).
pub fn npm_rc_text(endpoints: &Endpoints) -> String {
    format!(
        "; Written by OpenMind Studio for this run. Used only by processes it starts; a project's or your own .npmrc wins.\n\
         registry=http://127.0.0.1:{port}/\n\
         //127.0.0.1:{port}/:_authToken={token}\n",
        port = endpoints.npm_port,
        token = endpoints.token
    )
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

/// npm's own global configuration (`%APPDATA%\\npm\\etc\\npmrc`), which OpenMind's file would take the place of.
fn npm_own_global(inherited: &Inherited) -> Option<String> {
    if inherited.var("NPM_CONFIG_GLOBALCONFIG").is_some() {
        return Some("NPM_CONFIG_GLOBALCONFIG is set".into());
    }
    let file = inherited
        .appdata
        .as_ref()?
        .join("npm")
        .join("etc")
        .join("npmrc");
    let text = read_small(&file)?;
    text.lines()
        .any(|line| !line.trim().is_empty() && !line.trim().starts_with(['#', ';']))
        .then(|| format!("npm's global configuration {} is in use", file.display()))
}

/// A proxy the user set for npm-family tools (`proxy` / `https-proxy` in `~/.npmrc`).
fn npm_own_proxy(inherited: &Inherited) -> Option<String> {
    let file = inherited.home.as_ref()?.join(".npmrc");
    let text = read_small(&file)?;
    has_key(&text, &["proxy", "https-proxy"])
        .map(|_| format!("a proxy is set in {}", file.display()))
}

/// A proxy the user set for Yarn 1 (its variables, `~/.yarnrc` or `~/.npmrc`).
fn yarn_own_proxy(inherited: &Inherited) -> Option<String> {
    for name in [
        "YARN_HTTPS_PROXY",
        "YARN_PROXY",
        "NPM_CONFIG_HTTPS_PROXY",
        "NPM_CONFIG_PROXY",
    ] {
        if inherited.var(name).is_some() {
            return Some(format!("{name} is set"));
        }
    }
    if let Some(file) = inherited.home.as_ref().map(|home| home.join(".yarnrc")) {
        if let Some(text) = read_small(&file) {
            let set = text.lines().any(|line| {
                let key = line.trim().split([' ', '\t']).next().unwrap_or_default();
                matches!(
                    key,
                    "proxy" | "https-proxy" | "\"proxy\"" | "\"https-proxy\""
                )
            });
            if set {
                return Some(format!("a proxy is set in {}", file.display()));
            }
        }
    }
    npm_own_proxy(inherited)
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
    let mut skip = |tool: &'static str, reason: String| skipped.push(Skipped { tool, reason });
    match pip_own_index(inherited) {
        Some(reason) => skip("pip", reason),
        None => set("PIP_INDEX_URL", format!("{base}/pypi/simple/")),
    }
    // npm: OpenMind's file at the *global* level, so a project's or the user's own registry always wins (npm's own
    // precedence). pnpm doesn't read that level: it gets the same file as its user configuration when the user has no
    // `~/.npmrc` of their own (a project `.npmrc` still wins), otherwise the tunnel as its own https proxy.
    let own_registry = npm_own_registry(inherited);
    let user_npmrc = inherited
        .home
        .as_ref()
        .is_some_and(|home| home.join(".npmrc").is_file());
    match (&own_registry, npm_own_global(inherited), &endpoints.npm_rc) {
        (Some(reason), _, _) => skip("npm", reason.clone()),
        (None, Some(reason), _) => skip("npm", reason),
        (None, None, None) => skip(
            "npm",
            "OpenMind's npm configuration could not be written".into(),
        ),
        (None, None, Some(rc)) => set("NPM_CONFIG_GLOBALCONFIG", rc.display().to_string()),
    }
    let pnpm_own = [
        "PNPM_CONFIG_REGISTRY",
        "PNPM_CONFIG_HTTPS_PROXY",
        "NPM_CONFIG_USERCONFIG",
    ]
    .iter()
    .find(|name| inherited.var(name).is_some())
    .map(|name| format!("{name} is set"));
    match (pnpm_own, &own_registry, &endpoints.npm_rc) {
        (Some(reason), _, _) => skip("pnpm", reason),
        (None, Some(reason), _) => skip("pnpm", reason.clone()),
        (None, None, Some(rc)) if !user_npmrc => {
            set("NPM_CONFIG_USERCONFIG", rc.display().to_string())
        }
        (None, None, _) => match npm_own_proxy(inherited) {
            Some(reason) => skip("pnpm", reason),
            None => set("PNPM_CONFIG_HTTPS_PROXY", endpoints.tunnel("pnpm")),
        },
    }
    // Yarn 1: its own https-proxy variable, the tunnel; its registry, yarn.lock and credentials stay its own.
    match yarn_own_proxy(inherited) {
        Some(reason) => skip("yarn", reason),
        None => set("YARN_HTTPS_PROXY", endpoints.tunnel("yarn")),
    }
    match go_own_proxy(inherited) {
        Some(reason) => skip("go", reason),
        None => set("GOPROXY", format!("{base}/go")),
    }
    match cargo_own_route(inherited) {
        Some(reason) => skip("cargo", reason),
        None => set("CARGO_HTTP_PROXY", endpoints.tunnel("cargo")),
    }
    // rustup: its distribution server through the gateway (rustup checks every file's SHA-256 against its manifest).
    match ["RUSTUP_DIST_SERVER", "RUSTUP_UPDATE_ROOT"]
        .iter()
        .find(|name| inherited.var(name).is_some())
    {
        Some(name) => skip("rustup", format!("{name} is set")),
        None => {
            set("RUSTUP_DIST_SERVER", format!("{base}/rustup"));
            set("RUSTUP_UPDATE_ROOT", format!("{base}/rustup/rustup"));
        }
    }
    set("OPENMIND_COMPOSER_PROXY", endpoints.tunnel("composer"));
    set("OPENMIND_FETCH_URL", format!("{base}/fetch"));

    // Git: clone, fetch, pull and push through the gateway (which signs in with the user's credential helper for the
    // real host); the gateway itself never through another proxy. SSH remotes are untouched (Git's own ssh).
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

/// OpenMind's own launchers in `<app>/shims` (first on the PATH of processes OpenMind starts):
/// - `openmind-fetch` (cmd/PowerShell and Git Bash) asks the gateway through `curl` (Windows' own, or Git's); the
///   download itself is made by the broker;
/// - `composer` runs the Composer that comes next on PATH (`OPENMIND_REAL_COMPOSER`: OpenMind's portable one or a system
///   Composer) with `HTTPS_PROXY` set to the gateway's tunnel for Composer's own process only (`setlocal`), so any
///   Composer reaches the network the way OpenMind does while its TLS, `auth.json`, repositories and `composer.lock` stay
///   its own.
pub fn launchers() -> [(&'static str, &'static str); 4] {
    [
        (
            "openmind-fetch.cmd",
            "@echo off\r\nsetlocal\r\nif not defined OPENMIND_FETCH_URL (\r\n  echo openmind-fetch: run this in an OpenMind Studio terminal.>&2\r\n  exit /b 1\r\n)\r\nif \"%~1\"==\"\" (\r\n  echo usage: openmind-fetch ^<https-url^> [output-file] [sha256]>&2\r\n  exit /b 2\r\n)\r\nset \"OM_CURL=%SystemRoot%\\System32\\curl.exe\"\r\nif \"%~3\"==\"\" (set \"OM_SHA=\") else (set \"OM_SHA=--data-urlencode sha256=%~3\")\r\nif \"%~2\"==\"\" (\r\n  \"%OM_CURL%\" -fSL --get --data-urlencode \"url=%~1\" %OM_SHA% -OJ \"%OPENMIND_FETCH_URL%\"\r\n) else (\r\n  \"%OM_CURL%\" -fSL --get --data-urlencode \"url=%~1\" %OM_SHA% -o \"%~2\" \"%OPENMIND_FETCH_URL%\"\r\n)\r\n",
        ),
        (
            "openmind-fetch",
            "#!/bin/sh\n[ -n \"$OPENMIND_FETCH_URL\" ] || { echo \"openmind-fetch: run this in an OpenMind Studio terminal.\" >&2; exit 1; }\n[ -n \"$1\" ] || { echo \"usage: openmind-fetch <https-url> [output-file] [sha256]\" >&2; exit 2; }\nif [ -n \"$3\" ]; then\n  if [ -n \"$2\" ]; then exec curl -fSL --get --data-urlencode \"url=$1\" --data-urlencode \"sha256=$3\" -o \"$2\" \"$OPENMIND_FETCH_URL\"; fi\n  exec curl -fSL --get --data-urlencode \"url=$1\" --data-urlencode \"sha256=$3\" -OJ \"$OPENMIND_FETCH_URL\"\nfi\nif [ -n \"$2\" ]; then exec curl -fSL --get --data-urlencode \"url=$1\" -o \"$2\" \"$OPENMIND_FETCH_URL\"; fi\nexec curl -fSL --get --data-urlencode \"url=$1\" -OJ \"$OPENMIND_FETCH_URL\"\n",
        ),
        (
            "composer.cmd",
            "@echo off\r\nsetlocal\r\nif not defined OPENMIND_REAL_COMPOSER (\r\n  echo composer: Composer is not installed. Install OpenMind's portable Composer in the Runtime Manager, or Composer from getcomposer.org.>&2\r\n  exit /b 1\r\n)\r\nif defined OPENMIND_COMPOSER_PROXY set \"HTTPS_PROXY=%OPENMIND_COMPOSER_PROXY%\"\r\n\"%OPENMIND_REAL_COMPOSER%\" %*\r\n",
        ),
        (
            "composer",
            "#!/bin/sh\nreal=\"${OPENMIND_REAL_COMPOSER_SH:-$OPENMIND_REAL_COMPOSER}\"\n[ -n \"$real\" ] || { echo \"composer: Composer is not installed. Install OpenMind's portable Composer in the Runtime Manager, or Composer from getcomposer.org.\" >&2; exit 1; }\n[ -n \"$OPENMIND_COMPOSER_PROXY\" ] && export HTTPS_PROXY=\"$OPENMIND_COMPOSER_PROXY\"\nexec \"$real\" \"$@\"\n",
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
            npm_rc: Some(PathBuf::from("C:/app/temp/config/npmrc")),
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
        // npm and pnpm read OpenMind's file at a level below the project's and user's own .npmrc; no registry
        // variable (it would beat a project's .npmrc).
        assert_eq!(
            get(&env, "NPM_CONFIG_GLOBALCONFIG"),
            Some("C:/app/temp/config/npmrc")
        );
        assert_eq!(
            get(&env, "NPM_CONFIG_USERCONFIG"),
            Some("C:/app/temp/config/npmrc")
        );
        assert_eq!(get(&env, "NPM_CONFIG_REGISTRY"), None);
        assert_eq!(get(&env, "PNPM_CONFIG_REGISTRY"), None);
        assert_eq!(
            get(&env, "YARN_HTTPS_PROXY"),
            Some("http://yarn:t0k@127.0.0.1:4000")
        );
        assert_eq!(
            get(&env, "YARN_REGISTRY"),
            None,
            "Yarn keeps its registry and yarn.lock"
        );
        assert_eq!(
            get(&env, "RUSTUP_DIST_SERVER"),
            Some("http://127.0.0.1:4000/t0k/rustup")
        );
        assert_eq!(
            get(&env, "RUSTUP_UPDATE_ROOT"),
            Some("http://127.0.0.1:4000/t0k/rustup/rustup")
        );
        assert_eq!(get(&env, "GOPROXY"), Some("http://127.0.0.1:4000/t0k/go"));
        assert_eq!(
            get(&env, "CARGO_HTTP_PROXY"),
            Some("http://cargo:t0k@127.0.0.1:4000")
        );
        assert_eq!(get(&env, "NO_PROXY"), Some("127.0.0.1,localhost"));
        assert_eq!(get(&env, "GIT_CONFIG_COUNT"), Some("2"));
        assert_eq!(
            get(&env, "GIT_CONFIG_KEY_0"),
            Some("url.http://127.0.0.1:4000/t0k/git/https/.insteadOf")
        );
        assert_eq!(
            get(&env, "GIT_CONFIG_KEY_1"),
            Some("http.http://127.0.0.1:4000/.proxy")
        );
        assert_eq!(get(&env, "GIT_CONFIG_VALUE_1"), Some(""));
        assert!(
            env.vars.iter().all(|(_, v)| !v.contains("pushInsteadOf")),
            "pushes go through the gateway too"
        );
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
        assert_eq!(get(&env, "GIT_CONFIG_COUNT"), Some("4"));
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
        // A scoped registry alone is not the default registry: npm still uses the gateway; the user's ~/.npmrc
        // exists, so pnpm doesn't get OpenMind's file as its user configuration but the tunnel.
        assert!(get(&env, "NPM_CONFIG_GLOBALCONFIG").is_some());
        assert_eq!(
            get(&env, "NPM_CONFIG_USERCONFIG"),
            None,
            "the user's own ~/.npmrc is never replaced"
        );
        assert_eq!(
            get(&env, "PNPM_CONFIG_HTTPS_PROXY"),
            Some("http://pnpm:t0k@127.0.0.1:4000")
        );
        let mut inherited = inherited;
        inherited
            .vars
            .insert("NPM_CONFIG_REGISTRY".into(), "https://npm.uni/".into());
        let env = process_env(&endpoints(), &inherited);
        let tools: Vec<&str> = env.skipped.iter().map(|s| s.tool).collect();
        assert!(
            tools.contains(&"npm") && tools.contains(&"pnpm"),
            "{tools:?}"
        );
        assert_eq!(get(&env, "NPM_CONFIG_GLOBALCONFIG"), None);
        assert_eq!(get(&env, "PNPM_CONFIG_HTTPS_PROXY"), None);
    }

    #[test]
    fn a_proxy_the_user_set_for_yarn_or_npm_and_their_own_rustup_server_are_kept() {
        let tmp = tempfile::tempdir().expect("tmp");
        let home = tmp.path().join("home");
        fs::create_dir_all(&home).expect("dir");
        fs::write(
            home.join(".yarnrc"),
            "https-proxy \"http://proxy.uni:8080\"\n",
        )
        .expect("yarnrc");
        let mut inherited = Inherited {
            vars: HashMap::new(),
            home: Some(home.clone()),
            appdata: None,
            program_data: None,
        };
        inherited.vars.insert(
            "RUSTUP_DIST_SERVER".into(),
            "https://mirror.uni/rust".into(),
        );
        let env = process_env(&endpoints(), &inherited);
        assert_eq!(get(&env, "YARN_HTTPS_PROXY"), None);
        assert_eq!(get(&env, "RUSTUP_DIST_SERVER"), None);
        let tools: Vec<&str> = env.skipped.iter().map(|s| s.tool).collect();
        assert!(
            tools.contains(&"yarn") && tools.contains(&"rustup"),
            "{tools:?}"
        );
        // A proxy in ~/.npmrc keeps pnpm (and Yarn, which reads it) on it.
        fs::remove_file(home.join(".yarnrc")).expect("rm");
        fs::write(home.join(".npmrc"), "https-proxy=http://proxy.uni:8080\n").expect("npmrc");
        let env = process_env(
            &endpoints(),
            &Inherited {
                vars: HashMap::new(),
                ..inherited
            },
        );
        assert_eq!(get(&env, "PNPM_CONFIG_HTTPS_PROXY"), None);
        assert_eq!(get(&env, "YARN_HTTPS_PROXY"), None);
    }

    #[test]
    fn npms_own_global_configuration_is_never_hidden() {
        let tmp = tempfile::tempdir().expect("tmp");
        let appdata = tmp.path().join("AppData");
        fs::create_dir_all(appdata.join("npm").join("etc")).expect("dir");
        fs::write(
            appdata.join("npm").join("etc").join("npmrc"),
            "cafile=C:/corp.pem\n",
        )
        .expect("npmrc");
        let inherited = Inherited {
            vars: HashMap::new(),
            home: None,
            appdata: Some(appdata),
            program_data: None,
        };
        let env = process_env(&endpoints(), &inherited);
        assert_eq!(get(&env, "NPM_CONFIG_GLOBALCONFIG"), None);
        assert!(env.skipped.iter().any(|s| s.tool == "npm"));
    }

    #[test]
    fn the_npm_file_names_the_gateway_and_its_token_only() {
        let text = npm_rc_text(&endpoints());
        assert!(text.contains("registry=http://127.0.0.1:4001/\n"));
        assert!(text.contains("//127.0.0.1:4001/:_authToken=t0k\n"));
        assert!(!text.contains("registry.npmjs.org"));
    }

    #[test]
    fn the_launchers_never_disable_certificate_checks_and_scope_the_proxy_to_composer() {
        for (name, text) in launchers() {
            assert!(
                !text.contains("-k ")
                    && !text.contains("--insecure")
                    && !text.contains("disable-tls"),
                "{name}"
            );
            if name.starts_with("openmind-fetch") {
                assert!(text.contains("--data-urlencode \"url="), "{name}");
            }
        }
        let (_, cmd) = launchers()[2];
        assert!(
            cmd.starts_with("@echo off\r\nsetlocal\r\n"),
            "the proxy never leaks into the calling shell"
        );
        assert!(cmd.contains("\"%OPENMIND_REAL_COMPOSER%\" %*"));
    }
}
