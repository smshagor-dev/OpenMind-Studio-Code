//! Getting an artifact onto disk with its checksum verified: each address is retried a few times for failures a
//! retry can fix (with a growing pause), then the manifest's mirrors are tried. A checksum mismatch deletes the file
//! and moves to the next address; a proxy asking for a password stops at once. Nothing is kept unless it matched.

use std::path::Path;
use std::time::Duration;

use openmind_network::problem::{NetError, NetProblem};
use openmind_network::retry::{with_mirrors, RetryPolicy};

use crate::download::{download, verify_sha256, HttpClient};
use crate::error::RuntimeError;
use crate::manifest::Artifact;

pub fn fetch_verified(
    client: &dyn HttpClient,
    artifact: &Artifact,
    archive: &Path,
    downloaded: &dyn Fn(u64, Option<u64>),
    verified: &dyn Fn(u64, Option<u64>),
    sleep: &mut dyn FnMut(Duration),
) -> Result<(), RuntimeError> {
    let mut last: Option<RuntimeError> = None;
    let urls = artifact.urls();
    let outcome = with_mirrors(
        &urls,
        RetryPolicy::default(),
        sleep,
        &|| false,
        &mut |url| {
            let result = download(client, url, archive, artifact.size_bytes, &mut |c, t| {
                downloaded(c, t)
            })
            .and_then(|()| verify_sha256(archive, &artifact.sha256, &mut |c, t| verified(c, t)));
            result.map_err(|error| {
                let net = match &error {
                    RuntimeError::Network(net) => net.clone(),
                    RuntimeError::ChecksumMismatch { .. } => {
                        NetError::new(NetProblem::Checksum, error.to_string())
                    }
                    RuntimeError::InsecureUrl(_) => {
                        NetError::new(NetProblem::InsecureUrl, error.to_string())
                    }
                    _ => NetError::new(NetProblem::Other, error.to_string()),
                };
                last = Some(error);
                net
            })
        },
    );
    outcome.map_err(|net| last.take().unwrap_or(RuntimeError::Network(net)))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::io::Cursor;
    use std::sync::Mutex;

    use sha2::{Digest, Sha256};

    use super::*;
    use crate::download::HttpResponse;
    use crate::manifest::ArchiveKind;

    /// Answers each URL from a script of outcomes (the last one repeats).
    struct Scripted {
        script: HashMap<String, Vec<Result<Vec<u8>, NetProblem>>>,
        requests: Mutex<Vec<String>>,
    }

    impl HttpClient for Scripted {
        fn get(&self, url: &str, _range_from: Option<u64>) -> Result<HttpResponse, RuntimeError> {
            let mut requests = self.requests.lock().expect("lock");
            let round = requests.iter().filter(|u| u.as_str() == url).count();
            requests.push(url.to_string());
            let steps = self
                .script
                .get(url)
                .cloned()
                .unwrap_or_else(|| vec![Err(NetProblem::Dns)]);
            match steps[round.min(steps.len() - 1)].clone() {
                Ok(body) => Ok(HttpResponse {
                    status: 200,
                    content_length: Some(body.len() as u64),
                    body: Box::new(Cursor::new(body)),
                }),
                Err(NetProblem::ProxyAuthRequired) => {
                    Err(RuntimeError::Network(NetError::status(407, url)))
                }
                Err(problem) => Err(RuntimeError::Network(NetError::new(problem, "scripted"))),
            }
        }
    }

    const MAIN: &str = "https://main.example/a.zip";
    const MIRROR: &str = "https://mirror.example/a.zip";

    fn artifact(body: &[u8]) -> Artifact {
        Artifact {
            platform: "windows-x64".into(),
            url: MAIN.into(),
            sha256: Sha256::digest(body)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect(),
            size_bytes: None,
            archive: ArchiveKind::Zip,
            strip_components: 0,
            extract_root: None,
            install_as: None,
            mirrors: vec![MIRROR.into()],
            install_bytes: None,
        }
    }

    type Outcome = (Result<(), RuntimeError>, Vec<String>, Vec<Duration>, bool);
    type Script<'a> = Vec<(&'a str, Vec<Result<Vec<u8>, NetProblem>>)>;

    fn run(script: Script<'_>) -> Outcome {
        let dir = tempfile::tempdir().expect("tempdir");
        let archive = dir.path().join("a.zip");
        let client = Scripted {
            script: script
                .into_iter()
                .map(|(u, s)| (u.to_string(), s))
                .collect(),
            requests: Mutex::new(Vec::new()),
        };
        let mut slept = Vec::new();
        let result = fetch_verified(
            &client,
            &artifact(b"good"),
            &archive,
            &|_, _| {},
            &|_, _| {},
            &mut |d| slept.push(d),
        );
        let requests = client.requests.lock().expect("lock").clone();
        (result, requests, slept, archive.exists())
    }

    #[test]
    fn a_timeout_is_retried_after_a_pause_and_then_succeeds() {
        let (result, requests, slept, exists) = run(vec![(
            MAIN,
            vec![Err(NetProblem::Timeout), Ok(b"good".to_vec())],
        )]);
        assert!(result.is_ok());
        assert_eq!(requests, vec![MAIN, MAIN]);
        assert_eq!(slept, vec![Duration::from_secs(1)]);
        assert!(exists);
    }

    #[test]
    fn a_wrong_file_is_deleted_and_the_mirror_supplies_the_right_one() {
        let (result, requests, slept, exists) = run(vec![
            (MAIN, vec![Ok(b"evil".to_vec())]),
            (MIRROR, vec![Ok(b"good".to_vec())]),
        ]);
        assert!(result.is_ok());
        assert_eq!(requests, vec![MAIN, MIRROR]);
        assert!(slept.is_empty());
        assert!(exists);
    }

    #[test]
    fn a_proxy_asking_for_a_password_stops_without_trying_the_mirror() {
        let (result, requests, _, exists) =
            run(vec![(MAIN, vec![Err(NetProblem::ProxyAuthRequired)])]);
        match result {
            Err(RuntimeError::Network(error)) => {
                assert_eq!(error.problem, NetProblem::ProxyAuthRequired)
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(requests, vec![MAIN]);
        assert!(!exists);
    }

    #[test]
    fn when_every_address_fails_the_last_error_is_reported_and_nothing_is_kept() {
        let (result, requests, _, exists) = run(vec![
            (MAIN, vec![Ok(b"evil".to_vec())]),
            (MIRROR, vec![Err(NetProblem::Dns)]),
        ]);
        match result {
            Err(RuntimeError::Network(error)) => assert_eq!(error.problem, NetProblem::Dns),
            other => panic!("{other:?}"),
        }
        assert_eq!(requests, vec![MAIN, MIRROR]);
        assert!(!exists, "the mismatching file was deleted");
    }
}
