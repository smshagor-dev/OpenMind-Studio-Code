//! Git through the gateway end to end with the real `git` client and Git's own `git-http-backend` as the "remote"
//! (a private repository that demands credentials), so clone, fetch, pull, push, a rejected push and every
//! authentication outcome run the real protocol. Nothing leaves this computer: the upstream is the CGI program.
//! Skipped when Git for Windows' `git-http-backend` isn't installed.

use std::collections::VecDeque;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use openmind_broker::gateway::credentials::{Credential, CredentialRequest, CredentialSource};
use openmind_broker::gateway::{UpRequest, UpResponse, Upstream};
use openmind_broker::{
    Broker, BrokerError, BrokerEvent, FailureKind, Gateway, GatewayConfig, Staging,
};
use openmind_runtime_manager::UreqClient;

const HOST: &str = "git.example.test";

fn git_exe() -> Option<PathBuf> {
    let git = PathBuf::from(r"C:\Program Files\Git\cmd\git.exe");
    git.is_file().then_some(git)
}

fn backend_exe() -> Option<PathBuf> {
    let backend =
        PathBuf::from(r"C:\Program Files\Git\mingw64\libexec\git-core\git-http-backend.exe");
    backend.is_file().then_some(backend)
}

/// The "remote": Git's CGI backend over a folder of bare repositories, asking for `alice:right`.
struct CgiRemote {
    backend: PathBuf,
    root: PathBuf,
    /// Push allowed (the backend enables receive-pack only for an authenticated user).
    writable: bool,
    seen: Mutex<Vec<(String, bool)>>,
}

fn basic(user: &str, password: &str) -> String {
    Credential {
        username: user.into(),
        password: password.into(),
    }
    .basic()
}

