//! Network diagnostics for a computer where package downloads fail (a university network): one JSON file,
//! `logs/openmind-network-diagnostics.json`, written only when the user asks. It compares the ways a package can be
//! fetched — A the Download Manager's own route, B-E pip / npm / Composer / Git through OpenMind's gateway (the
//! environment an OpenMind terminal gets), F the same tools as an ordinary PowerShell would run them — for the hosts
//! the tools need, with DNS and plain TCP results. Nothing secret is written: proxy passwords, the gateway token and
//! credentials in any tool output are removed, and only the names of the user's proxy variables are listed.

use std::io::Read;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use openmind_network::http::HttpProxy;
use openmind_network::probe::test_connection;
use openmind_network::problem::diagnose;
use openmind_network::redact::redact;
use serde_json::{json, Value};
use tauri::State;

use crate::app_state::AppState;

/// The hosts package tools need, with an address to test through OpenMind's own route.
const HOSTS: &[(&str, &str)] = &[
    ("pypi.org", "https://pypi.org/simple/six/"),
    ("files.pythonhosted.org", "https://files.pythonhosted.org/"),
    ("registry.npmjs.org", "https://registry.npmjs.org/left-pad"),
    (
        "github.com",
        "https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack",
    ),
    (
        "proxy.golang.org",
        "https://proxy.golang.org/golang.org/x/text/@v/list",
    ),
    ("sum.golang.org", "https://sum.golang.org/latest"),
    ("index.crates.io", "https://index.crates.io/config.json"),
    (
        "static.crates.io",
        "https://static.crates.io/crates/itoa/itoa-1.0.18.crate",
    ),
    (
        "repo.packagist.org",
        "https://repo.packagist.org/packages.json",
    ),
    ("nodejs.org", "https://nodejs.org/dist/index.json"),
];

const TOOL_TIMEOUT: Duration = Duration::from_secs(90);

/// Removes everything secret from a text before it is written.
struct Scrub {
    credentials: Option<openmind_network::proxy::Credentials>,
    token: Option<String>,
}

impl Scrub {
    fn text(&self, text: &str) -> String {
        let mut out = redact(text, self.credentials.as_ref());
        if let Some(token) = self.token.as_deref().filter(|t| !t.is_empty()) {
            out = out.replace(token, "****");
        }
        out
    }

    /// The last lines of a tool's output, cleaned and bounded.
    fn tail(&self, text: &str) -> String {
        let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        let start = lines.len().saturating_sub(12);
        let joined = lines[start..].join("\n");
        let clean = self.text(&joined);
        clean.chars().take(1500).collect()
    }
}

/// The first `name` in `dirs` (with Windows' program extensions).
fn find(name: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    let extensions: &[&str] = if cfg!(windows) {
        &["exe", "cmd", "bat"]
    } else {
        &[""]
    };
    dirs.iter().find_map(|dir| {
        extensions.iter().find_map(|ext| {
            let file = if ext.is_empty() {
                dir.join(name)
            } else {
                dir.join(format!("{name}.{ext}"))
            };
            file.is_file().then_some(file)
        })
    })
}

fn inherited_path() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default()
}

/// One tool run: exit code, time, the network category of its output, and its last lines.
fn run_tool(
    program: &Path,
    args: &[&str],
    cwd: &Path,
    path: &[PathBuf],
    env: &[(String, String)],
    scrub: &Scrub,
) -> Value {
    let started = Instant::now();
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Ok(joined) = std::env::join_paths(path) {
        command.env("PATH", joined);
    }
    command.envs(env.iter().cloned());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => return json!({ "ran": false, "error": scrub.text(&err.to_string()) }),
    };
    let readers: Vec<_> = [
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    .map(|mut pipe| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = pipe.read_to_end(&mut bytes);
            String::from_utf8_lossy(&bytes).into_owned()
        })
    })
    .collect();
    let deadline = Instant::now() + TOOL_TIMEOUT;
    let (code, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (status.code(), false),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break (None, true);
            }
        }
    };
    let output: String = readers
        .into_iter()
        .filter_map(|reader| reader.join().ok())
        .collect::<Vec<_>>()
        .join("\n");
    json!({
        "ran": true,
        "exitCode": code,
        "timedOut": timed_out,
        "ok": code == Some(0) && !timed_out,
        "elapsedMs": started.elapsed().as_millis() as u64,
        "problem": diagnose(&output),
        "output": scrub.tail(&output),
    })
}

fn dns_and_tcp(host: &str) -> Value {
    let started = Instant::now();
    let addresses: Vec<std::net::SocketAddr> = match (host, 443).to_socket_addrs() {
        Ok(found) => found.collect(),
        Err(err) => {
            return json!({ "dns": { "ok": false, "error": err.to_string() }, "tcp443": null });
        }
    };
    let dns_ms = started.elapsed().as_millis() as u64;
    let ipv6 = addresses.iter().filter(|a| a.is_ipv6()).count();
    let tcp = addresses.iter().find(|a| a.is_ipv4()).or(addresses.first()).map(|address| {
        let started = Instant::now();
        match TcpStream::connect_timeout(address, Duration::from_secs(5)) {
            Ok(_) => json!({ "ok": true, "address": address.to_string(), "elapsedMs": started.elapsed().as_millis() as u64 }),
            Err(err) => json!({ "ok": false, "address": address.to_string(), "error": err.to_string() }),
        }
    });
    json!({
        "dns": { "ok": true, "addresses": addresses.len(), "ipv6": ipv6, "elapsedMs": dns_ms },
        "tcp443Direct": tcp,
    })
}

