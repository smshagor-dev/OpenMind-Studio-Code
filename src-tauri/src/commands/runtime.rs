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
    if let Some(reason) = network_unsupported(state.runtime.paths(), &kind) {
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

/// Toolchains that can't work from a network share: w64devkit 1.19.0, whose GNU linker (binutils 2.40) can't open
/// files under a network (UNC) path ("Invalid argument") — also when the share is reached through a drive letter,
/// because GCC finds its own files by the network path. Measured: `gfortran hello.f90` from the share fails at the
/// link step; from a local folder it works. A network installation keeps them on each computer instead
/// (`RuntimePaths::with_local_kinds`, set up in `main.rs`).
pub(crate) const GNU_LINKED: &[&str] = &["fortran", "assembly"];

/// Why `kind` can't be installed where this copy keeps it: only a GNU-linked toolchain whose folder is on a network
/// share and not kept on this computer (a portable or per-user copy run from a share). A drive that is this
/// computer's own disk — whatever its letter — is fine.
pub(crate) fn network_unsupported(
    paths: &openmind_runtime_manager::RuntimePaths,
    kind: &str,
) -> Option<&'static str> {
    if !GNU_LINKED.contains(&kind) || paths.is_local_kind(kind) {
        return None;
    }
    let folder = paths.versions_dir(kind).ok()?;
    openmind_core::install::is_remote_path(&folder).then_some(
        "This toolchain can't be used from a network share: its GNU linker (binutils 2.40) can't open files on a \
         network (UNC) path. Install OpenMind Studio with \"Recommended for All Users\" (it keeps this toolchain on \
         each computer) or on this computer (For Me).",
    )
}

#[cfg(test)]
mod network_tests {
    use super::*;
    use openmind_runtime_manager::RuntimePaths;

    #[test]
    fn gnu_toolchains_are_refused_only_on_a_share_that_doesnt_keep_them_locally() {
        let share = RuntimePaths::new(r"\\srv\students\app\runtimes", r"\\srv\students\app\cache");
        assert!(network_unsupported(&share, "fortran").is_some());
        assert!(network_unsupported(&share, "assembly").is_some());
        for kind in ["python", "node", "php", "llvm-mingw", "jdk", "go", "pascal"] {
            assert!(network_unsupported(&share, kind).is_none(), "{kind}");
        }
        // A network installation keeps them on this computer: allowed.
        let network = share.with_local_kinds(r"C:\Users\me\AppData\Local\x\runtimes", GNU_LINKED);
        assert!(network_unsupported(&network, "assembly").is_none());
        assert!(network_unsupported(&network, "fortran").is_none());
        // A folder on this computer's own disk (any drive letter): allowed.
        let local = RuntimePaths::new(r"C:\apps\OM\runtimes", r"C:\apps\OM\cache");
        assert!(network_unsupported(&local, "assembly").is_none());
    }
}
