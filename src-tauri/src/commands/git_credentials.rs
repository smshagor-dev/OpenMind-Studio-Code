//! The user's Git credential helper for the package gateway: `git credential fill | approve | reject` for the **real**
//! host, run with the Git OpenMind's terminals use (OpenMind's portable Git first, then the one on PATH) and the user's
//! own Git configuration — so Git Credential Manager, a stored GitHub/GitLab/Bitbucket token or any other configured
//! helper answers, and shows its own sign-in window when it needs one. Nothing is stored by OpenMind; the credential
//! goes back to the gateway in memory. No secret is logged: only the host and the outcome.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use openmind_broker::gateway::credentials::{Credential, CredentialRequest, CredentialSource};

/// Long enough for a sign-in window (a browser sign-in with two-factor authentication).
const FILL_LIMIT: Duration = Duration::from_secs(5 * 60);
const STORE_LIMIT: Duration = Duration::from_secs(30);

pub struct GitCredentialHelper {
    /// The folders OpenMind's terminals put first on PATH (refreshed whenever a launcher environment is built).
    dirs: Arc<RwLock<Vec<PathBuf>>>,
    /// Extra variables for the helper (tests point Git at a throwaway configuration; empty in the app).
    env: Vec<(String, String)>,
}

impl GitCredentialHelper {
    pub fn new(dirs: Arc<RwLock<Vec<PathBuf>>>) -> Self {
        GitCredentialHelper {
            dirs,
            env: Vec::new(),
        }
    }

    /// The Git a terminal would run: OpenMind's folders first, then PATH.
    fn git(&self) -> Option<PathBuf> {
        let mut dirs: Vec<PathBuf> = self.dirs.read().map(|d| d.clone()).unwrap_or_default();
        if let Some(path) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&path));
        }
        dirs.iter()
            .map(|dir| dir.join(if cfg!(windows) { "git.exe" } else { "git" }))
            .find(|file| file.is_file())
    }

    /// Runs `git credential <action>` with `input`; `(success, stdout, first stderr line)`.
    fn run(
        &self,
        action: &str,
        input: &str,
        limit: Duration,
    ) -> Result<(bool, String, String), String> {
        let git = self.git().ok_or_else(|| {
            "Git isn't installed, so no credential helper can be asked".to_string()
        })?;
        run_helper(&git, action, input, limit, &self.env)
    }
}

fn request_text(request: &CredentialRequest, credential: Option<&Credential>) -> String {
    let mut text = format!(
        "protocol={}\nhost={}\npath={}\n",
        request.protocol, request.host, request.path
    );
    if let Some(credential) = credential {
        text.push_str(&format!(
            "username={}\npassword={}\n",
            credential.username, credential.password
        ));
    }
    text.push('\n');
    text
}

fn run_helper(
    git: &Path,
    action: &str,
    input: &str,
    limit: Duration,
    env: &[(String, String)],
) -> Result<(bool, String, String), String> {
    let mut command = Command::new(git);
    command
        .args(["credential", action])
        .envs(env.iter().cloned())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console; a helper's own window still shows
    }
    let mut child = command
        .spawn()
        .map_err(|err| format!("Git's credential helper could not start: {err}"))?;
    // The helper and anything it starts die with this handle (a stuck sign-in can't outlive the app or the limit).
    #[cfg(windows)]
    let tree = {
        use std::os::windows::io::AsRawHandle;
        let tree = openmind_process::ProcessTree::new().ok();
        if let Some(tree) = &tree {
            let _ = tree.assign(child.as_raw_handle());
        }
        tree
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input.as_bytes());
    }
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let out = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(pipe) = stdout.as_mut() {
            let _ = pipe.read_to_string(&mut text);
        }
        text
    });
    let err = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(pipe) = stderr.as_mut() {
            let _ = pipe.read_to_string(&mut text);
        }
        text
    });
    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    #[cfg(windows)]
    if let Some(tree) = tree {
        tree.terminate();
    }
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    let first_error = stderr
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default()
        .chars()
        .take(200)
        .collect::<String>();
    match status {
        None => Err("the sign-in took too long and was stopped".to_string()),
        Some(status) => Ok((status.success(), stdout, first_error)),
    }
}

