//! Downloads a model's files with the Runtime Manager's downloader (HTTPS only, the user's proxy, resume from a `.part`
//! file) and checks each one against its SHA-256 before it counts. Stopping keeps the `.part` file, so the next start
//! resumes; a checksum mismatch deletes the file.

use std::io::{self, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use openmind_runtime_manager::download::{
    download, verify_sha256, HttpClient, HttpResponse, UreqClient,
};
use openmind_runtime_manager::error::RuntimeError;
use serde::Serialize;

use crate::catalog::ModelEntry;
use crate::error::{human_bytes, LlmError};
use crate::hardware::free_disk_bytes;
use crate::store::ModelStore;

/// Room kept free on the drive beyond the model itself.
const DISK_MARGIN: u64 = 512 * 1024 * 1024;
const ATTEMPTS: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Downloading,
    Verifying,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub phase: Phase,
    /// 1-based file number and the number of files (split models have several).
    pub file: usize,
    pub files: usize,
    /// Bytes done across the whole model, and its total.
    pub done_bytes: u64,
    pub total_bytes: u64,
}

/// A response body that stops with an error the moment the download is cancelled.
struct CancelReader {
    inner: Box<dyn Read + Send>,
    cancel: Arc<AtomicBool>,
}

impl Read for CancelReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "cancelled"));
        }
        self.inner.read(buf)
    }
}

/// The real client with a cancellable body.
struct CancellableClient<'a> {
    inner: &'a dyn HttpClient,
    cancel: Arc<AtomicBool>,
}

impl HttpClient for CancellableClient<'_> {
    fn get(&self, url: &str, range_from: Option<u64>) -> Result<HttpResponse, RuntimeError> {
        self.get_sized(url, range_from, None)
    }

    fn get_sized(
        &self,
        url: &str,
        range_from: Option<u64>,
        expected: Option<u64>,
    ) -> Result<HttpResponse, RuntimeError> {
        let response = self.inner.get_sized(url, range_from, expected)?;
        Ok(HttpResponse {
            status: response.status,
            content_length: response.content_length,
            body: Box::new(CancelReader {
                inner: response.body,
                cancel: Arc::clone(&self.cancel),
            }),
        })
    }
}

/// Checks the drive has room for what is still to download.
pub fn check_space(store: &ModelStore, model: &ModelEntry) -> Result<(), LlmError> {
    let remaining = model
        .size_bytes()
        .saturating_sub(store.bytes_on_disk(model));
    let Some(free) = free_disk_bytes(store.dir()) else {
        return Ok(());
    };
    if free < remaining + DISK_MARGIN {
        return Err(LlmError::DiskFull {
            needed: human_bytes(remaining + DISK_MARGIN),
            free: human_bytes(free),
            path: store.dir().to_path_buf(),
        });
    }
    Ok(())
}

/// Downloads every file of `model` that isn't verified yet. `progress` is called often (the caller throttles events).
pub fn download_model(
    store: &ModelStore,
    model: &ModelEntry,
    cancel: Arc<AtomicBool>,
    progress: &mut dyn FnMut(&Progress),
) -> Result<(), LlmError> {
    download_with(
        &UreqClient::new(),
        store,
        model,
        cancel,
        progress,
        &mut |d| std::thread::sleep(d),
    )
}

