//! The permission model of extensions. A permission is either *requested* by the extension in its
//! `package.json` (`"openmindPermissions": ["network", ...]`, an OpenMind field VS Code doesn't have) or
//! *inferred* from what it contributes. The user sees both before installing; installing accepts them (the
//! accepted list is stored next to the extension). The host only lets an extension call APIs whose permission
//! was accepted. This is a guard for honest extensions and a brake for careless ones, **not a sandbox**:
//! the host is an ordinary Node.js process (see `host/guard.js` for exactly what is blocked).

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::contributions::Contributions;
use crate::error::ExtensionError;

/// Where the accepted permissions of an installed extension are kept (inside its folder).
pub const ACCEPTED_FILE: &str = ".openmind-permissions.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    WorkspaceRead,
    WorkspaceWrite,
    Commands,
    Settings,
    Languages,
    Themes,
    Snippets,
    Network,
    ProcessExecution,
    Terminal,
    FilesystemOutsideWorkspace,
}

pub const ALL: [Permission; 11] = [
    Permission::WorkspaceRead,
    Permission::WorkspaceWrite,
    Permission::Commands,
    Permission::Settings,
    Permission::Languages,
    Permission::Themes,
    Permission::Snippets,
    Permission::Network,
    Permission::ProcessExecution,
    Permission::Terminal,
    Permission::FilesystemOutsideWorkspace,
];

impl Permission {
    pub fn name(self) -> &'static str {
        match self {
            Self::WorkspaceRead => "workspaceRead",
            Self::WorkspaceWrite => "workspaceWrite",
            Self::Commands => "commands",
            Self::Settings => "settings",
            Self::Languages => "languages",
            Self::Themes => "themes",
            Self::Snippets => "snippets",
            Self::Network => "network",
            Self::ProcessExecution => "processExecution",
            Self::Terminal => "terminal",
            Self::FilesystemOutsideWorkspace => "filesystemOutsideWorkspace",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        ALL.into_iter().find(|permission| permission.name() == name)
    }

    /// Permissions that let code act on the machine beyond the app: the install dialog highlights them.
    pub fn is_high_risk(self) -> bool {
        matches!(
            self,
            Self::WorkspaceWrite
                | Self::Network
                | Self::ProcessExecution
                | Self::Terminal
                | Self::FilesystemOutsideWorkspace
        )
    }
}

/// What the UI shows about an extension's permissions.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionSet {
    /// Asked for in `openmindPermissions`.
    pub requested: Vec<Permission>,
    /// Implied by the contribution points it uses.
    pub inferred: Vec<Permission>,
    /// What the host lets it use: what the user accepted at install (inferred ones only for an extension
    /// installed before permissions existed — a dangerous permission is never granted silently).
    pub accepted: Vec<Permission>,
    pub high_risk: Vec<Permission>,
}

/// `openmindPermissions` from a parsed `package.json`: unknown names are an error, listing the valid ones.
pub fn parse_requested(
    value: Option<&serde_json::Value>,
) -> Result<Vec<Permission>, ExtensionError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let list = value.as_array().ok_or_else(|| {
        ExtensionError::Manifest(
            "\"openmindPermissions\" must be a list of permission names".into(),
        )
    })?;
    let mut requested = BTreeSet::new();
    for item in list {
        let name = item.as_str().unwrap_or_default();
        let permission = Permission::parse(name).ok_or_else(|| {
            let valid: Vec<&str> = ALL.iter().map(|p| p.name()).collect();
            ExtensionError::Manifest(format!(
                "\"openmindPermissions\" has an unknown permission \"{name}\" (valid: {})",
                valid.join(", ")
            ))
        })?;
        requested.insert(permission);
    }
    Ok(requested.into_iter().collect())
}

/// The permissions a set of contributions implies.
pub fn infer(contributes: &Contributions) -> Vec<Permission> {
    let mut inferred = BTreeSet::new();
    if !contributes.commands.is_empty()
        || !contributes.keybindings.is_empty()
        || !contributes.menus.is_empty()
    {
        inferred.insert(Permission::Commands);
    }
    if !contributes.configuration.is_empty() {
        inferred.insert(Permission::Settings);
    }
    if !contributes.languages.is_empty() {
        inferred.insert(Permission::Languages);
    }
    if !contributes.themes.is_empty() {
        inferred.insert(Permission::Themes);
    }
    if !contributes.snippets.is_empty() {
        inferred.insert(Permission::Snippets);
    }
    inferred.into_iter().collect()
}

