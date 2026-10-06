//! Which documents a server has open, and the notification each editor
//! change turns into. The editor always sends the whole text; the server gets
//! `didOpen` the first time and `didChange` afterwards, with a version that
//! only goes up. The change is the whole text: without a range for servers that
//! sync fully (every server accepts that), and as one change whose range covers
//! the previous text for servers that asked for incremental sync (asm-lsp
//! refuses a change without a range).

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::uri::path_to_uri;

/// A notification to send: LSP method and parameters.
pub type Notification = (&'static str, Value);

#[derive(Debug, Default)]
pub struct DocumentSync {
    /// uri → last version sent.
    open: HashMap<String, i64>,
    /// Incremental servers only: uri → the text the server holds (the range of the next change is its extent).
    texts: HashMap<String, String>,
    ranged: bool,
}

impl DocumentSync {
    /// A sync for a server that asked for incremental changes (`textDocumentSync` kind 2) when `ranged`.
    pub fn new(ranged: bool) -> Self {
        Self {
            ranged,
            ..Self::default()
        }
    }

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
        let previous = if self.ranged {
            self.texts.insert(uri.clone(), text.to_string())
        } else {
            None
        };
        match self.open.get_mut(&uri) {
            Some(version) => {
                *version += 1;
                let change = match previous {
                    Some(old) => {
                        let (line, character) = end_position(&old);
                        json!({
                            "range": {
                                "start": { "line": 0, "character": 0 },
                                "end": { "line": line, "character": character }
                            },
                            "text": text
                        })
                    }
                    None => json!({ "text": text }),
                };
                (
                    "textDocument/didChange",
                    json!({
                        "textDocument": { "uri": uri, "version": *version },
                        "contentChanges": [change]
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
        self.texts.remove(&uri);
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
        self.texts.clear();
    }

    /// For a server whose text is kept here (the range-based ones): moves every `position` and `range` of a request
    /// about an open document inside that document — past the last line goes to the end, past a line's end to the end
    /// of that line. asm-lsp panics (and exits) on a position outside its text; anything else is left as it is.
    pub fn clamp_positions(&self, params: &mut Value) {
        let Some(uri) = params.pointer("/textDocument/uri").and_then(Value::as_str) else {
            return;
        };
        let Some(text) = self.texts.get(uri) else {
            return;
        };
        let lengths = line_lengths(text);
        for pointer in ["/position", "/range/start", "/range/end"] {
            if let Some(position) = params.pointer_mut(pointer) {
                clamp(position, &lengths);
            }
        }
    }
}

/// The UTF-16 length of every line (`\r\n`, `\n` and `\r` end a line); always at least one line.
fn line_lengths(text: &str) -> Vec<u32> {
    let mut lengths = vec![0u32];
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' | '\n' => {
                if c == '\r' && chars.peek() == Some(&'\n') {
                    chars.next();
                }
                lengths.push(0);
            }
            other => {
                if let Some(last) = lengths.last_mut() {
                    *last += other.len_utf16() as u32;
                }
            }
        }
    }
    lengths
}

fn clamp(position: &mut Value, lengths: &[u32]) {
    let last = lengths.len().saturating_sub(1) as u64;
    let line = position.get("line").and_then(Value::as_u64).unwrap_or(0);
    let character = position
        .get("character")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let (line, character) = if line > last {
        (last, u64::from(lengths[last as usize]))
    } else {
        (line, character.min(u64::from(lengths[line as usize])))
    };
    *position = json!({ "line": line, "character": character });
}

/// The LSP position just past the end of `text`: lines end at `\r\n`, `\n` or `\r`, characters are UTF-16 code units.
fn end_position(text: &str) -> (u32, u32) {
    let mut line = 0u32;
    let mut character = 0u32;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                line += 1;
                character = 0;
            }
            '\n' => {
                line += 1;
                character = 0;
            }
            other => character += other.len_utf16() as u32,
        }
    }
    (line, character)
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
        assert!(
            params["contentChanges"][0].get("range").is_none(),
            "full sync: no range"
        );
        let (_, params) = sync.sync(FILE, "typescript", "let a = 3;");
        assert_eq!(params["textDocument"]["version"], 3);
    }

    #[test]
    fn an_incremental_server_gets_the_whole_text_as_one_change_over_the_previous_text() {
        let mut sync = DocumentSync::new(true);
        sync.sync(FILE, "nasm", "mov rax, 1\r\nret\n; é😀");
        let (_, params) = sync.sync(FILE, "nasm", "nop");
        let change = &params["contentChanges"][0];
        assert_eq!(change["text"], "nop");
        assert_eq!(
            change["range"]["start"],
            json!({ "line": 0, "character": 0 })
        );
        // Two line breaks (CRLF counts once); "; é😀" is 1 + 1 + 1 + 2 UTF-16 units.
        assert_eq!(change["range"]["end"], json!({ "line": 2, "character": 5 }));
        let (_, params) = sync.sync(FILE, "nasm", "nop\nret");
        assert_eq!(
            params["contentChanges"][0]["range"]["end"],
            json!({ "line": 0, "character": 3 })
        );
        // Closing forgets the text; reopening starts again with didOpen.
        sync.close(FILE);
        assert_eq!(sync.sync(FILE, "nasm", "x").0, "textDocument/didOpen");
        let (_, params) = sync.sync(FILE, "nasm", "y");
        assert_eq!(
            params["contentChanges"][0]["range"]["end"],
            json!({ "line": 0, "character": 1 })
        );
    }

    #[test]
    fn positions_outside_an_incremental_servers_text_are_moved_inside_it() {
        let mut sync = DocumentSync::new(true);
        sync.sync(FILE, "nasm", "mov rax, 1\r\n\nret");
        let uri = path_to_uri(FILE);
        let mut params = json!({
            "textDocument": { "uri": uri },
            "position": { "line": 1, "character": 10 },
            "range": { "start": { "line": 0, "character": 99 }, "end": { "line": 7, "character": 3 } }
        });
        sync.clamp_positions(&mut params);
        assert_eq!(
            params["position"],
            json!({ "line": 1, "character": 0 }),
            "a blank line has no column 10"
        );
        assert_eq!(
            params["range"]["start"],
            json!({ "line": 0, "character": 10 })
        );
        assert_eq!(
            params["range"]["end"],
            json!({ "line": 2, "character": 3 }),
            "past the last line: its end"
        );
        // A valid position is untouched, and a document the server doesn't hold is left alone.
        let mut valid =
            json!({ "textDocument": { "uri": uri }, "position": { "line": 2, "character": 1 } });
        sync.clamp_positions(&mut valid);
        assert_eq!(valid["position"], json!({ "line": 2, "character": 1 }));
        let mut other = json!({ "textDocument": { "uri": "file:///C:/x.asm" }, "position": { "line": 9, "character": 9 } });
        sync.clamp_positions(&mut other);
        assert_eq!(other["position"], json!({ "line": 9, "character": 9 }));
        // A full-sync server's requests are never touched (its text isn't kept).
        let mut full = DocumentSync::default();
        full.sync(FILE, "typescript", "x");
        let mut params =
            json!({ "textDocument": { "uri": uri }, "position": { "line": 5, "character": 5 } });
        full.clamp_positions(&mut params);
        assert_eq!(params["position"], json!({ "line": 5, "character": 5 }));
    }

    #[test]
    fn end_positions_follow_lsp_line_breaks() {
        assert_eq!(end_position(""), (0, 0));
        assert_eq!(end_position("ab"), (0, 2));
        assert_eq!(end_position("a\n"), (1, 0));
        assert_eq!(end_position("a\r\nb"), (1, 1));
        assert_eq!(end_position("a\rb\r"), (2, 0));
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
        let mut sync = DocumentSync::new(true);
        sync.sync(FILE, "typescript", "x");
        sync.reset();
        assert_eq!(sync.open_count(), 0);
        assert!(sync.open_uris().is_empty());
        assert_eq!(sync.sync(FILE, "typescript", "x").0, "textDocument/didOpen");
    }
}