pub fn download_with(
    client: &dyn HttpClient,
    store: &ModelStore,
    model: &ModelEntry,
    cancel: Arc<AtomicBool>,
    progress: &mut dyn FnMut(&Progress),
    sleep: &mut dyn FnMut(Duration),
) -> Result<(), LlmError> {
    check_space(store, model)?;
    let client = CancellableClient {
        inner: client,
        cancel: Arc::clone(&cancel),
    };
    let total = model.size_bytes();
    let files = model.files.len();
    let mut before = 0u64;
    for (index, file) in model.files.iter().enumerate() {
        if store.is_verified(model, file) {
            before += file.size_bytes;
            continue;
        }
        let dest = store.file_path(model, file)?;
        let url = model.url(file);
        let mut attempt = 0;
        loop {
            attempt += 1;
            let result = download(
                &client,
                &url,
                &dest,
                Some(file.size_bytes),
                &mut |done, _| {
                    progress(&Progress {
                        phase: Phase::Downloading,
                        file: index + 1,
                        files,
                        done_bytes: before + done,
                        total_bytes: total,
                    });
                },
            );
            if cancel.load(Ordering::Relaxed) {
                return Err(LlmError::Cancelled);
            }
            match result {
                Ok(()) => break,
                Err(RuntimeError::Network(net)) if attempt < ATTEMPTS => {
                    tracing::warn!(model = %model.id, attempt, error = %net, "model download interrupted; resuming");
                    sleep(Duration::from_secs(u64::from(attempt) * 2));
                }
                Err(err) => return Err(LlmError::Download(err.to_string())),
            }
        }
        verify_sha256(&dest, &file.sha256, &mut |done, _| {
            progress(&Progress {
                phase: Phase::Verifying,
                file: index + 1,
                files,
                done_bytes: before + done,
                total_bytes: total,
            });
        })
        .map_err(|err| LlmError::Download(err.to_string()))?;
        store.mark_verified(model, file)?;
        before += file.size_bytes;
        tracing::info!(model = %model.id, file = %file.path, "model file downloaded and verified");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::sync::Mutex;

    use super::*;
    use crate::catalog::{Catalog, ModelFile};
    use crate::store::ModelState;

    struct Server {
        data: Vec<u8>,
        /// Cut the body after this many bytes on the first request.
        cut_first: Option<usize>,
        calls: Mutex<Vec<Option<u64>>>,
    }

    impl HttpClient for Server {
        fn get(&self, _url: &str, range: Option<u64>) -> Result<HttpResponse, RuntimeError> {
            let mut calls = self.calls.lock().expect("lock");
            calls.push(range);
            let from = range.unwrap_or(0) as usize;
            let mut body = self.data[from..].to_vec();
            if calls.len() == 1 {
                if let Some(cut) = self.cut_first {
                    body.truncate(cut);
                }
            }
            Ok(HttpResponse {
                status: if from > 0 { 206 } else { 200 },
                content_length: Some((self.data.len() - from) as u64),
                body: Box::new(Cursor::new(body)),
            })
        }
    }

    fn model_for(data: &[u8]) -> ModelEntry {
        use sha2::{Digest, Sha256};
        let mut model = Catalog::builtin()
            .expect("catalog")
            .get("nemotron-3-nano-4b-q4")
            .expect("nano")
            .clone();
        let sha256 = Sha256::digest(data)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        model.files = vec![ModelFile {
            path: "model.gguf".into(),
            size_bytes: data.len() as u64,
            sha256,
        }];
        model
    }

    #[test]
    fn a_cut_download_resumes_and_is_verified() {
        let data: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        let model = model_for(&data);
        let dir = tempfile::tempdir().expect("tmp");
        let store = ModelStore::new(dir.path().join("models"));
        let server = Server {
            data: data.clone(),
            cut_first: Some(70_000),
            calls: Mutex::new(Vec::new()),
        };
        let mut last = None;
        download_with(
            &server,
            &store,
            &model,
            Arc::new(AtomicBool::new(false)),
            &mut |p| last = Some(p.clone()),
            &mut |_| {},
        )
        .expect("download");
        assert_eq!(store.local(&model).state, ModelState::Ready);
        let calls = server.calls.lock().expect("lock").clone();
        assert_eq!(calls, vec![None, Some(70_000)]);
        let last = last.expect("progress");
        assert_eq!(last.phase, Phase::Verifying);
        assert_eq!(last.done_bytes, data.len() as u64);
    }

    #[test]
    fn a_wrong_checksum_never_counts_as_downloaded() {
        let data = vec![7u8; 1000];
        let mut model = model_for(&data);
        model.files[0].sha256 = "a".repeat(64);
        let dir = tempfile::tempdir().expect("tmp");
        let store = ModelStore::new(dir.path().join("models"));
        let server = Server {
            data,
            cut_first: None,
            calls: Mutex::new(Vec::new()),
        };
        let result = download_with(
            &server,
            &store,
            &model,
            Arc::new(AtomicBool::new(false)),
            &mut |_| {},
            &mut |_| {},
        );
        assert!(matches!(result, Err(LlmError::Download(_))));
        assert_eq!(store.local(&model).state, ModelState::NotDownloaded);
    }

    #[test]
    fn cancelling_keeps_the_partial_file_for_later() {
        let data = vec![1u8; 300_000];
        let model = model_for(&data);
        let dir = tempfile::tempdir().expect("tmp");
        let store = ModelStore::new(dir.path().join("models"));
        let server = Server {
            data,
            cut_first: Some(100_000),
            calls: Mutex::new(Vec::new()),
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&cancel);
        let result = download_with(&server, &store, &model, cancel, &mut |_| {}, &mut |_| {
            flag.store(true, Ordering::Relaxed);
        });
        // The first attempt is cut; the pause before the retry is where the user pressed Stop.
        assert!(matches!(result, Err(LlmError::Cancelled)), "{result:?}");
        assert_eq!(store.local(&model).state, ModelState::Partial);
        assert_eq!(store.bytes_on_disk(&model), 100_000);
    }
}
