//! Extension views: `viewsContainers.activitybar` (an icon in the activity bar), the `views` inside those
//! containers and their `viewsWelcome` text. Tree views are drawn by the app from a `TreeDataProvider`
//! the extension registers in the host; webview views are listed but not supported. Views an extension
//! puts into the app's own containers (Explorer, Source Control, ...) aren't supported yet either.

use std::fs;
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use crate::error::ExtensionError;
use crate::store::ensure_inside;
use crate::vsix::safe_relative;

/// One activity bar icon an extension contributes, with the views shown when it is clicked.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewContainer {
    pub id: String,
    pub title: String,
    /// A file inside the extension (`media/icon.svg`) or a product icon (`$(list-tree)`).
    pub icon: Option<String>,
    pub views: Vec<ViewContribution>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewContribution {
    pub id: String,
    pub name: String,
    /// `tree` (drawn by the app) or `webview` (not supported).
    pub kind: String,
    /// The `viewsWelcome` entries shown while the view is empty (the app picks by `when`).
    pub welcome: Vec<WelcomeEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WelcomeEntry {
    pub contents: String,
    /// A `when` clause such as `workbenchState == empty`.
    pub when: Option<String>,
}

/// What `contributes` says about views: the supported containers, and how many views live elsewhere.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Views {
    pub containers: Vec<ViewContainer>,
    /// Views placed in a container this app doesn't have (the Explorer, the panel, another extension's).
    pub elsewhere: usize,
    /// Containers outside the activity bar (`panel`).
    pub other_containers: usize,
}

