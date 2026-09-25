//! Read-only file previews (Milestone 11). Every command validates the path itself (absolute, no `..`, not a
//! network path, an existing regular file), reads at most the kind's size limit, runs off the async runtime, and
//! never starts a program, touches the network or writes anything.

use base64::Engine as _;
use openmind_preview::{DocxModel, Inspection, PreviewError, TextRead, XlsxModel};

fn message(err: PreviewError) -> String {
    err.to_string()
}

async fn blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, PreviewError> + Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| "The preview stopped unexpectedly.".to_string())?
        .map_err(message)
}

/// Kind, size, binary/too-large flags and whether "Open as Text" is safe.
#[tauri::command]
pub async fn preview_inspect(path: String) -> Result<Inspection, String> {
    blocking(move || openmind_preview::inspect(&path)).await
}

/// An image or PDF as base64 (refused above the kind's limit).
#[tauri::command]
pub async fn preview_read_bytes(path: String) -> Result<String, String> {
    blocking(move || {
        openmind_preview::read_bytes(&path)
            .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes))
    })
    .await
}

/// A text-format file's decoded text (a big CSV is cut at its cap).
#[tauri::command]
pub async fn preview_read_text(path: String) -> Result<TextRead, String> {
    blocking(move || openmind_preview::read_text(&path)).await
}

#[tauri::command]
pub async fn preview_docx(path: String) -> Result<DocxModel, String> {
    blocking(move || openmind_preview::read_docx(&path)).await
}

#[tauri::command]
pub async fn preview_xlsx(path: String, sheet: usize) -> Result<XlsxModel, String> {
    blocking(move || openmind_preview::read_xlsx(&path, sheet)).await
}
