//! Extension host requests the Rust side answers itself (Milestone 18), so they never pass through the window:
//!
//! - `secrets/get|store|delete|keys` — `context.secrets`. Each extension's secrets are one JSON object encrypted with
//!   Windows DPAPI (`secret.rs`) in `editor_settings` under `ext.secrets.<extension id>`; an extension can only reach
//!   its own entry (the id comes from the host, which knows which extension is calling, and must be an installed
//!   extension). Values are never logged, emitted to the window or put into an error.
//! - `workspace/findFiles` — the files of the open folder matching a glob (`openmind_search::find`), for an extension
//!   that holds `workspaceRead`; a `RelativePattern` base must lie inside the open folder.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

use openmind_db::EditorSettingsRepository;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::app_state::AppState;
use crate::secret;

/// Host requests answered here instead of by the window.
pub(crate) fn handled_here(method: &str) -> bool {
    matches!(
        method,
        "secrets/get" | "secrets/store" | "secrets/delete" | "secrets/keys" | "workspace/findFiles"
    )
}

/// The `editor_settings` key of an extension's secrets.
pub(crate) fn secrets_key(extension: &str) -> String {
    format!("ext.secrets.{extension}")
}

const MAX_KEYS: usize = 200;

/// What a secrets request does to an extension's map. Pure, so it is tested without DPAPI or a database.
/// Returns the answer and whether the map changed.
pub(crate) fn apply_secret(
    map: &mut BTreeMap<String, String>,
    method: &str,
    params: &Value,
) -> Result<(Value, bool), String> {
    let key = || -> Result<String, String> {
        let key = params
            .get("key")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if key.is_empty() || key.chars().count() > 256 {
            return Err("A secret key must be a string of 1 to 256 characters.".into());
        }
        Ok(key.to_string())
    };
    match method {
        "secrets/get" => Ok((json!({ "value": map.get(&key()?) }), false)),
        "secrets/keys" => Ok((json!({ "keys": map.keys().collect::<Vec<_>>() }), false)),
        "secrets/delete" => {
            let changed = map.remove(&key()?).is_some();
            Ok((Value::Null, changed))
        }
        "secrets/store" => {
            let key = key()?;
            let value = params
                .get("value")
                .and_then(Value::as_str)
                .ok_or("A secret value must be a string.")?;
            if value.len() > 64 * 1024 {
                return Err("A secret value may not be longer than 64 KB.".into());
            }
            if !map.contains_key(&key) && map.len() >= MAX_KEYS {
                return Err(format!("An extension can keep at most {MAX_KEYS} secrets."));
            }
            map.insert(key, value.to_string());
            Ok((Value::Null, true))
        }
        _ => Err(format!("Unknown secrets request {method}")),
    }
}

async fn load_secrets(
    state: &AppState,
    extension: &str,
) -> Result<BTreeMap<String, String>, String> {
    let stored = EditorSettingsRepository::new(state.db.pool())
        .get(&secrets_key(extension))
        .await
        .map_err(|err| err.to_string())?;
    match stored.filter(|value| !value.is_empty()) {
        None => Ok(BTreeMap::new()),
        Some(stored) => {
            let plain = secret::unprotect(&stored).map_err(|err| {
                format!("The extension's secrets can't be read on this computer: {err}")
            })?;
            serde_json::from_str(&plain)
                .map_err(|_| "The extension's secrets are damaged.".to_string())
        }
    }
}

async fn save_secrets(
    state: &AppState,
    extension: &str,
    map: &BTreeMap<String, String>,
) -> Result<(), String> {
    let repo = EditorSettingsRepository::new(state.db.pool());
    if map.is_empty() {
        return repo
            .delete(&secrets_key(extension))
            .await
            .map_err(|err| err.to_string());
    }
    let plain = serde_json::to_string(map).map_err(|err| err.to_string())?;
    let stored = secret::protect(&plain).map_err(|err| err.to_string())?;
    repo.set(&secrets_key(extension), &stored)
        .await
        .map_err(|err| err.to_string())
}

/// How many secrets an extension keeps (the details page shows the count, never a value).
pub(crate) async fn secret_count(state: &AppState, extension: &str) -> usize {
    load_secrets(state, extension)
        .await
        .map_or(0, |map| map.len())
}

/// Forgets every secret of an extension (the details page's Clear, and uninstall).
pub(crate) async fn clear_secrets(state: &AppState, extension: &str) -> Result<(), String> {
    EditorSettingsRepository::new(state.db.pool())
        .delete(&secrets_key(extension))
        .await
        .map_err(|err| err.to_string())
}

fn installed_permissions(state: &AppState, extension: &str) -> Option<Vec<String>> {
    state
        .extensions
        .store
        .list()
        .extensions
        .into_iter()
        .find(|installed| installed.id == extension && installed.enabled)
        .map(|installed| {
            installed
                .permissions
                .accepted
                .iter()
                .map(|permission| permission.name().to_string())
                .collect()
        })
}

async fn answer_secrets(state: &AppState, method: &str, params: &Value) -> Result<Value, String> {
    let extension = params
        .get("extension")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if installed_permissions(state, &extension).is_none() {
        return Err("Secrets are only available to an installed, enabled extension.".into());
    }
    let mut map = load_secrets(state, &extension).await?;
    let (answer, changed) = apply_secret(&mut map, method, params)?;
    if changed {
        save_secrets(state, &extension, &map).await?;
    }
    Ok(answer)
}

