use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use openmind_network::problem::{NetError, NetProblem};
use sha2::{Digest, Sha256};

use crate::error::RuntimeError;

const CHUNK: usize = 64 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

pub struct HttpResponse {
    pub status: u16,
    /// Length of *this response's body* (not the whole file when partial).
    pub content_length: Option<u64>,
    pub body: Box<dyn Read + Send>,
}

/// The one network seam. The real implementation is HTTPS-only; tests plug
/// in an in-memory server so resume/verification logic is exercised without
/// a network (and without ever weakening the HTTPS rule for real use).
pub trait HttpClient: Send + Sync {
    fn get(&self, url: &str, range_from: Option<u64>) -> Result<HttpResponse, RuntimeError>;

    /// `get` for a download of about `expected_bytes` (the time allowed for the body depends on it).
    fn get_sized(
        &self,
        url: &str,
        range_from: Option<u64>,
        _expected_bytes: Option<u64>,
    ) -> Result<HttpResponse, RuntimeError> {
        self.get(url, range_from)
    }
}

/// ureq's body timeout is the *total* time for the whole body, not an idle timeout: it must fit the download.
/// At least 15 minutes, and enough for the expected size at 200 KB/s (a slow link); 5 minutes when the size is unknown.
pub fn body_timeout(expected_bytes: Option<u64>) -> Duration {
    match expected_bytes {
        Some(bytes) => Duration::from_secs((bytes / (200 * 1024)).max(15 * 60)),
        None => Duration::from_secs(5 * 60),
    }
}

/// The real client. The agent is built per request so it follows the proxy in force for that address
/// (`openmind_network::http`): with no proxy configured nothing changes.
pub struct UreqClient;

impl UreqClient {
    pub fn new() -> Self {
        Self
    }

    fn agent(url: &str, body: Duration) -> ureq::Agent {
        use openmind_network::http::{agent, Timeouts};
        agent(url, Timeouts::download(body), None)
    }
}

/// A network error of the HTTP client, categorized and free of proxy credentials.
pub(crate) fn network_error(error: &ureq::Error, url: &str) -> RuntimeError {
    RuntimeError::Network(openmind_network::http::net_error(error, url))
}

fn read_error(error: std::io::Error) -> RuntimeError {
    let problem = openmind_network::problem::classify_io(&error);
    RuntimeError::Network(NetError::new(problem, error.to_string()))
}

impl Default for UreqClient {
    fn default() -> Self {
        Self::new()
    }
}

impl HttpClient for UreqClient {
    fn get(&self, url: &str, range_from: Option<u64>) -> Result<HttpResponse, RuntimeError> {
        self.get_sized(url, range_from, None)
    }

    fn get_sized(
        &self,
        url: &str,
        range_from: Option<u64>,
        expected_bytes: Option<u64>,
    ) -> Result<HttpResponse, RuntimeError> {
        let remaining = expected_bytes.map(|total| total.saturating_sub(range_from.unwrap_or(0)));
        let mut request = Self::agent(url, body_timeout(remaining)).get(url);
        if let Some(start) = range_from {
            request = request.header("Range", format!("bytes={start}-"));
        }
        let response = request.call().map_err(|err| network_error(&err, url))?;
        let status = response.status().as_u16();
        let content_length = response.body().content_length();
        Ok(HttpResponse {
            status,
            content_length,
            body: Box::new(response.into_body().into_reader()),
        })
    }
}

/// Progress of a byte-oriented step: bytes done, and the total if known.
pub type BytesProgress<'a> = &'a mut dyn FnMut(u64, Option<u64>);