impl Upstream for CgiRemote {
    fn send(&self, request: UpRequest) -> Result<UpResponse, BrokerError> {
        let header = |name: &str| {
            request
                .headers
                .iter()
                .find(|(n, _)| n.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.clone())
        };
        let authorized =
            header("authorization").as_deref() == Some(basic("alice", "s3cr3t-right").as_str());
        self.seen
            .lock()
            .expect("lock")
            .push((request.url.clone(), authorized));
        if !authorized {
            return Ok(UpResponse {
                status: 401,
                headers: vec![("WWW-Authenticate".into(), "Basic realm=\"test\"".into())],
                body: Box::new(Cursor::new(Vec::new())),
            });
        }
        let rest = request
            .url
            .strip_prefix(&format!("https://{HOST}"))
            .expect("host");
        let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
        let mut command = Command::new(&self.backend);
        command
            .env_clear()
            .env(
                "SystemRoot",
                std::env::var("SystemRoot").unwrap_or_default(),
            )
            .env("GIT_PROJECT_ROOT", &self.root)
            .env("GIT_HTTP_EXPORT_ALL", "1")
            .env("REQUEST_METHOD", &request.method)
            .env("PATH_INFO", path)
            .env("QUERY_STRING", query)
            .env("REMOTE_ADDR", "127.0.0.1")
            .env("CONTENT_LENGTH", request.body.len().to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if self.writable {
            command.env("REMOTE_USER", "alice");
        }
        if let Some(value) = header("content-type") {
            command.env("CONTENT_TYPE", value);
        }
        if let Some(value) = header("content-encoding") {
            command.env("HTTP_CONTENT_ENCODING", value);
        }
        if let Some(value) = header("git-protocol") {
            command.env("GIT_PROTOCOL", value);
        }
        let mut child = command.spawn().expect("backend");
        let mut stdin = child.stdin.take().expect("stdin");
        let body = request.body.clone();
        let writer = std::thread::spawn(move || {
            let _ = stdin.write_all(&body);
        });
        let output = child.wait_with_output().expect("output");
        let _ = writer.join();
        let split = output
            .stdout
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .map(|p| (p, 4))
            .or_else(|| {
                output
                    .stdout
                    .windows(2)
                    .position(|w| w == b"\n\n")
                    .map(|p| (p, 2))
            })
            .expect("cgi headers");
        let head = String::from_utf8_lossy(&output.stdout[..split.0]).into_owned();
        let mut status = 200;
        let mut headers = Vec::new();
        for line in head.lines() {
            let Some((name, value)) = line.split_once(':') else {
                continue;
            };
            if name.eq_ignore_ascii_case("status") {
                status = value
                    .trim()
                    .split(' ')
                    .next()
                    .and_then(|c| c.parse().ok())
                    .unwrap_or(500);
            } else {
                headers.push((name.trim().to_string(), value.trim().to_string()));
            }
        }
        Ok(UpResponse {
            status,
            headers,
            body: Box::new(Cursor::new(output.stdout[split.0 + split.1..].to_vec())),
        })
    }
}

/// A credential helper that answers from a script, and records what it was asked.
#[derive(Default)]
struct Helper {
    answers: Mutex<VecDeque<Result<Credential, String>>>,
    asked: Mutex<Vec<CredentialRequest>>,
    approved: Mutex<usize>,
    rejected: Mutex<usize>,
}

impl CredentialSource for Helper {
    fn fill(&self, request: &CredentialRequest) -> Result<Credential, String> {
        self.asked.lock().expect("lock").push(request.clone());
        self.answers
            .lock()
            .expect("lock")
            .pop_front()
            .unwrap_or_else(|| Err("no more answers".into()))
    }
    fn approve(&self, _request: &CredentialRequest, _credential: &Credential) {
        *self.approved.lock().expect("lock") += 1;
    }
    fn reject(&self, _request: &CredentialRequest, _credential: &Credential) {
        *self.rejected.lock().expect("lock") += 1;
    }
}

fn credential(password: &str) -> Credential {
    Credential {
        username: "alice".into(),
        password: password.into(),
    }
}

struct Rig {
    gateway: Gateway,
    helper: Arc<Helper>,
    remote: Arc<CgiRemote>,
    events: Arc<Mutex<Vec<BrokerEvent>>>,
    home: PathBuf,
    tmp: tempfile::TempDir,
}

fn run_git(rig: &Rig, cwd: &Path, args: &[&str]) -> (bool, String) {
    let git = git_exe().expect("git");
    let base = rig.gateway.base();
    let output = Command::new(git)
        .args(args)
        .current_dir(cwd)
        .env("HOME", &rig.home)
        .env("USERPROFILE", &rig.home)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", rig.home.join(".gitconfig"))
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_CONFIG_COUNT", "2")
        .env(
            "GIT_CONFIG_KEY_0",
            format!("url.{base}/git/https/.insteadOf"),
        )
        .env("GIT_CONFIG_VALUE_0", "https://")
        .env(
            "GIT_CONFIG_KEY_1",
            format!("http.http://127.0.0.1:{}/.proxy", rig.gateway.port()),
        )
        .env("GIT_CONFIG_VALUE_1", "")
        .output()
        .expect("git runs");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    (output.status.success(), text)
}

fn setup(writable: bool) -> Option<Rig> {
    let (_, backend) = (git_exe()?, backend_exe()?);
    let tmp = tempfile::tempdir().expect("tmp");
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).expect("home");
    std::fs::write(
        home.join(".gitconfig"),
        "[user]\n\tname = Test\n\temail = test@example.test\n[init]\n\tdefaultBranch = master\n[core]\n\tautocrlf = false\n",
    )
    .expect("config");
    let root = tmp.path().join("remote repos");
    std::fs::create_dir_all(&root).expect("root");
    let helper = Arc::new(Helper::default());
    let remote = Arc::new(CgiRemote {
        backend,
        root: root.clone(),
        writable,
        seen: Mutex::new(Vec::new()),
    });
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    let broker = Broker::new(
        Staging::new(tmp.path().join("temp")),
        Arc::new(UreqClient::new()),
        Arc::new(move |event: &BrokerEvent| sink.lock().expect("lock").push(event.clone())),
    );
    let gateway = Gateway::start_with(
        Arc::new(broker),
        remote.clone(),
        GatewayConfig::default(),
        helper.clone(),
    )
    .expect("gateway");
    let rig = Rig {
        gateway,
        helper,
        remote,
        events,
        home,
        tmp,
    };
    // A bare "private" repository with one commit.
    let seed = rig.tmp.path().join("seed");
    std::fs::create_dir_all(&seed).expect("seed");
    for args in [
        vec!["init", "-q"],
        vec!["commit", "-q", "--allow-empty", "-m", "first"],
        vec![
            "clone",
            "-q",
            "--bare",
            ".",
            root.join("private.git").to_str().expect("utf8"),
        ],
    ] {
        let (ok, text) = run_git(&rig, &seed, &args);
        assert!(ok, "{text}");
    }
    if writable {
        let (ok, text) = run_git(
            &rig,
            &root.join("private.git"),
            &["config", "http.receivepack", "true"],
        );
        assert!(ok, "{text}");
    }
    Some(rig)
}