fn pattern_of(value: &Value) -> Option<(String, Option<String>)> {
    let pattern = value.get("pattern")?.as_str()?.to_string();
    let base = value
        .get("base")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some((pattern, base))
}

async fn answer_find_files(state: &AppState, params: &Value) -> Result<Value, String> {
    let extension = params
        .get("extension")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let granted = installed_permissions(state, extension).unwrap_or_default();
    if !granted.iter().any(|p| p == "workspaceRead") {
        return Err("Permission 'workspaceRead' is required for this extension API.".into());
    }
    let workspace = crate::windows::window_workspace(state, "main")
        .await?
        .map(|w| PathBuf::from(w.path))
        .ok_or("Open a folder first: findFiles searches the open folder.")?;
    let (include, base) = pattern_of(params.get("include").unwrap_or(&Value::Null))
        .ok_or("findFiles needs an include pattern.")?;
    let root = match base {
        Some(base) => openmind_fs::ensure_within_root(&workspace, std::path::Path::new(&base))
            .map_err(|_| "A RelativePattern base must be inside the open folder.".to_string())?,
        None => workspace,
    };
    let exclude = params.get("exclude").and_then(pattern_of).map(|(p, _)| p);
    let max = params
        .get("maxResults")
        .and_then(Value::as_u64)
        .and_then(|m| usize::try_from(m).ok());
    let found = tokio::task::spawn_blocking(move || {
        openmind_search::find::find_files(
            &root,
            &include,
            exclude.as_deref(),
            max,
            &AtomicBool::new(false),
        )
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string())?;
    Ok(json!(found
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()))
}

/// Answers a host request in the background and sends the answer straight back to the host.
pub(crate) fn answer(app: AppHandle, id: Value, method: String, params: Value) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let result = if method == "workspace/findFiles" {
            answer_find_files(&state, &params).await
        } else {
            answer_secrets(&state, &method, &params).await
        };
        if let Some(host) = state.extensions.running_host() {
            if let Err(err) = host.respond(&id, result) {
                tracing::warn!(%err, method, "could not answer the extension host");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(
        map: &mut BTreeMap<String, String>,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        apply_secret(map, method, &params).map(|(answer, _)| answer)
    }

    #[test]
    fn each_extension_has_its_own_entry_and_values_stay_there() {
        assert_eq!(secrets_key("pub.one"), "ext.secrets.pub.one");
        assert_ne!(secrets_key("pub.one"), secrets_key("pub.two"));
        let mut one = BTreeMap::new();
        let mut two = BTreeMap::new();
        run(
            &mut one,
            "secrets/store",
            json!({ "key": "token", "value": "a" }),
        )
        .expect("store");
        run(
            &mut two,
            "secrets/store",
            json!({ "key": "token", "value": "b" }),
        )
        .expect("store");
        assert_eq!(
            run(&mut one, "secrets/get", json!({ "key": "token" })).expect("get")["value"],
            "a"
        );
        assert_eq!(
            run(&mut two, "secrets/get", json!({ "key": "token" })).expect("get")["value"],
            "b"
        );
        run(&mut one, "secrets/delete", json!({ "key": "token" })).expect("delete");
        assert_eq!(
            run(&mut one, "secrets/get", json!({ "key": "token" })).expect("get")["value"],
            Value::Null
        );
        assert_eq!(
            run(&mut two, "secrets/keys", json!({})).expect("keys")["keys"],
            json!(["token"])
        );
    }

    #[test]
    fn bad_keys_values_and_too_many_secrets_are_refused_without_echoing_the_value() {
        let mut map = BTreeMap::new();
        let err = run(
            &mut map,
            "secrets/store",
            json!({ "key": "", "value": "hunter2" }),
        )
        .expect_err("empty");
        assert!(!err.contains("hunter2"));
        let long = "x".repeat(64 * 1024 + 1);
        let err = run(
            &mut map,
            "secrets/store",
            json!({ "key": "k", "value": long }),
        )
        .expect_err("long");
        assert!(err.contains("64 KB"));
        assert!(run(&mut map, "secrets/store", json!({ "key": "k" })).is_err());
        for i in 0..MAX_KEYS {
            run(
                &mut map,
                "secrets/store",
                json!({ "key": format!("k{i}"), "value": "v" }),
            )
            .expect("store");
        }
        assert!(run(
            &mut map,
            "secrets/store",
            json!({ "key": "one-more", "value": "v" })
        )
        .is_err());
        // Replacing an existing key is still allowed.
        assert!(run(
            &mut map,
            "secrets/store",
            json!({ "key": "k0", "value": "w" })
        )
        .is_ok());
    }

    #[test]
    fn unsupported_api_names_are_read_from_host_log_lines() {
        use crate::commands::extensions::unsupported_api_in;
        assert_eq!(
            unsupported_api_in(
                "VS Code API 'debug.startDebugging' is not supported by OpenMind Studio yet."
            ),
            Some("debug.startDebugging".to_string())
        );
        assert_eq!(unsupported_api_in("Activation failed: boom"), None);
        assert_eq!(unsupported_api_in("VS Code API '' is not supported"), None);
    }

    #[test]
    fn only_the_rust_side_answers_secrets_and_find_files() {
        for method in [
            "secrets/get",
            "secrets/store",
            "secrets/delete",
            "secrets/keys",
            "workspace/findFiles",
        ] {
            assert!(handled_here(method), "{method}");
        }
        assert!(!handled_here("ui/showMessage"));
    }
}
