//! The LSP messages OpenMind sends and understands: the `initialize` request,
//! what the client says it supports, the server capabilities it reads back,
//! diagnostics, replies to the server's own requests, and the one list of
//! requests the UI may make.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::uri::uri_to_path;

/// The requests the editor may send through `lsp_request` — nothing else
/// reaches a server, so the webview can't make it run arbitrary methods.
pub const ALLOWED_REQUESTS: &[&str] = &[
    "textDocument/hover",
    "textDocument/completion",
    "completionItem/resolve",
    "textDocument/signatureHelp",
    "textDocument/definition",
    "textDocument/declaration",
    "textDocument/typeDefinition",
    "textDocument/implementation",
    "textDocument/references",
    "textDocument/prepareRename",
    "textDocument/rename",
    "textDocument/formatting",
    "textDocument/rangeFormatting",
    "textDocument/documentSymbol",
];

pub fn is_allowed_request(method: &str) -> bool {
    ALLOWED_REQUESTS.contains(&method)
}

/// The `initialize` request parameters for a workspace folder.
pub fn initialize_params(process_id: u32, root_uri: &str, root_name: &str) -> Value {
    json!({
        "processId": process_id,
        "clientInfo": { "name": "OpenMind Studio", "version": env!("CARGO_PKG_VERSION") },
        "locale": "en",
        "rootUri": root_uri,
        "workspaceFolders": [{ "uri": root_uri, "name": root_name }],
        "capabilities": client_capabilities(),
        "initializationOptions": {},
    })
}

/// What the editor can actually do with a server's answers. Claiming more
/// would make servers send things nothing renders.
pub fn client_capabilities() -> Value {
    json!({
        "general": { "positionEncodings": ["utf-16"] },
        "workspace": { "workspaceFolders": true, "configuration": true },
        "textDocument": {
            "synchronization": { "didSave": true, "dynamicRegistration": false },
            "publishDiagnostics": { "relatedInformation": false, "tagSupport": { "valueSet": [1, 2] } },
            "completion": {
                "completionItem": {
                    "snippetSupport": true,
                    "documentationFormat": ["markdown", "plaintext"],
                    "deprecatedSupport": true,
                    "resolveSupport": { "properties": ["documentation", "detail"] }
                },
                "contextSupport": true
            },
            "hover": { "contentFormat": ["markdown", "plaintext"] },
            "signatureHelp": {
                "signatureInformation": { "documentationFormat": ["markdown", "plaintext"] }
            },
            "definition": { "linkSupport": false },
            "declaration": { "linkSupport": false },
            "typeDefinition": { "linkSupport": false },
            "implementation": { "linkSupport": false },
            "references": {},
            "rename": { "prepareSupport": true },
            "formatting": {},
            "rangeFormatting": {},
            "documentSymbol": { "hierarchicalDocumentSymbolSupport": true }
        }
    })
}

/// What the server said it can do (from its `initialize` result), reduced to
/// what the UI needs to enable or disable each action.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub hover: bool,
    pub completion: bool,
    pub completion_resolve: bool,
    pub completion_triggers: Vec<String>,
    pub signature_help: bool,
    pub signature_triggers: Vec<String>,
    pub definition: bool,
    pub declaration: bool,
    pub type_definition: bool,
    pub implementation: bool,
    pub references: bool,
    pub rename: bool,
    pub prepare_rename: bool,
    pub formatting: bool,
    pub range_formatting: bool,
    pub document_symbol: bool,
}

