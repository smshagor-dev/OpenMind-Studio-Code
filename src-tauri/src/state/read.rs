//! Reads one domain the same way its own command does, so the canonical state and the commands never disagree.
//! Called outside the store's lock; each reader does its own file reads (on blocking threads where they already did).
//! `None` means "can't tell right now": the last known state stays (a failing `git status` never empties Git).

use std::path::Path;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::Domain;
use crate::app_state::AppState;

fn value<T: Serialize>(domain: Domain, data: &T) -> Option<Value> {
    match serde_json::to_value(data) {
        Ok(value) => Some(value),
        Err(err) => {
            tracing::warn!(?domain, %err, "a domain's state couldn't be serialized");
            None
        }
    }
}

fn kept<T>(domain: Domain, result: Result<T, String>) -> Option<T> {
    result
        .map_err(|err| tracing::warn!(?domain, %err, "a domain couldn't be read now; its last state stays"))
        .ok()
}

/// A global domain's current state.
pub async fn read(app: &AppHandle, domain: Domain) -> Option<Value> {
    let state = app.try_state::<AppState>()?;
    match domain {
        Domain::Runtimes => {
            let runtimes = kept(
                domain,
                state.runtime.list().await.map_err(|err| err.to_string()),
            )?;
            value(domain, &runtimes)
        }
        Domain::Tools => {
            let packs = kept(
                domain,
                crate::commands::toolchains::packs_checked(&state).await,
            )?;
            value(domain, &packs)
        }
        Domain::LanguageServers => value(domain, &crate::commands::lsp::snapshot(&state).await),
        Domain::Extensions => {
            let extensions = kept(
                domain,
                crate::commands::extensions::snapshot_checked(&state).await,
            )?;
            value(domain, &extensions)
        }
        Domain::Servers => value(domain, &super::servers::read(&state).await),
        // A marker, changed by `StateStore::bump_packages`; there is nothing to read.
        Domain::Packages => None,
        Domain::Git | Domain::Dependencies | Domain::Project | Domain::Debug => None,
    }
}

/// A per-workspace domain's current state for the folder `root`.
pub async fn read_scoped(app: &AppHandle, domain: Domain, root: &Path) -> Option<Value> {
    let state = app.try_state::<AppState>()?;
    let root = root.to_path_buf();
    match domain {
        Domain::Git => {
            let git = kept(
                domain,
                crate::commands::git::snapshot_at(app, &state, Some(root)).await,
            )?;
            value(domain, &git)
        }
        Domain::Dependencies => {
            let deps = kept(domain, crate::commands::deps::scan_at(&state, root).await)?;
            value(domain, &deps)
        }
        Domain::Project => {
            let status = kept(
                domain,
                crate::commands::language::status_at(&state, root).await,
            )?;
            value(domain, &status)
        }
        Domain::Debug => value(
            domain,
            &crate::commands::debug::readiness_at(&state, Some(&root)).await,
        ),
        _ => None,
    }
}
