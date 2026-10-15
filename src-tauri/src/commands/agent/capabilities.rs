//! Desktop adapters for the testable agent capability clients.
use super::host::WindowHost;
pub use openmind_agent::capabilities::{attachment_text, specs, Attachment};
use openmind_agent::{tools::Outcome, wire::ToolCall, AgentEvent, SessionOptions};
use std::sync::atomic::AtomicBool;

pub fn call(
    host: &WindowHost<'_>,
    options: &SessionOptions,
    call: &ToolCall,
    cancel: &AtomicBool,
) -> Outcome {
    openmind_agent::capabilities::call(
        &|event: &AgentEvent| host.send(event),
        options,
        call,
        cancel,
    )
}

#[tauri::command]
pub fn agent_document_read(data: String) -> Result<String, String> {
    if data.len() > 14_000_000 {
        return Err("Document exceeds 10 MB".into());
    }
    let doc = openmind_preview::read_docx(&data).map_err(|e| e.to_string())?;
    if doc.truncated {
        return Err("Document was truncated; attach a smaller extract.".into());
    }
    let text = doc
        .blocks
        .iter()
        .map(|block| match block {
            openmind_preview::DocxBlock::Paragraph { text, .. } => text.clone(),
            openmind_preview::DocxBlock::Table { rows } => rows
                .iter()
                .map(|row| row.join("\t"))
                .collect::<Vec<_>>()
                .join("\n"),
        })
        .collect::<Vec<_>>()
        .join("\n");
    if text.len() > 100_000 {
        return Err("Document text exceeds 100 KB; attach a smaller extract.".into());
    }
    Ok(text)
}

#[tauri::command]
pub async fn agent_capabilities_check(options: SessionOptions) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || openmind_agent::capabilities::check(&options))
        .await
        .map_err(|error| error.to_string())
}