/// The proxy-related variables Windows gave OpenMind: names and hosts only.
fn inherited_proxy_vars(scrub: &Scrub) -> Value {
    let names = [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "PIP_INDEX_URL",
        "PIP_PROXY",
        "PIP_CONFIG_FILE",
        "NPM_CONFIG_REGISTRY",
        "NPM_CONFIG_PROXY",
        "NPM_CONFIG_HTTPS_PROXY",
        "GOPROXY",
        "CARGO_HTTP_PROXY",
        "GIT_SSL_NO_VERIFY",
        "SSL_CERT_FILE",
        "REQUESTS_CA_BUNDLE",
        "NODE_EXTRA_CA_CERTS",
    ];
    let found: Vec<Value> = names
        .iter()
        .filter_map(|name| {
            std::env::var(name).ok().map(|value| {
                // An address: keep scheme and host, drop user info and path.
                let host = value
                    .split("://")
                    .last()
                    .unwrap_or_default()
                    .rsplit('@')
                    .next()
                    .unwrap_or_default()
                    .split('/')
                    .next()
                    .unwrap_or_default()
                    .to_string();
                json!({ "name": name, "value": if name.contains("PROXY") || name.contains("URL") { scrub.text(&host) } else { "(set)".to_string() } })
            })
        })
        .collect();
    Value::Array(found)
}

