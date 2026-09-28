//! A component's honest status on this computer, from the facts the app gathered (nothing is run or downloaded).

use std::collections::HashMap;

use serde::Serialize;

use crate::catalog::{Component, Provision};

/// An install of 700 MB or more is an optional heavy SDK (it is still installable).
pub const HEAVY_INSTALL_BYTES: u64 = 700 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Installed,
    Available,
    HeavySdk,
    ExternalRequired,
    ManualInstall,
    AdminRequired,
    UnsupportedArchitecture,
    Planned,
}

impl State {
    /// OpenMind can install it from here.
    pub fn installable(self) -> bool {
        matches!(self, State::Available | State::HeavySdk)
    }
}

/// What the Runtime Manager knows about one runtime.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RuntimeFact {
    /// The active installed version.
    pub installed: Option<String>,
    /// There is a download for this computer's platform.
    pub available: bool,
    pub default_version: String,
    pub download_bytes: Option<u64>,
    pub install_bytes: Option<u64>,
    pub license_acceptance: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LspFact {
    /// The offline bundle carries it (unpacked on first use).
    pub bundled: bool,
    pub installed: bool,
}

/// Everything status resolution needs, gathered by the app.
#[derive(Debug, Clone, Default)]
pub struct Facts {
    pub runtimes: HashMap<String, RuntimeFact>,
    pub lsp: HashMap<String, LspFact>,
    /// Tool id -> where it was found on this computer.
    pub found: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentStatus {
    pub id: String,
    pub state: State,
    pub version: Option<String>,
    /// Where it comes from: `runtime`, `bundle`, `languageTools`, `project`, `openmind`, `system`, `external`, `planned`.
    pub source: String,
    /// The Runtime Manager runtime that installs it.
    pub runtime: Option<String>,
    /// A copy found on this computer.
    pub found: Option<String>,
    pub download_bytes: Option<u64>,
    pub install_bytes: Option<u64>,
    /// Why it can't simply be installed from here (English; the UI shows it).
    pub reason: Option<String>,
    /// The command to add it to a project.
    pub command: Option<String>,
    pub license_acceptance: bool,
}

fn base(component: &Component, state: State, source: &str, facts: &Facts) -> ComponentStatus {
    ComponentStatus {
        id: component.id.to_string(),
        state,
        version: None,
        source: source.to_string(),
        runtime: None,
        found: component
            .detect
            .and_then(|tool| facts.found.get(tool).cloned()),
        download_bytes: None,
        install_bytes: None,
        reason: (!component.note.is_empty()).then(|| component.note.to_string()),
        command: None,
        license_acceptance: false,
    }
}

fn from_runtime(component: &Component, id: &str, facts: &Facts) -> ComponentStatus {
    let Some(fact) = facts.runtimes.get(id) else {
        let mut status = base(component, State::Planned, "planned", facts);
        status.reason = Some("This build has no download for it yet.".to_string());
        return status;
    };
    let state = if fact.installed.is_some() {
        State::Installed
    } else if !fact.available {
        State::UnsupportedArchitecture
    } else if fact
        .install_bytes
        .is_some_and(|bytes| bytes >= HEAVY_INSTALL_BYTES)
    {
        State::HeavySdk
    } else {
        State::Available
    };
    let mut status = base(component, state, "runtime", facts);
    status.runtime = Some(id.to_string());
    status.version = fact
        .installed
        .clone()
        .or_else(|| Some(fact.default_version.clone()));
    status.download_bytes = fact.download_bytes;
    status.install_bytes = fact.install_bytes;
    status.license_acceptance = fact.license_acceptance;
    if state == State::UnsupportedArchitecture {
        status.reason = Some("There is no download for this computer's platform.".to_string());
    }
    status
}

/// The status of `component` given `facts`.
pub fn resolve(component: &Component, facts: &Facts) -> ComponentStatus {
    match component.provision {
        Provision::Runtime { id } => from_runtime(component, id, facts),
        Provision::IncludedWith { runtime } => {
            let mut status = from_runtime(component, runtime, facts);
            status.reason = Some(component.note.to_string());
            status
        }
        Provision::LspBundled { server } => {
            let fact = facts.lsp.get(server).copied().unwrap_or_default();
            if fact.bundled || fact.installed {
                let mut status = base(
                    component,
                    State::Installed,
                    if fact.bundled {
                        "bundle"
                    } else {
                        "languageTools"
                    },
                    facts,
                );
                status.reason = None;
                status
            } else {
                let mut status = base(component, State::ManualInstall, "languageTools", facts);
                status.reason = Some("This copy of OpenMind has no offline language server bundle: install it from Language Tools.".to_string());
                status
            }
        }
        Provision::LspOnRequest { server } => {
            let installed = facts.lsp.get(server).is_some_and(|fact| fact.installed);
            base(
                component,
                if installed {
                    State::Installed
                } else {
                    State::ManualInstall
                },
                "languageTools",
                facts,
            )
        }
        Provision::Project { command } => {
            let mut status = base(component, State::ManualInstall, "project", facts);
            if status.found.is_some() {
                status.state = State::Installed;
                status.source = "system".to_string();
            }
            status.command = Some(command.to_string());
            status.reason = Some("Added to a project with its own package manager; OpenMind shows the command and never runs it for you.".to_string());
            status
        }
        Provision::BuiltIn => base(component, State::Installed, "openmind", facts),
        Provision::External { admin } => {
            let mut status = base(
                component,
                if admin {
                    State::AdminRequired
                } else {
                    State::ExternalRequired
                },
                "external",
                facts,
            );
            if status.found.is_some() {
                status.state = State::Installed;
                status.source = "system".to_string();
            }
            status
        }
        Provision::Planned => base(component, State::Planned, "planned", facts),
    }
}

/// What a framework still needs: the components that are neither installed by OpenMind nor found on this computer
/// (empty = ready).
pub fn framework_missing(
    needs: &[&str],
    statuses: &HashMap<String, ComponentStatus>,
) -> Vec<String> {
    needs
        .iter()
        .filter(|id| {
            statuses
                .get(**id)
                .is_none_or(|status| status.state != State::Installed && status.found.is_none())
        })
        .map(|id| (*id).to_string())
        .collect()
}
