//! "Run anyway" for an extension that asks for a newer VS Code engine than the host's API subset (most extensions
//! installed in a current VS Code do). Such an extension isn't activated by default; the user can choose to run it
//! anyway, per extension. The choice is a file inside the extension's own folder (it moves with enable/disable and
//! goes with uninstall, like `.openmind-permissions.json`) and names the engine range it was given for, so a version
//! that asks for a different engine has to be confirmed again. Running anyway changes nothing else: an API the host
//! doesn't have still fails with its own message when the extension calls it.
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::ExtensionError;
use crate::manifest::Manifest;

pub const OVERRIDE_FILE: &str = ".openmind-engine-override.json";

#[derive(Serialize, Deserialize)]
struct Record {
    engine: String,
}

/// Whether the user chose to run this extension (in `folder`) although its engine is newer than the host's.
pub fn allowed(folder: &Path, manifest: &Manifest) -> bool {
    let Some(engine) = manifest.engines_vscode.as_deref() else {
        return false;
    };
    let Ok(text) = fs::read_to_string(folder.join(OVERRIDE_FILE)) else {
        return false;
    };
    serde_json::from_str::<Record>(&text).is_ok_and(|record| record.engine == engine)
}

/// Records (or, with `allow` false, removes) the user's choice for this extension's current engine range.
pub fn set(folder: &Path, manifest: &Manifest, allow: bool) -> Result<(), ExtensionError> {
    let file = folder.join(OVERRIDE_FILE);
    if !allow {
        return match fs::remove_file(&file) {
            Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(ExtensionError::io(
                format!("Couldn't remove {}", file.display()),
                err,
            )),
            _ => Ok(()),
        };
    }
    let engine = manifest.engines_vscode.clone().ok_or_else(|| {
        ExtensionError::Refused("It doesn't ask for a VS Code engine; nothing to allow.".into())
    })?;
    let text = serde_json::to_string_pretty(&Record { engine }).unwrap_or_default();
    fs::write(&file, text)
        .map_err(|err| ExtensionError::io(format!("Couldn't write {}", file.display()), err))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(engine: &str) -> Manifest {
        let json = format!(
            r#"{{"name":"x","publisher":"acme","version":"1.0.0","engines":{{"vscode":"{engine}"}}}}"#
        );
        Manifest::parse(&json).expect("manifest")
    }

    #[test]
    fn the_choice_is_kept_per_engine_range_and_can_be_taken_back() {
        let dir = tempfile::tempdir().unwrap();
        let newer = manifest("^1.95.0");
        assert!(!allowed(dir.path(), &newer));
        set(dir.path(), &newer, true).unwrap();
        assert!(allowed(dir.path(), &newer));
        // An update that asks for another engine must be confirmed again.
        assert!(!allowed(dir.path(), &manifest("^1.101.0")));
        set(dir.path(), &newer, false).unwrap();
        assert!(!allowed(dir.path(), &newer));
        set(dir.path(), &newer, false).unwrap();
    }

    #[test]
    fn a_damaged_record_allows_nothing() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(OVERRIDE_FILE), "not json").unwrap();
        assert!(!allowed(dir.path(), &manifest("^1.95.0")));
    }
}