fn text(value: &Value, key: &str) -> Option<String> {
    let found = match value.get(key)? {
        Value::String(text) => text.clone(),
        // Localizable strings: `{ "value": ..., "original": ... }`.
        Value::Object(object) => object.get("value")?.as_str()?.to_string(),
        _ => return None,
    };
    let trimmed = found.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn entries(value: Option<&Value>) -> &[Value] {
    value
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

/// Parses `viewsContainers`, `views` and `viewsWelcome` out of `contributes`.
pub fn parse(contributes: &Value) -> Views {
    let mut out = Views::default();
    let containers = contributes.get("viewsContainers");
    for entry in entries(containers.and_then(|c| c.get("activitybar"))) {
        let (Some(id), Some(title)) = (text(entry, "id"), text(entry, "title")) else {
            continue;
        };
        if out.containers.iter().any(|c| c.id == id) {
            continue;
        }
        out.containers.push(ViewContainer {
            id,
            title,
            icon: text(entry, "icon"),
            views: Vec::new(),
        });
    }
    if let Some(object) = containers.and_then(Value::as_object) {
        out.other_containers = object
            .iter()
            .filter(|(place, _)| place.as_str() != "activitybar")
            .map(|(_, list)| list.as_array().map_or(0, Vec::len))
            .sum();
    }
    let welcome = |view: &str| -> Vec<WelcomeEntry> {
        entries(contributes.get("viewsWelcome"))
            .iter()
            .filter(|entry| text(entry, "view").as_deref() == Some(view))
            .filter_map(|entry| {
                Some(WelcomeEntry {
                    contents: text(entry, "contents")?,
                    when: text(entry, "when"),
                })
            })
            .collect()
    };
    if let Some(views) = contributes.get("views").and_then(Value::as_object) {
        for (place, list) in views {
            let Some(container) = out.containers.iter_mut().find(|c| &c.id == place) else {
                out.elsewhere += list.as_array().map_or(0, Vec::len);
                continue;
            };
            for entry in list.as_array().map(Vec::as_slice).unwrap_or_default() {
                let Some(id) = text(entry, "id") else {
                    continue;
                };
                container.views.push(ViewContribution {
                    name: text(entry, "name").unwrap_or_else(|| id.clone()),
                    kind: if text(entry, "type").as_deref() == Some("webview") {
                        "webview".into()
                    } else {
                        "tree".into()
                    },
                    welcome: welcome(&id),
                    id,
                });
            }
        }
    }
    out
}

impl Views {
    /// Every contributed view id (activating on `onView:<id>` is implied, as in VS Code).
    pub fn view_ids(&self) -> impl Iterator<Item = &str> {
        self.containers
            .iter()
            .flat_map(|container| container.views.iter().map(|view| view.id.as_str()))
    }

    pub fn tree_count(&self) -> usize {
        self.containers
            .iter()
            .flat_map(|c| &c.views)
            .filter(|v| v.kind == "tree")
            .count()
    }

    pub fn webview_count(&self) -> usize {
        self.containers
            .iter()
            .flat_map(|c| &c.views)
            .filter(|v| v.kind == "webview")
            .count()
    }
}

const MAX_ICON_BYTES: u64 = 256 * 1024;

/// An icon file of an extension (`.svg` or `.png`, at most 256 KB) and its media type.
pub fn read_icon(
    extension_dir: &Path,
    relative: &str,
) -> Result<(Vec<u8>, &'static str), ExtensionError> {
    let fail = |reason: &str| ExtensionError::Path {
        path: Path::new(relative).to_path_buf(),
        reason: reason.to_string(),
    };
    let relative = safe_relative(relative)?.ok_or_else(|| fail("it names no file"))?;
    let mime = match relative
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        _ => return Err(fail("only .svg and .png icons are shown")),
    };
    let file = ensure_inside(extension_dir, &extension_dir.join(relative))?;
    let meta =
        fs::metadata(&file).map_err(|err| ExtensionError::io("Couldn't read the icon", err))?;
    if !meta.is_file() || meta.len() > MAX_ICON_BYTES {
        return Err(fail("it isn't a file, or is larger than 256 KB"));
    }
    let bytes = fs::read(&file).map_err(|err| ExtensionError::io("Couldn't read the icon", err))?;
    Ok((bytes, mime))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Value {
        json!({
            "viewsContainers": {
                "activitybar": [
                    { "id": "todo", "title": "Todo", "icon": "media/todo.svg" },
                    { "id": "todo", "title": "Duplicate" },
                    { "id": "no-title" }
                ],
                "panel": [{ "id": "p", "title": "Panel" }]
            },
            "views": {
                "todo": [
                    { "id": "todo.list", "name": "Tasks" },
                    { "id": "todo.web", "name": { "value": "Board" }, "type": "webview" },
                    { "name": "no id" }
                ],
                "explorer": [{ "id": "todo.explorer", "name": "Todo" }]
            },
            "viewsWelcome": [
                { "view": "todo.list", "contents": "No tasks yet.\n[Add Task](command:todo.add)" },
                { "view": "todo.list", "contents": "Open a folder.", "when": "workbenchState == empty" },
                { "view": "other", "contents": "ignored" }
            ]
        })
    }

    #[test]
    fn reads_activity_bar_containers_their_views_and_welcome_text() {
        let views = parse(&sample());
        assert_eq!(
            views.containers.len(),
            1,
            "duplicates and untitled containers are skipped"
        );
        let todo = &views.containers[0];
        assert_eq!((todo.id.as_str(), todo.title.as_str()), ("todo", "Todo"));
        assert_eq!(todo.icon.as_deref(), Some("media/todo.svg"));
        assert_eq!(todo.views.len(), 2);
        assert_eq!(todo.views[0].kind, "tree");
        assert_eq!(
            todo.views[0].welcome,
            [
                WelcomeEntry {
                    contents: "No tasks yet.\n[Add Task](command:todo.add)".into(),
                    when: None
                },
                WelcomeEntry {
                    contents: "Open a folder.".into(),
                    when: Some("workbenchState == empty".into())
                },
            ]
        );
        assert_eq!(
            (todo.views[1].name.as_str(), todo.views[1].kind.as_str()),
            ("Board", "webview")
        );
        assert_eq!(views.elsewhere, 1, "a view in the Explorer isn't shown");
        assert_eq!(views.other_containers, 1);
        assert_eq!(
            views.view_ids().collect::<Vec<_>>(),
            ["todo.list", "todo.web"]
        );
        assert_eq!((views.tree_count(), views.webview_count()), (1, 1));
    }

    #[test]
    fn nothing_contributed_is_empty() {
        assert_eq!(parse(&json!({})), Views::default());
    }

    #[test]
    fn icons_are_read_only_inside_the_extension_and_only_svg_or_png() {
        let dir = tempfile::tempdir().expect("dir");
        fs::create_dir_all(dir.path().join("media")).expect("media");
        fs::write(dir.path().join("media/icon.svg"), "<svg/>").expect("svg");
        fs::write(dir.path().join("media/icon.gif"), "GIF").expect("gif");
        let (bytes, mime) = read_icon(dir.path(), "media/icon.svg").expect("svg icon");
        assert_eq!(
            (bytes.as_slice(), mime),
            (b"<svg/>".as_slice(), "image/svg+xml")
        );
        assert!(read_icon(dir.path(), "media/icon.gif").is_err());
        assert!(read_icon(dir.path(), "../outside.svg").is_err());
        assert!(read_icon(dir.path(), "media/missing.png").is_err());
    }
}
