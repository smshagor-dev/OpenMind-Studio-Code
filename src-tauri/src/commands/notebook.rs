//! Jupyter notebooks (Milestone 19). Opening a notebook only reads it: no cell runs, no kernel starts. A kernel —
//! OpenMind's own Python cell runner — starts when the user picks a Python for it, and only one of the Pythons this
//! app found (the project's `.venv`, OpenMind's portable Python, the system's): the page can't name another program.
//! Cells run only in a notebook the user trusted, and trust belongs to exactly the content that was trusted (a file
//! changed elsewhere is untrusted again). Saving keeps what OpenMind doesn't understand and refuses to overwrite a
//! file that changed on disk since it was opened.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use openmind_db::NotebooksRepository;
use openmind_notebook::{CellEdit, CellResult, Kernel, KernelCandidate, KernelSpec, NotebookModel};
use serde::Serialize;
use tauri::State;

use crate::app_state::AppState;

const MAX_NOTEBOOK: u64 = 50 * 1024 * 1024;

/// The kernels that run, one per notebook (stopped with the app).
#[derive(Default)]
pub struct NotebookRuntime {
    kernels: Mutex<HashMap<String, Kernel>>,
}

impl NotebookRuntime {
    fn get(&self, path: &str) -> Option<Kernel> {
        self.kernels.lock().ok()?.get(&key(path)).cloned()
    }

    fn insert(&self, path: &str, kernel: Kernel) {
        if let Ok(mut kernels) = self.kernels.lock() {
            if let Some(old) = kernels.insert(key(path), kernel) {
                old.stop();
            }
        }
    }

    fn remove(&self, path: &str) -> Option<Kernel> {
        self.kernels.lock().ok()?.remove(&key(path))
    }

    /// App close: every kernel and what it started ends.
    pub fn stop_all(&self) {
        let kernels: Vec<Kernel> = match self.kernels.lock() {
            Ok(mut kernels) => kernels.drain().map(|(_, kernel)| kernel).collect(),
            Err(_) => Vec::new(),
        };
        for kernel in kernels {
            kernel.stop();
        }
    }
}

fn key(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

/// A notebook path must be an absolute `.ipynb` file.
fn checked(path: &str) -> Result<PathBuf, String> {
    let file = PathBuf::from(path);
    let is_notebook = file
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("ipynb"));
    if path.contains('\0') || !file.is_absolute() || !is_notebook {
        return Err("Not a notebook file.".into());
    }
    let meta =
        std::fs::metadata(&file).map_err(|err| format!("The notebook can't be read: {err}"))?;
    if !meta.is_file() {
        return Err("Not a notebook file.".into());
    }
    if meta.len() > MAX_NOTEBOOK {
        return Err("The notebook is larger than 50 MB and can't be opened as a notebook. Open it as text instead.".into());
    }
    Ok(file)
}