/// Writes `logs/openmind-network-diagnostics.json` and returns its path. Runs the tools, so it takes up to a few minutes.
#[tauri::command]
pub async fn network_diagnostics_export(state: State<'_, AppState>) -> Result<String, String> {
    let resolution = crate::commands::network::refresh(&state).await;
    let run_env = crate::commands::run::environment(&state).await;
    let (_, skipped) =
        crate::commands::broker::gateway_env(&state, resolution.config.gateway_enabled);
    let broker = crate::commands::broker::status_of(&state, resolution.config.gateway_enabled);
    let token = state.broker.endpoints().map(|endpoints| endpoints.token);
    let proxy = HttpProxy {
        resolved: resolution.proxy.clone(),
        credentials: resolution.credentials.clone(),
    };
    let scrub = Scrub {
        credentials: resolution.credentials.clone(),
        token,
    };
    let status = json!({
        "mode": format!("{:?}", resolution.config.mode),
        "source": resolution.proxy.source,
        "active": resolution.proxy.active(),
        "http": resolution.proxy.http.as_ref().map(|p| p.display()),
        "https": resolution.proxy.https.as_ref().map(|p| p.display()),
        "socks": resolution.proxy.socks.as_ref().map(|p| p.display()),
        "noProxy": resolution.proxy.no_proxy,
        "pacUrl": resolution.proxy.pac_url,
        "hasCredentials": resolution.credentials.is_some(),
        "credentialStatus": resolution.credential_status,
    });
    let logs = state.app_root.join("logs");
    let work = state.broker.temp_dir().join("diagnostics");
    let staging = state.broker.temp_dir().display().to_string();
    let file = logs.join("openmind-network-diagnostics.json");
    let written = file.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = std::fs::create_dir_all(&work);
        let mut openmind_path = run_env.path_prepend.clone();
        openmind_path.extend(inherited_path());
        let external_path = inherited_path();
        let program = |name: &str, dirs: &[PathBuf]| find(name, dirs);
        let selected: Value = ["git", "python", "node", "npm", "php", "composer", "go", "cargo"]
            .iter()
            .map(|name| (name.to_string(), json!(program(name, &openmind_path).map(|p| p.display().to_string()))))
            .collect::<serde_json::Map<_, _>>()
            .into();
        // Exactly what an OpenMind terminal gets (runtime variables and the gateway settings).
        let openmind_env = run_env.vars.clone();
        let cache = work.join("tool-cache");
        let _ = std::fs::create_dir_all(&cache);
        let npm_cache = ("npm_config_cache".to_string(), cache.join("npm").display().to_string());
        let pip_dir = work.join("pip");
        let pip_dir_text = pip_dir.display().to_string();

        let hosts: Vec<Value> = HOSTS
            .iter()
            .map(|(host, url)| {
                let a = test_connection(url, Some(&proxy));
                let mut entry = dns_and_tcp(host);
                entry["host"] = json!(host);
                entry["A_downloadManager"] = json!({
                    // Any HTTP answer means the route reaches the host (a 404 of a folder address is still an answer).
                    "reachable": a.status.is_some(),
                    "ok": a.ok, "status": a.status, "problem": a.problem, "route": a.route,
                    "elapsedMs": a.elapsed_ms, "detail": a.detail.map(|d| scrub.text(&d)),
                });
                entry
            })
            .collect();

        let pip_args = ["-s", "-m", "pip", "download", "six==1.17.0", "--no-deps", "--no-cache-dir", "--disable-pip-version-check", "-d", pip_dir_text.as_str()];
        let git_args = ["ls-remote", "https://github.com/octocat/Hello-World.git", "HEAD"];
        let npm_args = ["view", "left-pad", "version"];
        let composer_args = ["show", "--available", "--no-interaction", "psr/log"];
        let isolated = [("PYTHONNOUSERSITE".to_string(), "1".to_string()), ("PIP_CONFIG_FILE".to_string(), "nul".to_string())];
        let tools = |dirs: &[PathBuf], vars: &[(String, String)]| -> Value {
            let mut env: Vec<(String, String)> = vars.to_vec();
            env.extend(isolated.iter().cloned());
            env.push(npm_cache.clone());
            let run = |name: &str, args: &[&str], env: &[(String, String)]| match program(name, dirs) {
                Some(path) => {
                    let mut result = run_tool(&path, args, &work, dirs, env, &scrub);
                    result["program"] = json!(path.display().to_string());
                    result
                }
                None => json!({ "ran": false, "error": format!("{name} was not found") }),
            };
            let _ = std::fs::remove_dir_all(&pip_dir);
            let pip = run("python", &pip_args, &env);
            let _ = std::fs::remove_dir_all(&pip_dir);
            json!({
                "pip": pip,
                "npm": run("npm", &npm_args, &env),
                "composer": run("composer", &composer_args, &env),
                "git": run("git", &git_args, &env),
            })
        };
        let through_openmind = tools(&openmind_path, &openmind_env);
        let external = tools(&external_path, &[]);
        let git_backend = program("git", &openmind_path).map(|git| {
            run_tool(&git, &["config", "--get", "http.sslBackend"], &work, &openmind_path, &[], &scrub)["output"].clone()
        });

        let report = json!({
            "format": "openmind-network-diagnostics",
            "version": 1,
            "app": env!("CARGO_PKG_VERSION"),
            "generatedAt": openmind_broker::staging::now_secs(),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "proxy": status,
            "inheritedVariables": inherited_proxy_vars(&scrub),
            "gateway": broker,
            "providerRouting": {
                "pip": "PIP_INDEX_URL -> gateway /pypi (files via the broker, SHA-256 checked)",
                "npm": "NPM_CONFIG_REGISTRY / PNPM_CONFIG_REGISTRY -> gateway npm port (tarballs via the broker)",
                "go": "GOPROXY -> gateway /go (zips via the broker, sumdb through the gateway)",
                "git": "url.insteadOf -> gateway /git (fetch/clone); push uses Git's own connection",
                "cargo": "CARGO_HTTP_PROXY -> gateway tunnel (TLS by Cargo)",
                "composer": "OpenMind's Composer launcher -> gateway tunnel (TLS by Composer)",
                "skipped": skipped,
            },
            "selectedExecutables": selected,
            "certificateBackends": {
                "openmindDownloadManager": "rustls with the bundled Mozilla root certificates (webpki-roots); certificate checks always on",
                "gitHttpSslBackend": git_backend,
            },
            "stagingPath": staging,
            "conpty": if cfg!(windows) { "Windows pseudo console (ConPTY) through portable-pty" } else { "Unix pseudo terminal" },
            "hosts": hosts,
            "B_to_E_throughOpenMind": through_openmind,
            "F_externalPowerShellEquivalent": external,
            "G_integratedTerminal": "same environment as B-E (an OpenMind terminal gets exactly these settings)",
        });
        let _ = std::fs::remove_dir_all(&work);
        let text = serde_json::to_string_pretty(&report).map_err(|err| err.to_string())?;
        std::fs::create_dir_all(&logs).map_err(|err| err.to_string())?;
        std::fs::write(&file, text).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())??;
    tracing::info!(file = %written.display(), "network diagnostics written");
    Ok(written.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_removed_from_tool_output() {
        let scrub = Scrub {
            credentials: Some(openmind_network::proxy::Credentials {
                username: "ivan".into(),
                password: "s3cr3t!".into(),
            }),
            token: Some("abcdef0123".into()),
        };
        let text = "ProxyError http://ivan:s3cr3t!@proxy:8080 via http://127.0.0.1:5/abcdef0123/pypi/simple/";
        let clean = scrub.tail(text);
        assert!(
            !clean.contains("s3cr3t") && !clean.contains("abcdef0123"),
            "{clean}"
        );
    }

    #[test]
    fn programs_are_found_in_the_given_folders_only() {
        let tmp = tempfile::tempdir().expect("tmp");
        std::fs::write(tmp.path().join("git.exe"), b"").expect("git");
        assert_eq!(
            find("git", &[tmp.path().to_path_buf()]),
            Some(tmp.path().join("git.exe"))
        );
        assert_eq!(find("npm", &[tmp.path().to_path_buf()]), None);
    }
}
