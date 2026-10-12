use openmind_runtime_manager::{InstallProgress, InstalledVersion};
use tauri::{AppHandle, Emitter, State};

use crate::sync::{announce_now, Topic};

use crate::app_state::AppState;
use crate::commands::php::php_in_use_reason;

const PROGRESS_EVENT: &str = "runtime:progress";
/// After any install/repair/switch/delete the canonical state holds the new list before the command returns, and
/// every window follows it (`crate::state`, `crate::sync`).
pub(crate) async fn notify_changed(app: &AppHandle) {
    announce_now(app, Topic::Runtimes).await;
}

// Every error is returned as `user_message()`: what went wrong plus what to
// do about it, so the UI never has to invent recovery advice.

#[tauri::command]
pub async fn runtime_install(
    kind: String,
    version: Option<String>,
    accept_license: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<InstalledVersion, String> {
    // A vendor licence that must be accepted (Android SDK) is checked here too, not only in the UI.
    if let Some(reason) = state
        .runtime
        .registry()
        .get(&kind)
        .ok()
        .and_then(|manifest| manifest.license_blocker(accept_license.unwrap_or(false)))
    {
        return Err(reason);
    }
    if let Some(reason) = network_unsupported(state.paths.layout, &kind) {
        return Err(reason.into());
    }
    let result = state
        .runtime
        .install(&kind, version.as_deref(), progress_sink(app.clone()))
        .await
        .map_err(|err| err.user_message());
    // A new portable Python gets OpenMind's bundled packages and Tcl/Tk at once (offline; that install only). A failure
    // is logged and shown on the version's "Bundled packages" line; Python itself stays installed.
    if let Ok(installed) = &result {
        if kind == "python" {
            if let Err(err) = crate::commands::python_packages::install_into(
                &state,
                &installed.version,
                progress_sink(app.clone()),
            )
            .await
            {
                tracing::warn!(version = %installed.version, error = %err, "bundled Python packages");
            }
        }
    }
    // A new Assembly toolchain is complete for the chosen architecture: x86 gets its 32-bit part in the same click.
    let result = match result {
        Ok(installed) if kind == "assembly" => {
            crate::commands::assembly::after_install(&state, &installed, progress_sink(app.clone()))
                .await
                .map(|()| installed)
        }
        other => other,
    };
    // A new MariaDB gets its database at once (root / root, test-started and stopped), so MySQL > Start just works. An
    // existing database is never touched. A failure leaves MariaDB installed and is reported; MySQL > Start retries it.
    let result = match result {
        Ok(installed) if kind == "mariadb" => {
            match crate::commands::mysql::after_install(&app, &state).await {
                Ok(()) => Ok(installed),
                Err(err) => Err(format!(
                    "MariaDB {} was installed, but its database couldn't be set up: {err} Starting MySQL tries again.",
                    installed.version
                )),
            }
        }
        other => other,
    };
    notify_changed(&app).await;
    result
}

/// Adds an optional part to an installed version (Tcl/Tk for Python 3.14.7): a pinned, checksum-verified download
/// whose files go into that install only. Nothing starts until the user asks for it.
#[tauri::command]
pub async fn runtime_addon_install(
    kind: String,
    version: String,
    addon: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let result = state
        .runtime
        .install_addon(&kind, &version, &addon, progress_sink(app.clone()))
        .await
        .map_err(|err| {
            tracing::warn!(%kind, %version, %addon, error = %err, "runtime add-on install failed");
            err.user_message()
        });
    notify_changed(&app).await;
    result
}

/// Removes exactly the files an add-on added.
#[tauri::command]
pub async fn runtime_addon_remove(
    kind: String,
    version: String,
    addon: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let result = state
        .runtime
        .remove_addon(&kind, &version, &addon)
        .await
        .map_err(|err| {
            tracing::warn!(%kind, %version, %addon, error = %err, "runtime add-on removal failed");
            err.user_message()
        });
    notify_changed(&app).await;
    result
}

#[tauri::command]
pub async fn runtime_repair(
    kind: String,
    version: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    if let Some(reason) = php_in_use_reason(&state, &kind, &version) {
        return Err(reason);
    }
    let result = state
        .runtime
        .repair(&kind, &version, progress_sink(app.clone()))
        .await
        .map_err(|err| err.user_message());
    notify_changed(&app).await;
    result
}

#[tauri::command]
pub async fn runtime_set_active(
    kind: String,
    version: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let result = state
        .runtime
        .set_active(&kind, &version)
        .await
        .map_err(|err| err.user_message());
    notify_changed(&app).await;
    result
}

#[tauri::command]
pub async fn runtime_delete(
    kind: String,
    version: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if let Some(reason) = php_in_use_reason(&state, &kind, &version) {
        return Err(reason);
    }
    let result = state
        .runtime
        .delete(&kind, &version)
        .await
        .map_err(|err| err.user_message());
    notify_changed(&app).await;
    result
}

pub(crate) fn progress_sink(app: AppHandle) -> openmind_runtime_manager::manager::ProgressSink {
    std::sync::Arc::new(move |progress: InstallProgress| {
        if let Err(err) = app.emit(PROGRESS_EVENT, progress) {
            tracing::error!(?err, "failed to emit runtime progress event");
        }
    })
}

/// Runtimes that can't work from a network share, with the reason. The Fortran and Assembly toolchains are w64devkit
/// 1.19.0, whose GNU linker (binutils 2.40) can't open files under a network (UNC) path ("Invalid argument") — also
/// when the share is reached through a drive letter, because GCC finds its own files by the network path. Measured:
/// `gfortran hello.f90` from the share fails at the link step; from a local folder it works. Refused in a network
/// installation instead of installing a toolchain that can't build anything.
pub(crate) fn network_unsupported(
    layout: openmind_core::InstallLayout,
    kind: &str,
) -> Option<&'static str> {
    if layout != openmind_core::InstallLayout::Network {
        return None;
    }
    match kind {
        "fortran" | "assembly" => Some(
            "This toolchain can't be used from a network share: its GNU linker (binutils 2.40) can't open files on a \
             network (UNC) path. Install OpenMind Studio on this computer (For Me) to use it here.",
        ),
        _ => None,
    }
}

#[cfg(test)]
mod network_tests {
    use super::*;
    use openmind_core::InstallLayout;

    #[test]
    fn gnu_toolchains_are_refused_only_in_a_network_installation() {
        assert!(network_unsupported(InstallLayout::Network, "fortran").is_some());
        assert!(network_unsupported(InstallLayout::Network, "assembly").is_some());
        for kind in [
            "python",
            "node",
            "php",
            "composer",
            "llvm-mingw",
            "jdk",
            "go",
            "pascal",
        ] {
            assert!(
                network_unsupported(InstallLayout::Network, kind).is_none(),
                "{kind}"
            );
        }
        for layout in [
            InstallLayout::Portable,
            InstallLayout::PerUser,
            InstallLayout::PerMachine,
        ] {
            assert!(network_unsupported(layout, "fortran").is_none());
        }
    }
}
