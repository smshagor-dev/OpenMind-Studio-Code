//! The built-in browser: Run Code on an HTML file (or a JavaScript file with no Node.js) shows it as a web page
//! beside the editor. Each served folder gets one `openmind_live_preview::Server` on 127.0.0.1, started on the first
//! run and kept until the app closes.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use openmind_fs::path_safety::normalize_path;
use openmind_live_preview::{Server, RUN_SCRIPT_PATH};
use serde::Serialize;
use tauri::{State, Window};

use crate::app_state::AppState;

/// At most this many folders are served at once; the oldest one stops first.
const MAX_SERVERS: usize = 6;
/// A script with `import`/`export` runs as an ES module; only its beginning is read to tell.
const MODULE_SNIFF_BYTES: usize = 256 * 1024;

#[derive(Default)]
pub struct LivePreviews {
    servers: Mutex<Vec<(PathBuf, Server)>>,
}

impl LivePreviews {
    fn serve(&self, root: &Path) -> Result<(String, PathBuf), String> {
        let canonical = normalize_path(root).map_err(|err| err.to_string())?;
        let mut servers = self
            .servers
            .lock()
            .map_err(|_| "The built-in browser is unavailable.".to_string())?;
        if let Some(index) = servers.iter().position(|(served, _)| *served == canonical) {
            // Most recently used last.
            let entry = servers.remove(index);
            servers.push(entry);
        } else {
            let server = Server::start(&canonical).map_err(|err| err.to_string())?;
            if servers.len() >= MAX_SERVERS {
                servers.remove(0);
            }
            servers.push((canonical.clone(), server));
        }
        let (canonical, server) = servers
            .last()
            .ok_or("The built-in browser is unavailable.")?;
        Ok((server.origin(), canonical.clone()))
    }

    fn address_of(&self, root: &Path, file: &Path) -> Result<String, String> {
        let servers = self
            .servers
            .lock()
            .map_err(|_| "The built-in browser is unavailable.".to_string())?;
        let (_, server) = servers
            .iter()
            .find(|(served, _)| served == root)
            .ok_or("The built-in browser's server stopped.")?;
        server.address_of(file).map_err(|err| err.to_string())
    }

    pub fn stop_all(&self) {
        if let Ok(mut servers) = self.servers.lock() {
            servers.clear();
        }
    }
}

/// Where the built-in browser should go for a file.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LivePreviewTarget {
    /// `http://127.0.0.1:<port>` — messages from the page must come from here.
    pub origin: String,
    /// The full address to load.
    pub url: String,
    /// The address inside the server (`/index.html`).
    pub path: String,
    /// The folder the server serves (relative links resolve inside it).
    pub root: String,
}

/// What kind of page a file becomes in the built-in browser.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserKind {
    Page,
    Script,
}

/// `.html`/`.htm` are pages, `.js`/`.mjs` scripts; anything else isn't shown.
pub fn browser_kind(file: &Path) -> Option<BrowserKind> {
    let ext = file.extension()?.to_string_lossy().to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => Some(BrowserKind::Page),
        "js" | "mjs" => Some(BrowserKind::Script),
        _ => None,
    }
}

/// Opens `file` in the built-in browser: serves its folder (the window's open folder when the file is inside it,
/// otherwise the file's own folder) and returns the address.
#[tauri::command]
pub async fn live_preview_open(
    file: PathBuf,
    window: Window,
    state: State<'_, AppState>,
) -> Result<LivePreviewTarget, String> {
    if !file.is_absolute() || file.as_os_str().to_string_lossy().contains('\0') {
        return Err("The file path must be absolute.".into());
    }
    if !file.is_file() {
        return Err(format!("{} doesn't exist.", file.display()));
    }
    let kind =
        browser_kind(&file).ok_or("The built-in browser shows only HTML and JavaScript files.")?;
    let workspace = crate::windows::window_workspace(&state, window.label())
        .await?
        .map(|info| PathBuf::from(info.path));
    let root = serving_root(&file, workspace.as_deref());
    let previews = &state.live_previews;
    let (origin, root) = previews.serve(&root)?;
    let address = previews.address_of(&root, &file)?;
    let path = match kind {
        BrowserKind::Page => address,
        BrowserKind::Script => {
            let module = is_module(&file);
            format!(
                "{RUN_SCRIPT_PATH}?src={}{}",
                encode_component(&address),
                if module { "&module=1" } else { "" }
            )
        }
    };
    Ok(LivePreviewTarget {
        url: format!("{origin}{path}"),
        origin,
        path,
        root: root.to_string_lossy().into_owned(),
    })
}