fn read(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|err| format!("The notebook can't be read: {err}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedNotebook {
    model: NotebookModel,
    fingerprint: String,
    trusted: bool,
    kernel: Option<String>,
}

async fn is_trusted(state: &AppState, path: &str, fingerprint: &str) -> bool {
    NotebooksRepository::new(state.db.pool())
        .trusted_fingerprint(&key(path))
        .await
        .ok()
        .flatten()
        .is_some_and(|trusted| trusted == fingerprint)
}

/// Reads a notebook. Nothing runs.
#[tauri::command]
pub async fn notebook_open(
    path: String,
    state: State<'_, AppState>,
) -> Result<OpenedNotebook, String> {
    let file = checked(&path)?;
    let text = read(&file)?;
    let model = openmind_notebook::load(&text).map_err(|err| err.to_string())?;
    let fingerprint = openmind_notebook::fingerprint(&text);
    Ok(OpenedNotebook {
        trusted: is_trusted(&state, &path, &fingerprint).await,
        kernel: state
            .notebooks
            .get(&path)
            .filter(Kernel::is_alive)
            .map(|k| k.interpreter().to_string()),
        model,
        fingerprint,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedNotebook {
    fingerprint: String,
}

/// Saves the cells into the notebook, keeping everything else. Refused when the file changed on disk since
/// `fingerprint` (what was opened or last saved) unless `overwrite`.
#[tauri::command]
pub async fn notebook_save(
    path: String,
    cells: Vec<CellEdit>,
    fingerprint: String,
    overwrite: bool,
    state: State<'_, AppState>,
) -> Result<SavedNotebook, String> {
    let file = checked(&path)?;
    let original = read(&file)?;
    let current = openmind_notebook::fingerprint(&original);
    if current != fingerprint && !overwrite {
        return Err("The notebook changed on disk since it was opened. Reload it, or save again to overwrite it.".into());
    }
    let was_trusted =
        is_trusted(&state, &path, &fingerprint).await || is_trusted(&state, &path, &current).await;
    let text = openmind_notebook::save(&original, &cells).map_err(|err| err.to_string())?;
    let temp = file.with_extension("ipynb.openmind-save");
    std::fs::write(&temp, &text).map_err(|err| format!("The notebook can't be saved: {err}"))?;
    std::fs::rename(&temp, &file).map_err(|err| {
        let _ = std::fs::remove_file(&temp);
        format!("The notebook can't be saved: {err}")
    })?;
    let saved = openmind_notebook::fingerprint(&text);
    if was_trusted {
        // The user's own edit keeps the trust they gave.
        let _ = NotebooksRepository::new(state.db.pool())
            .set_trust(&key(&path), Some(&saved))
            .await;
    }
    Ok(SavedNotebook { fingerprint: saved })
}

/// Trusts (or stops trusting) the notebook's current content.
#[tauri::command]
pub async fn notebook_set_trust(
    path: String,
    trusted: bool,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let file = checked(&path)?;
    let fingerprint = openmind_notebook::fingerprint(&read(&file)?);
    let repo = NotebooksRepository::new(state.db.pool());
    repo.set_trust(&key(&path), trusted.then_some(fingerprint.as_str()))
        .await
        .map_err(|err| err.to_string())?;
    if !trusted {
        if let Some(kernel) = state.notebooks.remove(&path) {
            kernel.stop();
        }
    }
    Ok(trusted)
}

async fn candidates_for(state: &AppState, window: &tauri::Window) -> Vec<KernelCandidate> {
    let workspace = crate::windows::window_workspace(state, window.label())
        .await
        .ok()
        .flatten()
        .map(|w| PathBuf::from(w.path));
    let runtime = crate::commands::run::environment(state).await;
    openmind_notebook::candidates(
        workspace.as_deref(),
        &runtime.path_prepend,
        std::env::var_os("PATH"),
    )
}

/// The Pythons that can run this notebook's cells (nothing starts).
#[tauri::command]
pub async fn notebook_kernels(
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<Vec<KernelCandidate>, String> {
    Ok(candidates_for(&state, &window).await)
}

/// Starts OpenMind's Python runner for the notebook with `interpreter` (one of `notebook_kernels`).
#[tauri::command]
pub async fn notebook_kernel_start(
    path: String,
    interpreter: String,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let file = checked(&path)?;
    let candidate = candidates_for(&state, &window)
        .await
        .into_iter()
        .find(|c| c.interpreter == interpreter)
        .ok_or("That Python is not one OpenMind found. Pick one from the list.")?;
    let runtime = crate::commands::run::environment(&state).await;
    let spec = KernelSpec {
        interpreter: PathBuf::from(&candidate.interpreter),
        cwd: file
            .parent()
            .map_or_else(|| state.app_root.clone(), Path::to_path_buf),
        runner_dir: state.app_root.join("cache").join("notebook"),
        path_prepend: runtime.path_prepend,
        vars: runtime.vars,
    };
    let kernel = tokio::task::spawn_blocking(move || Kernel::start(&spec))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())?;
    state.notebooks.insert(&path, kernel);
    tracing::info!("notebook kernel started by the user");
    Ok(candidate.label)
}

/// Stops the notebook's kernel (its variables are lost).
#[tauri::command]
pub fn notebook_kernel_stop(path: String, state: State<'_, AppState>) {
    if let Some(kernel) = state.notebooks.remove(&path) {
        kernel.stop();
    }
}

/// Runs one cell's code on the notebook's kernel (the notebook must be trusted).
#[tauri::command]
pub async fn notebook_execute(
    path: String,
    cell_index: u32,
    code: String,
    fingerprint: String,
    state: State<'_, AppState>,
) -> Result<CellResult, String> {
    checked(&path)?;
    if !is_trusted(&state, &path, &fingerprint).await {
        return Err("Trust this notebook before running its cells.".into());
    }
    let kernel = state
        .notebooks
        .get(&path)
        .filter(Kernel::is_alive)
        .ok_or("Kernel not configured. Select a kernel first (Install/configure Python from Runtime Manager).")?;
    let interpreter = kernel.interpreter().to_string();
    let started = Instant::now();
    let result = tokio::task::spawn_blocking(move || kernel.execute(&code))
        .await
        .map_err(|err| err.to_string())?;
    let duration = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let status = match &result {
        Ok(cell) if cell.ok => "ok",
        Ok(_) => "error",
        Err(_) => "stopped",
    };
    let _ = NotebooksRepository::new(state.db.pool())
        .add_run(&key(&path), cell_index, status, duration, &interpreter)
        .await;
    result.map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_existing_absolute_ipynb_files_are_notebooks() {
        let dir = tempfile::tempdir().expect("tempdir");
        let notebook = dir.path().join("My Notes.ipynb");
        std::fs::write(&notebook, "{}").expect("file");
        let text = dir.path().join("notes.txt");
        std::fs::write(&text, "x").expect("file");
        assert!(checked(&notebook.display().to_string()).is_ok());
        assert!(checked(&text.display().to_string()).is_err());
        assert!(checked("relative.ipynb").is_err());
        assert!(checked(&dir.path().join("gone.ipynb").display().to_string()).is_err());
        assert!(checked(&format!("{}\0.ipynb", dir.path().display())).is_err());
        assert_eq!(key(r"C:\W\N.ipynb"), key("c:/w/n.ipynb"));
    }

    #[test]
    fn a_stopped_runtime_has_no_kernels_left() {
        let runtime = NotebookRuntime::default();
        runtime.stop_all();
        assert!(runtime.get("C:/n.ipynb").is_none());
    }
}
