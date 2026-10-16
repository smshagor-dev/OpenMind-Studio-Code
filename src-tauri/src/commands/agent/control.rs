//! Explicit slash commands use the same window isolation and dirty-editor guard as agent turns.
use super::{host::WindowHost, AgentRuntime};
use crate::app_state::AppState;
use openmind_agent::{AgentHost, Workspace};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, State};

fn read_memory(ws: &Workspace) -> Result<String, String> {
    let path = ws.resolve_for_change("OPENMIND_MEMORY.md")?;
    match std::fs::File::open(path) {
        Ok(file) => {
            let mut text = String::new();
            file.take(32_001)
                .read_to_string(&mut text)
                .map_err(|e| e.to_string())?;
            if text.len() > 32_000 {
                return Err(
                    "Project memory exceeds 32 KB. Open the file in the editor to shorten it."
                        .into(),
                );
            }
            Ok(text)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn agent_control(
    action: String,
    argument: String,
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, AppState>,
    agent: State<'_, AgentRuntime>,
) -> Result<Value, String> {
    if argument.len() > 32_000 {
        return Err("Command arguments exceed 32 KB.".into());
    }
    let folder = super::super::workspace::workspace_active_folder(window.clone(), state)
        .await?
        .ok_or("The workspace could not be opened.")?;
    let label = window.label().to_string();
    let chat = agent.chat(&label);
    let root = std::path::PathBuf::from(folder.path);
    tokio::task::spawn_blocking(move || {
        if action == "mcp_list" { return Ok(chat.mcp.snapshot()); }
        if action == "doctor" {
            return Ok(json!({"workspace":root,"projectInstructions":root.join("OPENMIND.md").is_file(),"memoryFile":root.join("OPENMIND_MEMORY.md").is_file(),"mcp":chat.mcp.snapshot(),"busy":chat.busy.load(Ordering::SeqCst)}));
        }
        if chat.busy.load(Ordering::SeqCst) { return Err("The agent is working. Stop it before changing context or project state.".into()); }
        // Claim the same busy flag as agent_send so a queued turn cannot race a file write or reset.
        if chat.busy.swap(true, Ordering::SeqCst) { return Err("The agent is busy.".into()); }
        let _busy = super::BusyGuard(std::sync::Arc::clone(&chat));
        match action.as_str() {
            "context" | "compact" => {
                let mut session = chat.session.try_lock().map_err(|_| "The model context is busy.")?;
                match session.as_mut() {
                    Some(session) if action == "compact" => session.compact_now(),
                    Some(session) => Ok(session.context_snapshot()),
                    None => Ok(json!({"started":false,"estimatedInputTokens":0,"message":"No active model context yet. Send a message first."})),
                }
            }
            "mcp_connect" => {
                let config: super::mcp::ServerConfig = serde_json::from_str(&argument).map_err(|e| e.to_string())?;
                chat.mcp.connect(config)
            }
            "mcp_remove" => { chat.mcp.remove(&argument); Ok(chat.mcp.snapshot()) }
            "memory_read" => Ok(Value::String(read_memory(&Workspace::new(&root)?)?)),
            "memory_write" | "init" => {
                let ws = Workspace::new(&root)?;
                let relative = if action == "init" { "OPENMIND.md" } else { "OPENMIND_MEMORY.md" };
                let path = ws.resolve_for_change(relative)?;
                let host = WindowHost { app, label, pending: &chat.pending, task_id: None, options: None };
                host.check_change(&path, &AtomicBool::new(false))?;
                if ws.resolve_for_change(relative)? != path { return Err("The project path changed while the editor was checking the file. Retry the command.".into()); }
                if action == "init" {
                    match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                        Ok(mut file) => file.write_all(b"# OpenMindAI project instructions\n\n## Project\nDescribe the purpose, architecture and important paths here.\n\n## Development\n- Read existing code before editing.\n- Follow the project's existing style.\n- Record the build, lint and test commands for this project.\n- Verify changes before reporting success.\n\n## Boundaries\n- Preserve unrelated work.\n- Never print secrets or credentials.\n- Respect the agent's permission policy.\n").map_err(|e|e.to_string())?,
                        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {},
                        Err(e) => return Err(e.to_string()),
                    }
                } else {
                    openmind_agent::textfile::write_bytes(&path, argument.as_bytes())?;
                }
                Ok(Value::String(path.to_string_lossy().into_owned()))
            }
            _ => Err(format!("Unknown agent control action: {action}")),
        }
    }).await.map_err(|e|e.to_string())?
}
