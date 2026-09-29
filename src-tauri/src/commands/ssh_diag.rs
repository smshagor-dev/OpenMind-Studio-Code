//! What the diagnostics say about Git over SSH. OpenMind never routes, changes or relaxes SSH: Git uses the user's
//! own `ssh`, keys, agent and `known_hosts` (host keys are always checked). This only looks: which `ssh` would run,
//! whether port 22 (and GitHub's SSH-over-443 address) can be reached, whether an agent and public keys exist — never a
//! key's contents or path — and one non-interactive `ssh -T` probe whose *category* is kept (never its output: GitHub's
//! answer names the account).

use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// How an `ssh -T git@host` probe ended.
pub fn ssh_outcome(text: &str, code: Option<i32>) -> &'static str {
    let lower = text.to_ascii_lowercase();
    if lower.contains("successfully authenticated") || lower.contains("welcome to gitlab") {
        "authenticated"
    } else if lower.contains("remote host identification has changed") {
        "hostKeyChanged"
    } else if lower.contains("host key is known") || lower.contains("host key verification failed")
    {
        "hostKeyUnknownOrRefused"
    } else if lower.contains("permission denied (publickey") {
        "noAcceptedKey"
    } else if lower.contains("could not resolve hostname") {
        "dns"
    } else if lower.contains("port 22: connection timed out")
        || lower.contains("port 22: connection refused")
        || lower.contains("network is unreachable")
        || lower.contains("connection timed out")
    {
        "blocked"
    } else if code.is_none() {
        "timedOut"
    } else {
        "other"
    }
}

fn tcp(host: &str, port: u16) -> Value {
    let started = Instant::now();
    let address = match (host, port).to_socket_addrs().map(|mut a| a.next()) {
        Ok(Some(address)) => address,
        _ => return json!({ "ok": false, "error": "the name did not resolve" }),
    };
    match TcpStream::connect_timeout(&address, Duration::from_secs(5)) {
        Ok(_) => json!({ "ok": true, "elapsedMs": started.elapsed().as_millis() as u64 }),
        Err(err) => json!({ "ok": false, "error": err.kind().to_string() }),
    }
}

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// An agent the user's ssh can use: `SSH_AUTH_SOCK`, or Windows' OpenSSH agent service running.
fn agent() -> &'static str {
    if std::env::var_os("SSH_AUTH_SOCK").is_some() {
        return "SSH_AUTH_SOCK";
    }
    let service = Command::new("sc")
        .args(["query", "ssh-agent"])
        .stdin(Stdio::null())
        .output();
    match service {
        Ok(output) if String::from_utf8_lossy(&output.stdout).contains("RUNNING") => {
            "windowsService"
        }
        Ok(_) => "none",
        Err(_) => "unknown",
    }
}

fn probe(ssh: &Path) -> Value {
    let started = Instant::now();
    let mut command = Command::new(ssh);
    command
        .args([
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=8",
            "git@github.com",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let Ok(mut child) = command.spawn() else {
        return json!({ "ran": false });
    };
    let deadline = Instant::now() + Duration::from_secs(20);
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let output = child.wait_with_output().ok();
    let text = output
        .map(|o| {
            format!(
                "{}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            )
        })
        .unwrap_or_default();
    json!({
        "ran": true,
        "outcome": ssh_outcome(&text, code),
        "elapsedMs": started.elapsed().as_millis() as u64,
    })
}

/// The SSH part of the diagnostics. `ssh` is the program Git would run (found on the launcher PATH).
pub fn ssh_capability(ssh: Option<&Path>) -> Value {
    let ssh_dir = home().map(|home| home.join(".ssh"));
    let public_keys = ssh_dir
        .as_ref()
        .and_then(|dir| std::fs::read_dir(dir).ok())
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|e| e.file_name().to_string_lossy().ends_with(".pub"))
                .count()
        })
        .unwrap_or(0);
    let known_hosts = ssh_dir
        .as_ref()
        .is_some_and(|dir| dir.join("known_hosts").is_file());
    json!({
        "routedByOpenMind": false,
        "note": "Git over SSH uses your own ssh, keys, agent and known_hosts; OpenMind never tunnels or relaxes it.",
        "sshFound": ssh.is_some(),
        "sshSource": ssh.map(crate::commands::network_diag::tool_source),
        "port22": tcp("github.com", 22),
        "sshOver443": tcp("ssh.github.com", 443),
        "agent": agent(),
        "publicKeys": public_keys,
        "knownHostsFile": known_hosts,
        "probe": ssh.map(probe),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_answers_become_categories_never_text() {
        assert_eq!(
            ssh_outcome("Hi someone! You've successfully authenticated, but GitHub does not provide shell access.", Some(1)),
            "authenticated"
        );
        assert_eq!(
            ssh_outcome("git@github.com: Permission denied (publickey).", Some(255)),
            "noAcceptedKey"
        );
        assert_eq!(
            ssh_outcome("@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.", Some(255)),
            "hostKeyChanged"
        );
        assert_eq!(
            ssh_outcome("No ED25519 host key is known for github.com and you have requested strict checking.\nHost key verification failed.", Some(255)),
            "hostKeyUnknownOrRefused"
        );
        assert_eq!(
            ssh_outcome(
                "ssh: connect to host github.com port 22: Connection timed out",
                Some(255)
            ),
            "blocked"
        );
        assert_eq!(
            ssh_outcome(
                "ssh: Could not resolve hostname github.com: No such host is known.",
                Some(255)
            ),
            "dns"
        );
        assert_eq!(ssh_outcome("", None), "timedOut");
    }
}