/// Downloads `url` to `dest`, resuming a previous partial `.part` file when
/// the server supports ranges, and returns only after the *finished* file is
/// in place. The caller verifies the checksum next — nothing here is trusted
/// or executed. HTTPS is enforced before any request is made.
pub fn download(
    client: &dyn HttpClient,
    url: &str,
    dest: &Path,
    expected_size: Option<u64>,
    progress: BytesProgress<'_>,
) -> Result<(), RuntimeError> {
    if !url.to_ascii_lowercase().starts_with("https://") {
        return Err(RuntimeError::InsecureUrl(url.to_string()));
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|err| RuntimeError::io(parent, err))?;
    }
    let part = part_path(dest);
    let mut resume_from = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);

    let mut response =
        client.get_sized(url, (resume_from > 0).then_some(resume_from), expected_size)?;
    if response.status == 416 {
        // The partial file is longer than (or unrelated to) the remote file.
        let _ = fs::remove_file(&part);
        resume_from = 0;
        response = client.get_sized(url, None, expected_size)?;
    }
    let resumed = match response.status {
        206 if resume_from > 0 => true,
        200 => false,
        other => return Err(RuntimeError::Network(NetError::status(other, url))),
    };
    tracing::info!(url, status = response.status, resume_from, resumed, length = ?response.content_length, "download response");
    if !resumed {
        // The server ignored the Range header (or there was nothing to resume): start over.
        resume_from = 0;
    }

    let total = response
        .content_length
        .map(|len| len + resume_from)
        .or(expected_size);
    let mut file = if resumed {
        OpenOptions::new().append(true).open(&part)
    } else {
        File::create(&part)
    }
    .map_err(|err| RuntimeError::io(&part, err))?;

    let mut done = resume_from;
    let mut buffer = vec![0u8; CHUNK];
    let mut last_report = Instant::now();
    progress(done, total);
    loop {
        let read = response.body.read(&mut buffer).map_err(read_error)?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|err| RuntimeError::io(&part, err))?;
        done += read as u64;
        if last_report.elapsed() >= PROGRESS_INTERVAL {
            progress(done, total);
            last_report = Instant::now();
        }
    }
    file.flush().map_err(|err| RuntimeError::io(&part, err))?;
    drop(file);
    if let Some(total) = response.content_length.map(|len| len + resume_from) {
        if done != total {
            // Connection dropped mid-body: keep the .part so the next attempt resumes it.
            return Err(RuntimeError::Network(NetError::new(
                NetProblem::ConnectionFailed,
                format!("connection ended after {done} of {total} bytes"),
            )));
        }
    }
    progress(done, total);
    if dest.exists() {
        fs::remove_file(dest).map_err(|err| RuntimeError::io(dest, err))?;
    }
    fs::rename(&part, dest).map_err(|err| RuntimeError::io(dest, err))?;
    Ok(())
}

fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    dest.with_file_name(name)
}

