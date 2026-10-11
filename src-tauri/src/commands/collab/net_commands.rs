//! The network commands (Milestone 24, phase 4): the minimum a future collaboration UI needs. States and problems
//! arrive as `collab:net` events; `collab_net_status` answers a window that opens later.

use openmind_collab::protocol::Body;
use tauri::{AppHandle, State};

use super::net::{self, NetStatus};
use super::net_join::{self, JoinedRoom};
use super::net_manage::JoinError;
use super::net_remote::{self, RemoteFile, RemoteTreeView};
use crate::app_state::AppState;
use crate::commands::preferences::user_string;
use crate::state::Domain;

fn resolve_display_name(state: &AppState, given: Option<String>) -> Result<String, String> {
    let name = given
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| user_string(state, "collaboration.displayName"));
    if name.trim().is_empty() {
        return Err(
            "Set your display name first (Settings > Collaboration > Display Name).".into(),
        );
    }
    Ok(name)
}

/// Makes a room this machine hosts reachable through the signaling relay. The room's folder must be the one open in
/// this window: its existing file watcher is what keeps participants' trees current.
#[tauri::command]
pub async fn collab_host_start(
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, AppState>,
    room_uid: String,
) -> Result<(), String> {
    let folder = crate::windows::window_workspace(&state, window.label())
        .await?
        .ok_or("Open the room's folder in this window to host it.")?;
    let sharing = state
        .collab
        .rooms_sharing(std::path::Path::new(&folder.path))
        .await;
    state
        .collab
        .topic(&state.db, &room_uid, super::now_ms())
        .await?;
    let sharing = if sharing.contains(&room_uid) {
        sharing
    } else {
        state
            .collab
            .rooms_sharing(std::path::Path::new(&folder.path))
            .await
    };
    if !sharing.contains(&room_uid) {
        return Err("Open the room's folder in this window to host it.".into());
    }
    state
        .collab
        .refresh_share(&state.db, &room_uid, Vec::new(), super::now_ms())
        .await?;
    net::host(&app, &state, &room_uid).await
}

/// Stops hosting a room on the network (connected participants are disconnected). The call ends with it: nobody can
/// still be in it, and a call kept from before would block the next one (and the voice mode) once hosting resumes.
#[tauri::command]
pub async fn collab_host_stop(
    app: AppHandle,
    state: State<'_, AppState>,
    room_uid: String,
) -> Result<(), String> {
    state.collab.net.stop_host(&room_uid);
    if state.collab.voice_reset(&room_uid).await {
        super::net_voice::broadcast(&app, &room_uid).await;
    }
    Ok(())
}

/// Joins a room with its Room Code: on the local network when the Owner is found there (or at `lan_address`, an
/// `ip:port` typed in when discovery is blocked — the Room Code is still required), else through the signaling server.
#[tauri::command]
pub async fn collab_join(
    app: AppHandle,
    state: State<'_, AppState>,
    code: String,
    display_name: Option<String>,
    lan_address: Option<String>,
) -> Result<JoinedRoom, JoinError> {
    let name = resolve_display_name(&state, display_name)
        .map_err(|e| JoinError::new("noDisplayName", e))?;
    net_join::join(&app, &state, Some(code), None, name, lan_address).await
}

/// Reconnects to a room joined before (key-based; the Owner's key must be the one pinned at the first join).
#[tauri::command]
pub async fn collab_rejoin(
    app: AppHandle,
    state: State<'_, AppState>,
    room_uid: String,
    display_name: Option<String>,
    lan_address: Option<String>,
) -> Result<JoinedRoom, JoinError> {
    if state.collab.net.joined(&room_uid).is_some() {
        return Err(JoinError::new(
            "alreadyJoined",
            "You are already connected to this room.",
        ));
    }
    let name = resolve_display_name(&state, display_name)
        .map_err(|e| JoinError::new("noDisplayName", e))?;
    net_join::join(&app, &state, None, Some(room_uid), name, lan_address).await
}

/// Leaves a joined room (tells the Owner, then closes the connection).
#[tauri::command]
pub async fn collab_leave(
    app: AppHandle,
    state: State<'_, AppState>,
    room_uid: String,
) -> Result<(), String> {
    let sender = state
        .collab
        .net
        .forget_joined(&room_uid)
        .ok_or("You aren't connected to this room.")?;
    let _ = sender.send(Body::Leave);
    sender.close();
    crate::state::refresh_soon(&app, &[Domain::Collaboration]);
    Ok(())
}

/// The shared tree of a joined room (participant side).
#[tauri::command]
pub fn collab_remote_tree(
    state: State<'_, AppState>,
    room_uid: String,
) -> Result<RemoteTreeView, String> {
    net_remote::tree(&state, &room_uid)
}

/// Fetches one shared file (chunked, verified); text comes back decoded, binary files are reported as such.
#[tauri::command]
pub async fn collab_remote_open(
    state: State<'_, AppState>,
    room_uid: String,
    file_id: String,
) -> Result<RemoteFile, String> {
    net_remote::open(&state, &room_uid, &file_id).await
}

/// Stops fetching a file (its tab closed before it arrived).
#[tauri::command]
pub fn collab_remote_cancel(
    state: State<'_, AppState>,
    room_uid: String,
    file_id: String,
) -> Result<(), String> {
    let remote = state
        .collab
        .net
        .remote(&room_uid)
        .ok_or("You aren't connected to this room.")?;
    let id = openmind_collab::FileId::parse(&file_id).map_err(|e| e.to_string())?;
    remote.cancel(&id);
    Ok(())
}

/// Asks the Owner for the shared tree again.
#[tauri::command]
pub fn collab_remote_refresh(state: State<'_, AppState>, room_uid: String) -> Result<(), String> {
    let remote = state
        .collab
        .net
        .remote(&room_uid)
        .ok_or("You aren't connected to this room.")?;
    remote.request_manifest();
    Ok(())
}

/// The local-network state: whether it is on, the interfaces used, each hosted room's rendezvous and announcements,
/// and what the latest join found and tried (with a failure category a page can explain).
#[tauri::command]
pub async fn collab_net_diagnostics(
    state: State<'_, AppState>,
) -> Result<super::net::NetDiagnostics, String> {
    let lan = crate::commands::preferences::user_bool(&state, "collaboration.localNetwork");
    let signaling = super::read_config(&state).signaling_url.is_some();
    let turn = super::turn_login::diagnostics(&state).await;
    Ok(state.collab.net.diagnostics(lan, signaling, turn))
}

/// Which rooms are on the network now and their connection states.
#[tauri::command]
pub fn collab_net_status(state: State<'_, AppState>) -> NetStatus {
    state.collab.net.status()
}