const URL: &str = "https://git.example.test/private.git";

#[test]
fn a_private_repository_clones_fetches_pulls_and_pushes_with_the_helpers_credentials_for_the_real_host(
) {
    let Some(rig) = setup(true) else { return };
    rig.helper
        .answers
        .lock()
        .expect("lock")
        .push_back(Ok(credential("s3cr3t-right")));
    let work = rig.tmp.path().join("work space");
    std::fs::create_dir_all(&work).expect("work");

    let (ok, text) = run_git(&rig, &work, &["clone", "-q", URL, "one"]);
    assert!(ok, "clone: {text}");
    let asked = rig.helper.asked.lock().expect("lock").clone();
    assert_eq!(asked.len(), 1, "one sign-in for the whole clone");
    assert_eq!(
        asked[0].host, HOST,
        "credentials are for the real host, never 127.0.0.1"
    );
    assert_eq!(asked[0].path, "private.git");
    assert_eq!(*rig.helper.approved.lock().expect("lock"), 1);
    let config = std::fs::read_to_string(work.join("one/.git/config")).expect("config");
    assert!(config.contains(&format!("url = {URL}")), "{config}");
    assert!(!config.contains("127.0.0.1"), "{config}");

    // Push a commit (the remembered credentials are used: no second sign-in).
    let one = work.join("one");
    std::fs::write(one.join("readme.txt"), "hello").expect("file");
    for args in [
        vec!["add", "readme.txt"],
        vec!["commit", "-q", "-m", "second"],
    ] {
        let (ok, text) = run_git(&rig, &one, &args);
        assert!(ok, "{text}");
    }
    let (ok, text) = run_git(&rig, &one, &["push", "-u", "origin", "master"]);
    assert!(ok, "push: {text}");
    assert_eq!(rig.helper.asked.lock().expect("lock").len(), 1);
    let (_, log) = run_git(
        &rig,
        &rig.tmp.path().join("remote repos/private.git"),
        &["log", "--oneline"],
    );
    assert!(
        log.contains("second"),
        "the remote has the pushed commit: {log}"
    );

    // A second clone pulls it; a diverged push is rejected by the remote and reported as such.
    let (ok, text) = run_git(&rig, &work, &["clone", "-q", URL, "two"]);
    assert!(ok, "{text}");
    let two = work.join("two");
    let (ok, text) = run_git(
        &rig,
        &two,
        &["commit", "-q", "--allow-empty", "-m", "from two"],
    );
    assert!(ok, "{text}");
    let (ok, text) = run_git(&rig, &two, &["push", "origin", "master"]);
    assert!(ok, "{text}");
    let (ok, text) = run_git(
        &rig,
        &one,
        &["commit", "-q", "--allow-empty", "-m", "diverged"],
    );
    assert!(ok, "{text}");
    let (ok, text) = run_git(&rig, &one, &["push", "origin", "master"]);
    assert!(!ok, "a non-fast-forward push must fail");
    assert!(text.contains("rejected"), "{text}");
    let (ok, text) = run_git(&rig, &one, &["pull", "-q", "--no-rebase", "--no-edit"]);
    assert!(ok, "pull: {text}");
    let (ok, text) = run_git(&rig, &one, &["push", "origin", "master"]);
    assert!(ok, "push after pull: {text}");
    let (ok, text) = run_git(&rig, &one, &["fsck", "--no-progress"]);
    assert!(ok, "{text}");
    // Every pack went through the gateway and showed up in the progress events.
    let events = rig.events.lock().expect("lock").clone();
    assert!(events
        .iter()
        .any(|e| e.artifact.starts_with("push ") && e.phase == openmind_broker::Phase::Complete));
    assert!(rig
        .remote
        .seen
        .lock()
        .expect("lock")
        .iter()
        .any(|(url, _)| url.ends_with("git-receive-pack")));
}

