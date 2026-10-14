//! Network Deployment for the window (Help > Network Deployment): this copy's facts, offering it on the LAN, searching,
//! the Network Deployment Test and provisioning this computer from a found deployment. The work is `crate::deploy`'s;
//! every blocking step (sockets, downloads, the setup) runs off the async runtime.

use std::path::PathBuf;

use openmind_deploy::advert::PackageKind;
use openmind_deploy::discover::Options;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::app_state::AppState;
use crate::deploy::checks::TestReport;
use crate::deploy::exec::{self, Outcome, Request};
use crate::deploy::local::ThisCopy;
use crate::deploy::service::{DeployService, DeploymentView, OfferView, SearchView};

/// The setting that offers this computer's installation on the LAN.
pub const OFFER_SETTING: &str = "deployment.advertiseOnLan";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployStatus {
    pub copy: ThisCopy,
    pub offer: OfferView,
    pub deployments: Vec<DeploymentView>,
    pub last_search: Option<SearchView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub search: SearchView,
    pub deployments: Vec<DeploymentView>,
}

fn copy_of(state: &AppState) -> ThisCopy {
    ThisCopy::from_paths(&state.paths)
}

/// Addresses typed by the user (`host` or `host:port`), resolved; a bad one is an error naming it.
fn targets(typed: &[String]) -> Result<Vec<std::net::SocketAddr>, String> {
    use std::net::ToSocketAddrs;
    typed
        .iter()
        .map(|text| text.trim())
        .filter(|text| !text.is_empty())
        .map(|text| {
            let with_port = if text.contains(':') {
                text.to_string()
            } else {
                format!("{text}:{}", openmind_deploy::DISCOVERY_PORT)
            };
            with_port
                .to_socket_addrs()
                .map_err(|err| format!("{text}: {err}"))?
                .find(std::net::SocketAddr::is_ipv4)
                .ok_or_else(|| format!("{text} has no IPv4 address"))
        })
        .collect()
}

async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(job)
        .await
        .map_err(|err| format!("the deployment task stopped unexpectedly: {err}"))
}

#[tauri::command]
pub async fn deploy_status(
    state: State<'_, AppState>,
    service: State<'_, DeployService>,
) -> Result<DeployStatus, String> {
    let copy = copy_of(&state);
    Ok(DeployStatus {
        offer: service.offer(),
        deployments: service.deployments(&copy),
        last_search: service.last_search(),
        copy,
    })
}

/// Applies `deployment.advertiseOnLan` as it is now (called at start-up and when the setting changes).
#[tauri::command]
pub async fn deploy_apply_offering(app: AppHandle) -> Result<OfferView, String> {
    blocking(move || apply_offering(&app)).await
}

fn apply_offering(app: &AppHandle) -> OfferView {
    let state = app.state::<AppState>();
    let on = crate::commands::preferences::user_bool(&state, OFFER_SETTING);
    let copy = copy_of(&state);
    app.state::<DeployService>()
        .set_offering(&copy, on, openmind_deploy::DISCOVERY_PORT)
}

/// At start-up: offer this installation only when the user turned it on (nothing is sent; a socket is opened).
pub fn apply_offering_at_start(app: &AppHandle) {
    let state = app.state::<AppState>();
    if !crate::commands::preferences::user_bool(&state, OFFER_SETTING) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let view = apply_offering(&app);
        tracing::info!(on = view.on, error = ?view.error, "deployment offer at start-up");
    });
}

#[tauri::command]
pub async fn deploy_search(
    targets_typed: Vec<String>,
    app: AppHandle,
) -> Result<SearchResult, String> {
    let options = Options {
        targets: targets(&targets_typed)?,
        ..Options::default()
    };
    blocking(move || {
        let copy = copy_of(&app.state::<AppState>());
        let (search, deployments) = app.state::<DeployService>().search(&options, &copy);
        SearchResult {
            search,
            deployments,
        }
    })
    .await
}

#[tauri::command]
pub async fn deploy_test(
    targets_typed: Vec<String>,
    download_package: bool,
    app: AppHandle,
) -> Result<TestReport, String> {
    let options = Options {
        targets: targets(&targets_typed)?,
        ..Options::default()
    };
    let verifier = crate::deploy::release_verifier()?;
    blocking(move || {
        let copy = copy_of(&app.state::<AppState>());
        crate::deploy::checks::run(
            &copy,
            &app.state::<DeployService>(),
            &options,
            download_package,
            &verifier,
        )
    })
    .await
}

/// Provisions this computer from a found deployment: `kind` is `share` (only a shortcut), `setup` or `portable`.
#[tauri::command]
pub async fn deploy_provision(
    id: String,
    kind: String,
    destination: Option<String>,
    app: AppHandle,
) -> Result<Outcome, String> {
    let kind = match kind.as_str() {
        "share" => None,
        "setup" => Some(PackageKind::Installer),
        "portable" => Some(PackageKind::Portable),
        other => return Err(format!("unknown provisioning kind {other}")),
    };
    let destination = destination
        .map(|text| PathBuf::from(text.trim()))
        .filter(|path| !path.as_os_str().is_empty());
    let (manifest, source) = app.state::<DeployService>().provisioning_source(&id)?;
    let outcome = blocking({
        let app = app.clone();
        move || {
            let copy = copy_of(&app.state::<AppState>());
            crate::deploy::live::with_live_effects(&copy, true, |effects| {
                exec::provision(
                    &Request {
                        manifest,
                        source,
                        kind,
                        destination,
                    },
                    effects,
                )
            })
        }
    })
    .await???;
    app.state::<DeployService>().allow_launch(&outcome.program);
    Ok(outcome)
}

/// Trusts a found deployment on this computer (the user confirmed it in the dialog).
#[tauri::command]
pub async fn deploy_trust(
    id: String,
    state: State<'_, AppState>,
    service: State<'_, DeployService>,
) -> Result<(), String> {
    let (manifest, _) = service.provisioning_source(&id)?;
    crate::deploy::trust::TrustStore::in_dir(&copy_of(&state).data_root)
        .trust(&manifest)
        .map_err(|err| format!("The trust record couldn't be saved: {err}"))
}

/// Starts a provisioned copy (on the user's click).
#[tauri::command]
pub async fn deploy_launch(
    program: String,
    service: State<'_, DeployService>,
) -> Result<(), String> {
    let program = PathBuf::from(program);
    // Only a copy this session provisioned: the page can't make this start any other program.
    if !service.may_launch(&program) {
        return Err("Only the OpenMind Studio copy set up here can be started from here.".into());
    }
    std::process::Command::new(&program)
        .current_dir(program.parent().unwrap_or(&program))
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("{} couldn't be started: {err}", program.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_addresses_get_the_discovery_port_and_bad_ones_are_named() {
        let resolved =
            targets(&["127.0.0.1".into(), " ".into(), "127.0.0.1:5000".into()]).expect("ok");
        assert_eq!(resolved.len(), 2);
        assert_eq!(resolved[0].port(), openmind_deploy::DISCOVERY_PORT);
        assert_eq!(resolved[1].port(), 5000);
        let error = targets(&["no such host.invalid".into()]).expect_err("bad");
        assert!(error.contains("no such host.invalid"), "{error}");
    }
}
