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
