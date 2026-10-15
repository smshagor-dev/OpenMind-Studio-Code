//! The model list the panel shows (this PC's hardware, each Nemotron build with whether it fits and whether it is
//! downloaded) and downloading / deleting a model. Nothing is fetched unless the user presses Download.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use openmind_llm::download::{download_model, Progress};
use openmind_llm::hardware::free_disk_bytes;
use openmind_llm::{fit, recommended, Fit, Hardware, LocalModel, ModelEntry};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::AgentRuntime;
use crate::app_state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelView {
    #[serde(flatten)]
    entry: ModelEntry,
    size_bytes: u64,
    fit: Fit,
    local: LocalModel,
    downloading: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    hardware: Hardware,
    models: Vec<ModelView>,
    recommended: Option<String>,
    engine_installed: bool,
    running_model: Option<String>,
    models_dir: String,
    free_disk_bytes: Option<u64>,
}

/// Downloads in progress, by model id.
#[derive(Default)]
pub struct Downloads {
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl Downloads {
    pub fn is_running(&self, id: &str) -> bool {
        self.running
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains_key(id)
    }

    fn begin(&self, id: &str) -> Option<Arc<AtomicBool>> {
        let mut running = self.running.lock().unwrap_or_else(PoisonError::into_inner);
        if running.contains_key(id) {
            return None;
        }
        let flag = Arc::new(AtomicBool::new(false));
        running.insert(id.to_string(), Arc::clone(&flag));
        Some(flag)
    }

    fn end(&self, id: &str) {
        self.running
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(id);
    }

    pub fn cancel(&self, id: &str) {
        if let Some(flag) = self
            .running
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(id)
        {
            flag.store(true, Ordering::Relaxed);
        }
    }

    pub fn cancel_all(&self) {
        for flag in self
            .running
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
        {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadEvent {
    id: String,
    /// `progress`, `done`, `failed` or `cancelled`.
    state: &'static str,
    progress: Option<Progress>,
    message: Option<String>,
}

pub(super) fn build_overview(agent: &AgentRuntime, engine_installed: bool) -> Overview {
    let hardware = openmind_llm::detect();
    let models: Vec<ModelView> = agent
        .catalog
        .models()
        .iter()
        .map(|entry| ModelView {
            size_bytes: entry.size_bytes(),
            fit: fit(entry, &hardware),
            local: agent.store.local(entry),
            downloading: agent.downloads.is_running(&entry.id),
            entry: entry.clone(),
        })
        .collect();
    Overview {
        recommended: recommended(agent.catalog.models(), &hardware).map(|m| m.id.clone()),
        hardware,
        models,
        engine_installed,
        running_model: agent.engine.running_model(),
        models_dir: agent.store.dir().display().to_string(),
        free_disk_bytes: free_disk_bytes(agent.store.dir()),
    }
}

#[tauri::command]
pub async fn agent_overview(
    state: State<'_, AppState>,
    agent: State<'_, AgentRuntime>,
) -> Result<Overview, String> {
    let engine_installed = state.runtime.installed_dir("llamacpp").await.is_some();
    let agent = agent.inner().clone();
    tokio::task::spawn_blocking(move || build_overview(&agent, engine_installed))
        .await
        .map_err(|err| err.to_string())
}

/// Starts downloading `id` in the background; progress arrives as `agent:download` events in every window.
#[tauri::command]
pub async fn agent_model_download(
    id: String,
    app: AppHandle,
    agent: State<'_, AgentRuntime>,
) -> Result<(), String> {
    let model = agent.catalog.get(&id).map_err(|e| e.to_string())?.clone();
    openmind_llm::download::check_space(&agent.store, &model).map_err(|e| e.to_string())?;
    let cancel = agent
        .downloads
        .begin(&id)
        .ok_or_else(|| format!("{} is already being downloaded.", model.name))?;
    let agent = agent.inner().clone();
    std::thread::spawn(move || {
        let send = |state: &'static str, progress: Option<Progress>, message: Option<String>| {
            let _ = app.emit(
                "agent:download",
                DownloadEvent {
                    id: model.id.clone(),
                    state,
                    progress,
                    message,
                },
            );
        };
        let mut last = Instant::now() - Duration::from_secs(1);
        let result = download_model(&agent.store, &model, Arc::clone(&cancel), &mut |p| {
            if last.elapsed() >= Duration::from_millis(250) {
                last = Instant::now();
                send("progress", Some(p.clone()), None);
            }
        });
        agent.downloads.end(&model.id);
        match result {
            Ok(()) => send("done", None, None),
            Err(openmind_llm::LlmError::Cancelled) => send("cancelled", None, None),
            Err(err) => {
                tracing::warn!(model = %model.id, %err, "model download failed");
                send("failed", None, Some(err.to_string()));
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn agent_model_cancel(id: String, agent: State<'_, AgentRuntime>) {
    agent.downloads.cancel(&id);
}

/// Deletes a model's files (the engine is stopped first when it runs that model).
#[tauri::command]
pub async fn agent_model_delete(id: String, agent: State<'_, AgentRuntime>) -> Result<(), String> {
    let model = agent.catalog.get(&id).map_err(|e| e.to_string())?.clone();
    if agent.downloads.is_running(&id) {
        return Err(format!(
            "{} is still downloading; stop it first.",
            model.name
        ));
    }
    let agent = agent.inner().clone();
    tokio::task::spawn_blocking(move || {
        let _lease = agent.engine.lease()?;
        if agent.engine.running_model().as_deref() == Some(model.id.as_str()) {
            agent.engine.stop();
        }
        agent.store.delete(&model).map_err(|e| e.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}
