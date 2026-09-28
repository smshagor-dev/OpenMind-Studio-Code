//! A selection of workloads and components turned into what would be installed: the runtimes in dependency order,
//! the total sizes, and a warning for everything that isn't a plain app-local install.

use std::collections::{BTreeSet, HashMap};

use serde::{Deserialize, Serialize};

use crate::catalog::{component, workload, Provision};
use crate::status::{resolve, ComponentStatus, Facts, State};

/// What the user picked. `remove` wins over workloads and dependencies (a removed dependency is only warned about).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    #[serde(default)]
    pub workloads: Vec<String>,
    #[serde(default)]
    pub add: Vec<String>,
    #[serde(default)]
    pub remove: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WarningKind {
    HeavySdk,
    ExternalRequired,
    AdminRequired,
    ManualInstall,
    Planned,
    UnsupportedArchitecture,
    LicenseAcceptance,
    DependencyAdded,
    MissingDependency,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Warning {
    pub kind: WarningKind,
    pub component: String,
    /// For dependencies: the component that needs it.
    pub needed_by: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    /// Every selected component (after workloads, additions, removals and dependencies), dependencies first.
    pub components: Vec<String>,
    /// Runtime Manager runtimes to install, dependencies first; already installed ones are left out.
    pub install: Vec<String>,
    pub download_bytes: u64,
    pub install_bytes: u64,
    /// Runtimes to install whose size isn't known.
    pub unknown_sizes: usize,
    /// Runtimes whose vendor licence must be accepted first.
    pub licenses: Vec<String>,
    pub warnings: Vec<Warning>,
}

/// The runtime a component installs through, if OpenMind installs it.
fn runtime_of(id: &str) -> Option<&'static str> {
    match component(id)?.provision {
        Provision::Runtime { id } | Provision::IncludedWith { runtime: id } => Some(id),
        _ => None,
    }
}

fn add_with_requirements(
    id: &str,
    removed: &BTreeSet<String>,
    chosen: &mut Vec<String>,
    warnings: &mut Vec<Warning>,
    needed_by: Option<&str>,
) {
    if chosen.iter().any(|c| c == id) {
        return;
    }
    let Some(entry) = component(id) else {
        return;
    };
    if removed.contains(id) {
        if let Some(parent) = needed_by {
            warnings.push(Warning {
                kind: WarningKind::MissingDependency,
                component: id.to_string(),
                needed_by: Some(parent.to_string()),
            });
        }
        return;
    }
    for required in entry.requires {
        add_with_requirements(required, removed, chosen, warnings, Some(id));
    }
    if let Some(parent) = needed_by {
        warnings.push(Warning {
            kind: WarningKind::DependencyAdded,
            component: id.to_string(),
            needed_by: Some(parent.to_string()),
        });
    }
    chosen.push(id.to_string());
}

/// Resolves `selection` against the catalog and the facts.
pub fn plan(selection: &Selection, facts: &Facts) -> Plan {
    let removed: BTreeSet<String> = selection.remove.iter().cloned().collect();
    let mut wanted: Vec<&str> = selection
        .workloads
        .iter()
        .filter_map(|id| workload(id))
        .flat_map(|w| w.components.iter().copied())
        .collect();
    wanted.extend(selection.add.iter().map(String::as_str));
    let mut chosen = Vec::new();
    let mut warnings = Vec::new();
    for id in wanted {
        if !removed.contains(id) {
            add_with_requirements(id, &removed, &mut chosen, &mut warnings, None);
        }
    }
    // Dependencies added by a component that was itself selected directly aren't worth a warning twice.
    warnings.dedup();

    let statuses: HashMap<String, ComponentStatus> = chosen
        .iter()
        .filter_map(|id| component(id).map(|c| (id.clone(), resolve(c, facts))))
        .collect();
    let mut plan = Plan {
        warnings,
        ..Plan::default()
    };
    for id in &chosen {
        let Some(status) = statuses.get(id) else {
            continue;
        };
        let kind = match status.state {
            State::HeavySdk => Some(WarningKind::HeavySdk),
            State::ExternalRequired => Some(WarningKind::ExternalRequired),
            State::AdminRequired => Some(WarningKind::AdminRequired),
            State::ManualInstall => Some(WarningKind::ManualInstall),
            State::Planned => Some(WarningKind::Planned),
            State::UnsupportedArchitecture => Some(WarningKind::UnsupportedArchitecture),
            State::Installed | State::Available => None,
        };
        if let Some(kind) = kind {
            plan.warnings.push(Warning {
                kind,
                component: id.clone(),
                needed_by: None,
            });
        }
        let Some(runtime) = runtime_of(id) else {
            continue;
        };
        if !status.state.installable() || plan.install.iter().any(|r| r == runtime) {
            continue;
        }
        plan.install.push(runtime.to_string());
        plan.download_bytes += status.download_bytes.unwrap_or(0);
        plan.install_bytes += status.install_bytes.unwrap_or(0);
        if status.download_bytes.is_none() || status.install_bytes.is_none() {
            plan.unknown_sizes += 1;
        }
        if status.license_acceptance {
            plan.licenses.push(runtime.to_string());
            plan.warnings.push(Warning {
                kind: WarningKind::LicenseAcceptance,
                component: runtime.to_string(),
                needed_by: None,
            });
        }
    }
    plan.components = chosen;
    plan
}
