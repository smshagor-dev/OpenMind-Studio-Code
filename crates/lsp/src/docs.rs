//! Which documents a server has open, and the notification each editor
//! change turns into. The editor always sends the whole text; the server gets
//! `didOpen` the first time and `didChange` (a full-text change, which every
//! server accepts) afterwards, with a version that only goes up.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::uri::path_to_uri;

/// A notification to send: LSP method and parameters.
pub type Notification = (&'static str, Value);

#[derive(Debug, Default)]
pub struct DocumentSync {
    /// uri → last version sent.
    open: HashMap<String, i64>,
}

impl DocumentSync {
    pub fn is_open(&self, path: &str) -> bool {
        self.open.contains_key(&path_to_uri(path))
    }

    pub fn open_count(&self) -> usize {
        self.open.len()
    }

    /// Every open file's URI (to re-open them after a restart, or list them).
    pub fn open_uris(&self) -> Vec<String> {
        self.open.keys().cloned().collect()
    }

    /// The editor's current text of `path`: open it, or change it if already open.
    pub fn sync(&mut self, path: &str, language_id: &str, text: &str) -> Notification {
        let uri = path_to_uri(path);
        match self.open.get_mut(&uri) {
            Some(version) => {
                *version += 1;
                (
                    "textDocument/didChange",
                    json!({
                        "textDocument": { "uri": uri, "version": *version },
                        "contentChanges": [{ "text": text }]
                    }),
                )
            }
            None => {
                self.open.insert(uri.clone(), 1);
                (
                    "textDocument/didOpen",
                    json!({
                        "textDocument": {
                            "uri": uri,
                            "languageId": language_id,
                            "version": 1,
                            "text": text
                        }
                    }),
                )
            }
        }
    }

    /// The file was saved. `None` if the server never saw it.
    pub fn save(&self, path: &str) -> Option<Notification> {
        let uri = path_to_uri(path);
        self.open.contains_key(&uri).then(|| {
            (
                "textDocument/didSave",
                json!({ "textDocument": { "uri": uri } }),
            )
        })
    }

    /// The document was closed (or its file is gone). `None` if it wasn't open.
    pub fn close(&mut self, path: &str) -> Option<Notification> {
        let uri = path_to_uri(path);
        self.open.remove(&uri).map(|_| {
            (
                "textDocument/didClose",
                json!({ "textDocument": { "uri": uri } }),
            )
        })
    }

    /// The server restarted: nothing is open in it any more.
    pub fn reset(&mut self) {
        self.open.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILE: &str = "C:/My Site/src/a b.ts";

    #[test]
    fn the_first_sync_opens_and_later_ones_change_with_rising_versions() {
        let mut sync = DocumentSync::default();
        let (method, params) = sync.sync(FILE, "typescript", "let a = 1;");
        assert_eq!(method, "textDocument/didOpen");
        assert_eq!(
            params["textDocument"]["uri"],
            "file:///C:/My%20Site/src/a%20b.ts"
        );
        assert_eq!(params["textDocument"]["languageId"], "typescript");
        assert_eq!(params["textDocument"]["version"], 1);
        assert!(sync.is_open(FILE));

        let (method, params) = sync.sync(FILE, "typescript", "let a = 2;");
        assert_eq!(method, "textDocument/didChange");
        assert_eq!(params["textDocument"]["version"], 2);
        assert_eq!(params["contentChanges"][0]["text"], "let a = 2;");
        let (_, params) = sync.sync(FILE, "typescript", "let a = 3;");
        assert_eq!(params["textDocument"]["version"], 3);
    }

    #[test]
    fn slash_style_does_not_matter() {
        let mut sync = DocumentSync::default();
        sync.sync(r"C:\My Site\src\a b.ts", "typescript", "x");
        assert!(sync.is_open(FILE));
        assert_eq!(
            sync.sync(FILE, "typescript", "y").0,
            "textDocument/didChange"
        );
    }

    #[test]
    fn save_and_close_only_apply_to_open_documents() {
        let mut sync = DocumentSync::default();
        assert!(sync.save(FILE).is_none());
        assert!(sync.close(FILE).is_none());
        sync.sync(FILE, "typescript", "x");
        assert_eq!(sync.save(FILE).map(|n| n.0), Some("textDocument/didSave"));
        assert_eq!(sync.close(FILE).map(|n| n.0), Some("textDocument/didClose"));
        assert!(!sync.is_open(FILE));
        // Opening again starts a new life at version 1.
        let (method, params) = sync.sync(FILE, "typescript", "x");
        assert_eq!(method, "textDocument/didOpen");
        assert_eq!(params["textDocument"]["version"], 1);
    }

    #[test]
    fn reset_forgets_everything() {
        let mut sync = DocumentSync::default();
        sync.sync(FILE, "typescript", "x");
        sync.reset();
        assert_eq!(sync.open_count(), 0);
        assert!(sync.open_uris().is_empty());
    }
}