/// `username` and `password` of a helper's answer.
fn parse_answer(text: &str) -> Option<Credential> {
    let mut username = None;
    let mut password = None;
    for line in text.lines() {
        if let Some(value) = line.strip_prefix("username=") {
            username = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("password=") {
            password = Some(value.to_string());
        }
    }
    Some(Credential {
        username: username?,
        password: password?,
    })
}

impl CredentialSource for GitCredentialHelper {
    fn fill(&self, request: &CredentialRequest) -> Result<Credential, String> {
        let (ok, stdout, error) = self.run("fill", &request_text(request, None), FILL_LIMIT)?;
        match parse_answer(&stdout) {
            Some(credential) if ok => {
                tracing::info!(host = %request.host, "credential helper answered");
                Ok(credential)
            }
            _ => {
                tracing::warn!(host = %request.host, "credential helper gave no credentials");
                let said = if error.is_empty() {
                    String::new()
                } else {
                    format!(" (Git: {error})")
                };
                Err(format!(
                    "No credentials for {}: the sign-in was cancelled or no Git credential helper is configured{said}. \
                     Sign in with Git Credential Manager (it comes with Git for Windows) or store a \
                     personal access token with your credential helper, then run the command again",
                    request.host
                ))
            }
        }
    }

    fn approve(&self, request: &CredentialRequest, credential: &Credential) {
        let _ = self.run(
            "approve",
            &request_text(request, Some(credential)),
            STORE_LIMIT,
        );
    }

    fn reject(&self, request: &CredentialRequest, credential: &Credential) {
        tracing::info!(host = %request.host, "remote refused the credentials; the helper forgets them");
        let _ = self.run(
            "reject",
            &request_text(request, Some(credential)),
            STORE_LIMIT,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_helper_answer_is_read_and_a_missing_part_is_no_credential() {
        let answer =
            parse_answer("protocol=https\nhost=github.com\nusername=ivan\npassword=ghp_x\n")
                .expect("credential");
        assert_eq!(answer.username, "ivan");
        assert_eq!(answer.password, "ghp_x");
        assert!(parse_answer("protocol=https\nhost=github.com\nusername=ivan\n").is_none());
    }

    #[test]
    fn the_request_names_the_real_host_and_path() {
        let request = CredentialRequest {
            protocol: "https".into(),
            host: "github.com".into(),
            path: "user/private.git".into(),
        };
        assert_eq!(
            request_text(&request, None),
            "protocol=https\nhost=github.com\npath=user/private.git\n\n"
        );
    }

    /// The real helper exchange with a `store` helper in a temporary HOME (never the user's own configuration).
    #[test]
    fn fill_approve_and_reject_run_the_real_git_credential_exchange() {
        let git = PathBuf::from(r"C:\Program Files\Git\cmd\git.exe");
        if !git.is_file() {
            return;
        }
        let tmp = tempfile::tempdir().expect("tmp");
        let store = tmp.path().join("store");
        std::fs::write(
            tmp.path().join(".gitconfig"),
            format!(
                "[credential]\n\thelper = store --file={}\n",
                store.display().to_string().replace('\\', "/")
            ),
        )
        .expect("config");
        let mut helper = GitCredentialHelper::new(Arc::new(RwLock::new(vec![git
            .parent()
            .expect("dir")
            .to_path_buf()])));
        helper.env = vec![
            (
                "GIT_CONFIG_GLOBAL".into(),
                tmp.path().join(".gitconfig").display().to_string(),
            ),
            ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
            ("GIT_TERMINAL_PROMPT".into(), "0".into()),
        ];
        let request = CredentialRequest {
            protocol: "https".into(),
            host: "git.example.test".into(),
            path: "private.git".into(),
        };
        let none = helper.fill(&request).expect_err("nothing stored yet");
        assert!(none.contains("git.example.test"), "{none}");
        let credential = Credential {
            username: "alice".into(),
            password: "s3cr3t".into(),
        };
        helper.approve(&request, &credential);
        assert_eq!(helper.fill(&request).expect("stored"), credential);
        helper.reject(&request, &credential);
        assert!(
            helper.fill(&request).is_err(),
            "a rejected credential is forgotten"
        );
    }
}