/// A provider is supported when it is `true` or an options object.
fn supported(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Null) | None => false,
        Some(_) => true,
    }
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse_capabilities(initialize_result: &Value) -> Capabilities {
    let caps = initialize_result
        .get("capabilities")
        .unwrap_or(&Value::Null);
    let rename = caps.get("renameProvider");
    Capabilities {
        hover: supported(caps.get("hoverProvider")),
        completion: supported(caps.get("completionProvider")),
        completion_resolve: caps
            .pointer("/completionProvider/resolveProvider")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        completion_triggers: strings(caps.pointer("/completionProvider/triggerCharacters")),
        signature_help: supported(caps.get("signatureHelpProvider")),
        signature_triggers: strings(caps.pointer("/signatureHelpProvider/triggerCharacters")),
        definition: supported(caps.get("definitionProvider")),
        declaration: supported(caps.get("declarationProvider")),
        type_definition: supported(caps.get("typeDefinitionProvider")),
        implementation: supported(caps.get("implementationProvider")),
        references: supported(caps.get("referencesProvider")),
        rename: supported(rename),
        prepare_rename: rename
            .and_then(|value| value.get("prepareProvider"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        formatting: supported(caps.get("documentFormattingProvider")),
        range_formatting: supported(caps.get("documentRangeFormattingProvider")),
        document_symbol: supported(caps.get("documentSymbolProvider")),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Position {
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

/// One problem a server reported, in LSP's own shape (0-based lines/columns,
/// UTF-16) — the frontend converts it to a Monaco marker.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub range: Range,
    /// 1 error, 2 warning, 3 information, 4 hint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub message: String,
    /// 1 unnecessary, 2 deprecated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedDiagnostics {
    /// The file the diagnostics are for (forward slashes).
    pub path: String,
    pub version: Option<i64>,
    pub diagnostics: Vec<Diagnostic>,
}

/// `textDocument/publishDiagnostics` params → diagnostics for a file. `None`
/// when the URI isn't a `file://` one (nothing in the editor to show it on).
pub fn parse_diagnostics(params: &Value) -> Option<PublishedDiagnostics> {
    let path = uri_to_path(params.get("uri")?.as_str()?)?;
    let diagnostics = params
        .get("diagnostics")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|entry| serde_json::from_value::<Diagnostic>(entry.clone()).ok())
        .collect();
    Some(PublishedDiagnostics {
        path,
        version: params.get("version").and_then(Value::as_i64),
        diagnostics,
    })
}

/// Our answer to a request the server makes of us (`Err` = JSON-RPC error code and text).
pub fn reply_to_server_request(
    method: &str,
    params: &Value,
    root_uri: &str,
    root_name: &str,
) -> Result<Value, (i64, String)> {
    match method {
        // No user settings are stored yet: every section gets `null`, i.e. the server's defaults.
        "workspace/configuration" => {
            let count = params
                .get("items")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            Ok(Value::Array(vec![Value::Null; count]))
        }
        "workspace/workspaceFolders" => Ok(json!([{ "uri": root_uri, "name": root_name }])),
        "window/workDoneProgress/create"
        | "client/registerCapability"
        | "client/unregisterCapability"
        | "window/showMessageRequest"
        | "window/showDocument" => Ok(Value::Null),
        "workspace/applyEdit" => Ok(json!({
            "applied": false,
            "failureReason": "OpenMind Studio doesn't apply server-initiated edits."
        })),
        _ => Err((-32601, format!("Method not found: {method}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_carries_the_root_and_a_capability_set() {
        let params = initialize_params(42, "file:///C:/My%20Site", "My Site");
        assert_eq!(params["processId"], 42);
        assert_eq!(params["rootUri"], "file:///C:/My%20Site");
        assert_eq!(params["workspaceFolders"][0]["name"], "My Site");
        assert_eq!(
            params["capabilities"]["textDocument"]["rename"]["prepareSupport"],
            true
        );
        assert_eq!(
            params["capabilities"]["general"]["positionEncodings"][0],
            "utf-16"
        );
    }

    #[test]
    fn capabilities_are_read_from_bools_and_option_objects() {
        let caps = parse_capabilities(&json!({
            "capabilities": {
                "hoverProvider": true,
                "completionProvider": { "resolveProvider": true, "triggerCharacters": [".", ":"] },
                "definitionProvider": { "workDoneProgress": true },
                "referencesProvider": false,
                "renameProvider": { "prepareProvider": true },
                "documentFormattingProvider": true
            }
        }));
        assert!(caps.hover && caps.completion && caps.completion_resolve);
        assert_eq!(caps.completion_triggers, vec![".", ":"]);
        assert!(caps.definition);
        assert!(!caps.references);
        assert!(caps.rename && caps.prepare_rename);
        assert!(caps.formatting);
        assert!(!caps.document_symbol && !caps.signature_help);
    }

    #[test]
    fn no_capabilities_means_nothing_is_supported() {
        assert_eq!(parse_capabilities(&json!({})), Capabilities::default());
    }

    #[test]
    fn diagnostics_are_parsed_with_their_path() {
        let parsed = parse_diagnostics(&json!({
            "uri": "file:///c%3A/My%20Site/a.ts",
            "version": 3,
            "diagnostics": [
                {
                    "range": { "start": { "line": 1, "character": 2 }, "end": { "line": 1, "character": 5 } },
                    "severity": 1,
                    "code": 2304,
                    "source": "ts",
                    "message": "Cannot find name 'foo'."
                },
                { "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 1 } }, "message": "no severity" },
                { "not": "a diagnostic" }
            ]
        }))
        .expect("parsed");
        assert_eq!(parsed.path, "c:/My Site/a.ts");
        assert_eq!(parsed.version, Some(3));
        assert_eq!(parsed.diagnostics.len(), 2);
        assert_eq!(parsed.diagnostics[0].severity, Some(1));
        assert_eq!(parsed.diagnostics[1].severity, None);
    }

    #[test]
    fn empty_diagnostics_clear_and_foreign_uris_are_ignored() {
        let cleared = parse_diagnostics(&json!({ "uri": "file:///a.py", "diagnostics": [] }));
        assert_eq!(cleared.map(|d| d.diagnostics.len()), Some(0));
        assert!(parse_diagnostics(&json!({ "uri": "untitled:1", "diagnostics": [] })).is_none());
    }

    #[test]
    fn server_requests_get_answers_that_keep_servers_going() {
        let cfg = reply_to_server_request(
            "workspace/configuration",
            &json!({ "items": [{"section": "python"}, {"section": "python.analysis"}] }),
            "file:///r",
            "r",
        );
        assert_eq!(cfg, Ok(json!([null, null])));
        assert_eq!(
            reply_to_server_request("client/registerCapability", &Value::Null, "file:///r", "r"),
            Ok(Value::Null)
        );
        let folders =
            reply_to_server_request("workspace/workspaceFolders", &Value::Null, "file:///r", "r")
                .expect("folders");
        assert_eq!(folders[0]["uri"], "file:///r");
        assert_eq!(
            reply_to_server_request("nope/never", &Value::Null, "file:///r", "r")
                .expect_err("unknown")
                .0,
            -32601
        );
    }

    #[test]
    fn only_editor_features_are_allowed_through() {
        assert!(is_allowed_request("textDocument/hover"));
        assert!(is_allowed_request("textDocument/rename"));
        assert!(!is_allowed_request("workspace/executeCommand"));
        assert!(!is_allowed_request("shutdown"));
        assert!(!is_allowed_request("exit"));
    }
}
