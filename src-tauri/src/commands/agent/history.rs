//! Agent history has its own SQLite file; it never mixes structured entries into provider chat history.
use super::AgentRuntime;
use openmind_ai::{Conversation, ConversationStore, ConversationSummary};
use tauri::State;

fn store(agent: &AgentRuntime) -> Result<ConversationStore, String> {
    ConversationStore::open(
        &agent
            .logs_dir
            .with_file_name("agent")
            .join("history.sqlite"),
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn agent_history_list(
    agent: State<'_, AgentRuntime>,
) -> Result<Vec<ConversationSummary>, String> {
    let agent = agent.inner().clone();
    tokio::task::spawn_blocking(move || store(&agent)?.list(200).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn agent_history_load(
    id: String,
    agent: State<'_, AgentRuntime>,
) -> Result<Option<Conversation>, String> {
    let agent = agent.inner().clone();
    tokio::task::spawn_blocking(move || store(&agent)?.load(&id).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn agent_history_save(
    conversation: Conversation,
    agent: State<'_, AgentRuntime>,
) -> Result<(), String> {
    if conversation.model != "agent-v1"
        || conversation.provider_id.len() > 4096
        || conversation
            .messages
            .iter()
            .map(|m| m.content.len())
            .sum::<usize>()
            > 32 * 1024 * 1024
    {
        return Err("Invalid agent history format".into());
    }
    let agent = agent.inner().clone();
    tokio::task::spawn_blocking(move || {
        store(&agent)?
            .save(&conversation)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn agent_history_delete(
    id: String,
    agent: State<'_, AgentRuntime>,
) -> Result<bool, String> {
    let agent = agent.inner().clone();
    tokio::task::spawn_blocking(move || store(&agent)?.delete(&id).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}
