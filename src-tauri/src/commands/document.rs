use std::path::Path;

use openmind_fs::{LineEnding, TextEncoding};
use serde::Serialize;
use tauri::State;

use crate::app_state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDocument {
    pub path: String,
    pub content: String,
    pub encoding: TextEncoding,
    pub line_ending: LineEnding,
}

#[tauri::command]
pub async fn document_open(
    path: String,
    state: State<'_, AppState>,
) -> Result<OpenedDocument, String> {
    if openmind_fs::is_binary(Path::new(&path))
        .await
        .map_err(|err| err.to_string())?
    {
        return Err(format!(
            "\"{path}\" looks like a binary file and can't be opened as text"
        ));
    }

    let result = openmind_fs::read_text_file(Path::new(&path))
        .await
        .map_err(|err| err.to_string())?;

    state
        .recent_files
        .touch(&path)
        .await
        .map_err(|err| err.to_string())?;

    Ok(OpenedDocument {
        path,
        content: result.content,
        encoding: result.encoding,
        line_ending: result.line_ending,
    })
}

#[tauri::command]
pub async fn document_save(
    path: String,
    content: String,
    encoding: TextEncoding,
    state: State<'_, AppState>,
) -> Result<(), String> {
    openmind_fs::write_text_file(Path::new(&path), &content, encoding)
        .await
        .map_err(|err| err.to_string())?;

    state
        .recent_files
        .touch(&path)
        .await
        .map_err(|err| err.to_string())?;

    Ok(())
}

/// What is on disk at a path right now — read again for an already-open
/// document, so it never touches the recent-files list.
#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum DiskRead {
    /// Nothing there (deleted, moved, renamed).
    Missing,
    #[serde(rename_all = "camelCase")]
    File {
        content: String,
        encoding: TextEncoding,
        line_ending: LineEnding,
    },
    /// There, but not readable as text right now (binary, locked, permissions).
    Unreadable { reason: String },
}

#[tauri::command]
pub async fn document_read(path: String) -> Result<DiskRead, String> {
    let target = Path::new(&path);
    match tokio::fs::metadata(target).await {
        Ok(meta) if meta.is_file() => {}
        Ok(_) => return Ok(DiskRead::Missing),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(DiskRead::Missing),
        Err(err) => {
            return Ok(DiskRead::Unreadable {
                reason: err.to_string(),
            })
        }
    }
    match openmind_fs::is_binary(target).await {
        Ok(true) => {
            return Ok(DiskRead::Unreadable {
                reason: "The file now looks binary.".into(),
            })
        }
        Ok(false) => {}
        Err(err) => {
            return Ok(DiskRead::Unreadable {
                reason: err.to_string(),
            })
        }
    }
    Ok(match openmind_fs::read_text_file(target).await {
        Ok(result) => DiskRead::File {
            content: result.content,
            encoding: result.encoding,
            line_ending: result.line_ending,
        },
        Err(err) => DiskRead::Unreadable {
            reason: err.to_string(),
        },
    })
}