/// Streams `path` through SHA256 and compares with `expected` (hex, any
/// case). A mismatch deletes the file — a bad download must never be reused —
/// and is an error.
pub fn verify_sha256(
    path: &Path,
    expected: &str,
    progress: BytesProgress<'_>,
) -> Result<(), RuntimeError> {
    let mut file = File::open(path).map_err(|err| RuntimeError::io(path, err))?;
    let total = file.metadata().map(|m| m.len()).ok();
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; CHUNK];
    let mut done = 0u64;
    let mut last_report = Instant::now();
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|err| RuntimeError::io(path, err))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        done += read as u64;
        if last_report.elapsed() >= PROGRESS_INTERVAL {
            progress(done, total);
            last_report = Instant::now();
        }
    }
    progress(done, total);
    let actual = hex(&hasher.finalize());
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        drop(file);
        let _ = fs::remove_file(path);
        Err(RuntimeError::ChecksumMismatch {
            expected: expected.to_ascii_lowercase(),
            actual,
        })
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Cursor;
    use std::sync::Mutex;

    /// Serves one in-memory file, honoring Range like a real server — or ignoring it.
    pub struct FakeServer {
        pub data: Vec<u8>,
        pub supports_range: bool,
        pub fail_after: Mutex<Option<usize>>,
        pub requests: Mutex<Vec<Option<u64>>>,
    }

    impl FakeServer {
        pub fn new(data: Vec<u8>) -> Self {
            Self {
                data,
                supports_range: true,
                fail_after: Mutex::new(None),
                requests: Mutex::new(Vec::new()),
            }
        }
    }

    struct Truncated(Cursor<Vec<u8>>, usize);
    impl Read for Truncated {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let limit = self.1.saturating_sub(self.0.position() as usize);
            if limit == 0 {
                return Ok(0);
            }
            let cap = buf.len().min(limit);
            self.0.read(&mut buf[..cap])
        }
    }

    impl HttpClient for FakeServer {
        fn get(&self, _url: &str, range_from: Option<u64>) -> Result<HttpResponse, RuntimeError> {
            self.requests.lock().expect("lock").push(range_from);
            let (status, start) = match range_from {
                Some(start) if self.supports_range => {
                    if start as usize > self.data.len() {
                        return Ok(HttpResponse {
                            status: 416,
                            content_length: Some(0),
                            body: Box::new(Cursor::new(Vec::new())),
                        });
                    }
                    (206, start as usize)
                }
                _ => (200, 0),
            };
            let body = self.data[start..].to_vec();
            let content_length = Some(body.len() as u64);
            let fail_after = self.fail_after.lock().expect("lock").take();
            let reader: Box<dyn Read + Send> = match fail_after {
                Some(limit) => Box::new(Truncated(Cursor::new(body), limit)),
                None => Box::new(Cursor::new(body)),
            };
            Ok(HttpResponse {
                status,
                content_length,
                body: reader,
            })
        }
    }

    fn sha_of(data: &[u8]) -> String {
        hex(&Sha256::digest(data))
    }

    fn sample() -> Vec<u8> {
        (0..300_000u32).map(|n| (n % 251) as u8).collect()
    }

    #[test]
    fn downloads_a_file_and_reports_progress() {
        let dir = tempfile::tempdir().expect("tempdir");
        let server = FakeServer::new(sample());
        let dest = dir.path().join("a.zip");
        let mut last = (0, None);

        download(
            &server,
            "https://x/a.zip",
            &dest,
            None,
            &mut |done, total| last = (done, total),
        )
        .expect("download");

        assert_eq!(fs::read(&dest).expect("read"), sample());
        assert_eq!(last, (300_000, Some(300_000)));
        assert!(!part_path(&dest).exists());
    }

    #[test]
    fn refuses_non_https_urls_before_making_any_request() {
        let dir = tempfile::tempdir().expect("tempdir");
        let server = FakeServer::new(sample());

        for url in ["http://x/a.zip", "ftp://x/a.zip", "file:///c:/a.zip"] {
            let result = download(
                &server,
                url,
                &dir.path().join("a.zip"),
                None,
                &mut |_, _| {},
            );
            assert!(matches!(result, Err(RuntimeError::InsecureUrl(_))), "{url}");
        }
        assert!(server.requests.lock().expect("lock").is_empty());
    }

    #[test]
    fn the_body_time_limit_fits_the_download_size() {
        // A 1.9 GB SDK must not be cut off after a minute (ureq's body timeout is the total time).
        assert!(body_timeout(Some(1_933_437_428)) >= Duration::from_secs(9_000));
        assert_eq!(body_timeout(Some(1_000)), Duration::from_secs(15 * 60));
        assert_eq!(body_timeout(None), Duration::from_secs(5 * 60));
    }

    #[test]
    fn an_interrupted_download_keeps_its_part_file_and_the_next_attempt_resumes_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let server = FakeServer::new(sample());
        let dest = dir.path().join("a.zip");
        *server.fail_after.lock().expect("lock") = Some(100_000);

        let first = download(&server, "https://x/a.zip", &dest, None, &mut |_, _| {});
        assert!(matches!(first, Err(RuntimeError::Network(_))));
        assert!(!dest.exists());
        assert_eq!(fs::metadata(part_path(&dest)).expect("part").len(), 100_000);

        download(&server, "https://x/a.zip", &dest, None, &mut |_, _| {}).expect("resume");

        assert_eq!(fs::read(&dest).expect("read"), sample());
        assert_eq!(
            *server.requests.lock().expect("lock"),
            vec![None, Some(100_000)]
        );
    }

    #[test]
    fn a_server_that_ignores_range_restarts_cleanly_instead_of_corrupting_the_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut server = FakeServer::new(sample());
        server.supports_range = false;
        let dest = dir.path().join("a.zip");
        fs::write(part_path(&dest), &sample()[..50_000]).expect("seed part");

        download(&server, "https://x/a.zip", &dest, None, &mut |_, _| {}).expect("download");

        assert_eq!(fs::read(&dest).expect("read"), sample());
    }

    #[test]
    fn a_part_file_longer_than_the_remote_file_is_discarded_and_restarted() {
        let dir = tempfile::tempdir().expect("tempdir");
        let server = FakeServer::new(sample());
        let dest = dir.path().join("a.zip");
        fs::write(part_path(&dest), vec![7u8; 400_000]).expect("seed part");

        download(&server, "https://x/a.zip", &dest, None, &mut |_, _| {}).expect("download");

        assert_eq!(fs::read(&dest).expect("read"), sample());
    }

    #[test]
    fn verify_accepts_the_right_hash_in_any_case_and_keeps_the_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("f.bin");
        fs::write(&path, sample()).expect("write");

        verify_sha256(&path, &sha_of(&sample()).to_uppercase(), &mut |_, _| {}).expect("verify");

        assert!(path.exists());
    }

    #[test]
    fn verify_rejects_a_wrong_hash_and_deletes_the_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("f.bin");
        fs::write(&path, sample()).expect("write");

        let result = verify_sha256(&path, &"0".repeat(64), &mut |_, _| {});

        assert!(matches!(result, Err(RuntimeError::ChecksumMismatch { .. })));
        assert!(!path.exists());
    }

    #[test]
    fn known_sha256_vector() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("abc");
        fs::write(&path, b"abc").expect("write");

        verify_sha256(
            &path,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            &mut |_, _| {},
        )
        .expect("the standard SHA-256 test vector for \"abc\"");
    }
}