fn union(a: &[Permission], b: &[Permission]) -> Vec<Permission> {
    a.iter()
        .chain(b)
        .copied()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// The set shown before installing: everything the extension asks for or implies (accepting = installing).
pub fn for_install(requested: &[Permission], inferred: &[Permission]) -> PermissionSet {
    let accepted = union(requested, inferred);
    with_risk(requested, inferred, accepted)
}

/// The set of an installed extension: `accepted` comes from its stored file, else only the inferred ones.
pub fn for_installed(
    requested: &[Permission],
    inferred: &[Permission],
    folder: &Path,
) -> PermissionSet {
    let stored = fs::read_to_string(folder.join(ACCEPTED_FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<Permission>>(&text).ok());
    // Only what the manifest really requests or implies can have been accepted.
    let allowed = union(requested, inferred);
    let accepted = match stored {
        Some(list) => list
            .into_iter()
            .filter(|p| allowed.contains(p))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        None => inferred.to_vec(),
    };
    with_risk(requested, inferred, accepted)
}

fn with_risk(
    requested: &[Permission],
    inferred: &[Permission],
    accepted: Vec<Permission>,
) -> PermissionSet {
    let high_risk = union(requested, inferred)
        .into_iter()
        .filter(|p| p.is_high_risk())
        .collect();
    PermissionSet {
        requested: requested.to_vec(),
        inferred: inferred.to_vec(),
        accepted,
        high_risk,
    }
}

/// Writes the accepted permissions into a (staged) extension folder.
pub fn store_accepted(folder: &Path, accepted: &[Permission]) -> Result<(), ExtensionError> {
    let text = serde_json::to_string_pretty(accepted)
        .map_err(|err| ExtensionError::Host(err.to_string()))?;
    fs::write(folder.join(ACCEPTED_FILE), text)
        .map_err(|err| ExtensionError::io("Couldn't store the accepted permissions", err))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names_round_trip_and_unknown_ones_are_rejected_with_the_valid_list() {
        for permission in ALL {
            assert_eq!(Permission::parse(permission.name()), Some(permission));
        }
        let ok = parse_requested(Some(&json!(["network", "network", "terminal"]))).expect("valid");
        assert_eq!(ok, vec![Permission::Network, Permission::Terminal]);
        let err = parse_requested(Some(&json!(["root"]))).expect_err("unknown");
        assert!(err.to_string().contains("unknown permission \"root\""));
        assert!(err.to_string().contains("filesystemOutsideWorkspace"));
        assert!(parse_requested(Some(&json!("network"))).is_err());
        assert!(parse_requested(None).expect("none").is_empty());
    }

    #[test]
    fn contributions_imply_permissions() {
        let contributes = Contributions::from_value(&json!({
            "commands": [{"command": "a.b", "title": "T"}],
            "configuration": {"properties": {"a.x": {"type": "boolean"}}},
            "languages": [{"id": "l"}],
            "themes": [{"label": "T", "path": "./t.json"}],
            "snippets": [{"language": "l", "path": "./s.json"}]
        }));
        assert_eq!(
            infer(&contributes),
            vec![
                Permission::Commands,
                Permission::Settings,
                Permission::Languages,
                Permission::Themes,
                Permission::Snippets
            ]
        );
        assert!(infer(&Contributions::default()).is_empty());
    }

    #[test]
    fn dangerous_permissions_are_high_risk() {
        assert!(Permission::ProcessExecution.is_high_risk());
        assert!(Permission::Network.is_high_risk());
        assert!(!Permission::Commands.is_high_risk());
        assert!(!Permission::WorkspaceRead.is_high_risk());
    }

    #[test]
    fn installing_accepts_requested_and_inferred_and_storage_round_trips() {
        let dir = tempfile::tempdir().expect("tempdir");
        let set = for_install(&[Permission::Network], &[Permission::Commands]);
        assert_eq!(
            set.accepted,
            vec![Permission::Commands, Permission::Network]
        );
        assert_eq!(set.high_risk, vec![Permission::Network]);
        store_accepted(dir.path(), &set.accepted).expect("stored");
        let installed = for_installed(&[Permission::Network], &[Permission::Commands], dir.path());
        assert_eq!(installed.accepted, set.accepted);
    }

    #[test]
    fn an_extension_without_a_stored_file_only_gets_what_is_inferred() {
        let dir = tempfile::tempdir().expect("tempdir");
        let installed = for_installed(
            &[Permission::ProcessExecution],
            &[Permission::Commands],
            dir.path(),
        );
        assert_eq!(installed.accepted, vec![Permission::Commands]);
    }

    #[test]
    fn a_stored_file_cannot_grant_what_the_manifest_never_asked_for() {
        let dir = tempfile::tempdir().expect("tempdir");
        store_accepted(dir.path(), &[Permission::Commands, Permission::Terminal]).expect("stored");
        let installed = for_installed(&[], &[Permission::Commands], dir.path());
        assert_eq!(installed.accepted, vec![Permission::Commands]);
    }
}