#[test]
fn refused_expired_and_cancelled_credentials_fail_clearly_without_a_localhost_prompt() {
    let Some(rig) = setup(true) else { return };
    let work = rig.tmp.path().join("work");
    std::fs::create_dir_all(&work).expect("work");
    // A wrong or expired password: the host refuses it, the helper is told to forget it, Git gets a clear 403.
    rig.helper
        .answers
        .lock()
        .expect("lock")
        .push_back(Ok(credential("s3cr3t-expired")));
    let (ok, text) = run_git(&rig, &work, &["clone", "-q", URL, "a"]);
    assert!(!ok);
    assert!(text.contains("403"), "{text}");
    assert!(
        !text.contains("Username for"),
        "no prompt for 127.0.0.1: {text}"
    );
    assert_eq!(*rig.helper.rejected.lock().expect("lock"), 1);
    // The next attempt asks again (the stale credential isn't reused) and works with a fresh one.
    rig.helper
        .answers
        .lock()
        .expect("lock")
        .push_back(Ok(credential("s3cr3t-right")));
    let (ok, text) = run_git(&rig, &work, &["clone", "-q", URL, "b"]);
    assert!(ok, "{text}");
    // A cancelled sign-in (the helper gives nothing): a clear failure, reported in the events.
    rig.gateway.forget_credentials();
    rig.helper
        .answers
        .lock()
        .expect("lock")
        .push_back(Err("the sign-in was cancelled".into()));
    let (ok, _) = run_git(&rig, &work, &["clone", "-q", URL, "c"]);
    assert!(!ok);
    let events = rig.events.lock().expect("lock").clone();
    let failed = events
        .iter()
        .find(|e| e.detail.as_deref() == Some("the sign-in was cancelled"))
        .expect("the cancelled sign-in is reported");
    assert_eq!(failed.failure, Some(FailureKind::Authentication));
    for event in &events {
        let detail = event.detail.clone().unwrap_or_default();
        assert!(!detail.contains("s3cr3t"), "no secret in events: {detail}");
    }
}

#[test]
fn a_push_without_permission_is_refused_by_the_remote_and_reported() {
    let Some(rig) = setup(false) else { return };
    rig.helper
        .answers
        .lock()
        .expect("lock")
        .push_back(Ok(credential("s3cr3t-right")));
    let work = rig.tmp.path().join("work");
    std::fs::create_dir_all(&work).expect("work");
    let (ok, text) = run_git(&rig, &work, &["clone", "-q", URL, "one"]);
    assert!(ok, "{text}");
    let one = work.join("one");
    let (ok, text) = run_git(&rig, &one, &["commit", "-q", "--allow-empty", "-m", "x"]);
    assert!(ok, "{text}");
    let (ok, text) = run_git(&rig, &one, &["push", "origin", "master"]);
    assert!(!ok, "{text}");
    assert!(text.contains("403"), "{text}");
}