/// The open folder when `file` is inside it, otherwise the file's own folder.
fn serving_root(file: &Path, workspace: Option<&Path>) -> PathBuf {
    let canonical = |path: &Path| normalize_path(path).ok();
    if let (Some(folder), Some(file)) = (workspace.and_then(canonical), canonical(file)) {
        if file.starts_with(&folder) {
            return folder;
        }
    }
    file.parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| file.to_path_buf())
}

/// `.mjs`, or a `.js` file with a line starting with `import`/`export` (an ES module: it needs `type="module"`).
fn is_module(file: &Path) -> bool {
    if file
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("mjs"))
    {
        return true;
    }
    let Ok(bytes) = std::fs::read(file) else {
        return false;
    };
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(MODULE_SNIFF_BYTES)]);
    text.lines().map(str::trim_start).any(|line| {
        (line.starts_with("import ") || line.starts_with("import{") || line.starts_with("export "))
            && !line.starts_with("import(")
    })
}

fn encode_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_and_scripts_are_told_apart() {
        assert_eq!(
            browser_kind(Path::new("a/Index.HTM")),
            Some(BrowserKind::Page)
        );
        assert_eq!(
            browser_kind(Path::new("a/app.mjs")),
            Some(BrowserKind::Script)
        );
        assert_eq!(browser_kind(Path::new("a/app.ts")), None);
        assert_eq!(browser_kind(Path::new("a/README")), None);
    }

    #[test]
    fn the_open_folder_is_served_when_the_file_is_inside_it() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("work");
        std::fs::create_dir_all(folder.join("site")).unwrap();
        let page = folder.join("site").join("index.html");
        std::fs::write(&page, "<p>x</p>").unwrap();
        let outside = dir.path().join("other.html");
        std::fs::write(&outside, "<p>y</p>").unwrap();
        assert_eq!(
            serving_root(&page, Some(&folder)),
            normalize_path(&folder).unwrap()
        );
        assert_eq!(serving_root(&outside, Some(&folder)), dir.path());
        assert_eq!(serving_root(&page, None), folder.join("site"));
    }

    #[test]
    fn modules_are_recognized_by_their_imports() {
        let dir = tempfile::tempdir().unwrap();
        let module = dir.path().join("m.js");
        std::fs::write(&module, "// x\nimport { a } from './a.js';\n").unwrap();
        let classic = dir.path().join("c.js");
        std::fs::write(
            &classic,
            "const m = import('./a.js');\nconsole.log('important')\n",
        )
        .unwrap();
        assert!(is_module(&module));
        assert!(!is_module(&classic));
        assert!(is_module(Path::new("x.mjs")));
    }

    #[test]
    fn a_folder_is_served_once_and_files_get_addresses() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a b.html"), "<p>x</p>").unwrap();
        let previews = LivePreviews::default();
        let (origin, root) = previews.serve(dir.path()).unwrap();
        let (again, _) = previews.serve(dir.path()).unwrap();
        assert_eq!(origin, again);
        assert_eq!(
            previews
                .address_of(&root, &dir.path().join("a b.html"))
                .unwrap(),
            "/a%20b.html"
        );
        assert_eq!(encode_component("/a%20b.html"), "%2Fa%2520b.html");
        previews.stop_all();
        assert!(previews
            .address_of(&root, &dir.path().join("a b.html"))
            .is_err());
    }
}
