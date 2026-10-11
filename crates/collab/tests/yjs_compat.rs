//! Rust (`yrs`, the Owner's canonical documents) <-> JavaScript (`yjs`, the editors in every window) compatibility,
//! with real encoded updates and state vectors: `scripts/yjs-compat.mjs` runs the actual `yjs` package from the
//! repository's `node_modules`. Skipped (with a message) only on a machine without Node.js or without `pnpm install`.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use openmind_collab::crdt::CollabDoc;
use serde_json::{json, Value};

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn available() -> bool {
    let ok = repo().join("node_modules/yjs").is_dir()
        && Command::new("node").arg("--version").output().is_ok();
    if !ok {
        eprintln!(
            "Node.js or node_modules/yjs is missing; Rust <-> Yjs compatibility not exercised"
        );
    }
    ok
}

fn js(request: Value) -> Value {
    let mut child = Command::new("node")
        .arg(repo().join("scripts/yjs-compat.mjs"))
        .current_dir(repo())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("node");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(request.to_string().as_bytes())
        .expect("write");
    let output = child.wait_with_output().expect("node output");
    assert!(output.status.success(), "yjs-compat.mjs failed");
    serde_json::from_slice(&output.stdout).expect("json")
}

fn bin(value: &Value) -> Vec<u8> {
    B64.decode(value.as_str().expect("base64 string"))
        .expect("base64")
}

fn b64(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

const TEXT: &str = "fn main() {\n    println!(\"héllo 😀 мир\");\n}\n";

#[test]
fn a_yjs_document_opens_in_yrs_and_a_yrs_document_opens_in_yjs() {
    if !available() {
        return;
    }
    let from_js = js(json!({ "op": "create", "text": TEXT }));
    let rust =
        CollabDoc::restore(Some(&bin(&from_js["state"])), &[]).expect("yrs reads a Yjs update");
    assert_eq!(rust.text(), TEXT);

    let rust = CollabDoc::from_text(TEXT);
    let in_js = js(json!({ "op": "apply", "updates": [b64(&rust.full_state())] }));
    assert_eq!(in_js["text"], TEXT, "Yjs reads a yrs update");
}

#[test]
fn edits_on_both_sides_converge_including_non_ascii_positions() {
    if !available() {
        return;
    }
    let base = js(json!({ "op": "create", "text": TEXT }));
    let rust = CollabDoc::restore(Some(&bin(&base["state"])), &[]).expect("restore");
    // Concurrent: JavaScript edits after the emoji (UTF-16 positions), Rust replaces a word at the start.
    let at = TEXT
        .encode_utf16()
        .position(|u| u == u16::from(b'!'))
        .expect("position") as u64;
    let js_edit = js(
        json!({ "op": "edit", "state": base["state"], "at": at, "remove": 0, "insert": " (from js)" }),
    );
    let rust_update = rust.set_text(&TEXT.replace("main", "start")).expect("edit");
    assert!(rust
        .apply(&bin(&js_edit["update"]))
        .expect("yrs applies the Yjs edit"));
    let merged_js =
        js(json!({ "op": "apply", "state": js_edit["state"], "updates": [b64(&rust_update)] }));
    assert_eq!(
        merged_js["text"].as_str(),
        Some(rust.text().as_str()),
        "both sides hold the same text"
    );
    assert!(rust.text().contains("start") && rust.text().contains("(from js)"));
}

#[test]
fn state_vectors_reconcile_in_both_directions() {
    if !available() {
        return;
    }
    let base = js(json!({ "op": "create", "text": "shared\n" }));
    let rust = CollabDoc::restore(Some(&bin(&base["state"])), &[]).expect("restore");
    rust.set_text("shared\nrust line\n");
    let js_side = js(
        json!({ "op": "edit", "state": base["state"], "at": 0, "remove": 0, "insert": "js line\n" }),
    );

    // Rust -> JS: what the JS document lacks, computed from its state vector by yrs.
    let missing_in_js = rust.diff(&bin(&js_side["sv"])).expect("diff");
    let js_after =
        js(json!({ "op": "apply", "state": js_side["state"], "updates": [b64(&missing_in_js)] }));
    // JS -> Rust: what the Rust document lacks, computed from its state vector by Yjs.
    let missing_in_rust =
        js(json!({ "op": "diff", "state": js_side["state"], "sv": b64(&rust.state_vector()) }));
    assert!(rust.apply(&bin(&missing_in_rust["update"])).expect("apply"));
    assert_eq!(js_after["text"].as_str(), Some(rust.text().as_str()));
    // Nothing is left to send either way.
    assert!(!rust
        .apply(&bin(&js(
            json!({ "op": "diff", "state": js_after["state"], "sv": b64(&rust.state_vector()) })
        )["update"]))
        .expect("noop"));
}
