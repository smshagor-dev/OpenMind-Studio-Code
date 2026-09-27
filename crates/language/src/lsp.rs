//! Language server candidates per language. OpenMind starts only its own servers (TypeScript, Python, PHP, HTML, CSS,
//! JSON, YAML, Bash, Dockerfile, Rust, C/C++ — see `openmind_lsp::registry`; all but PHP ship in the offline bundle);
//! every other candidate is *looked for* so the status can say what is on the computer and what isn't — with the plain
//! statement that OpenMind cannot start it yet. Nothing here launches or installs a server.

use serde::Serialize;

use crate::tools::{status_of, Found, ToolEnv};

/// The id of OpenMind's own server for a candidate, when it has one.
pub fn builtin_server(tool_id: &str) -> Option<&'static str> {
    match tool_id {
        "typescript-language-server" => Some("typescript"),
        "pyright" => Some("python"),
        "intelephense" => Some("php"),
        "vscode-html-language-server" => Some("html"),
        "vscode-css-language-server" => Some("css"),
        "vscode-json-language-server" => Some("json"),
        "yaml-language-server" => Some("yaml"),
        "bash-language-server" => Some("bash"),
        "docker-langserver" => Some("dockerfile"),
        "rust-analyzer" => Some("rust"),
        "clangd" => Some("clangd"),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCandidate {
    pub tool: String,
    pub name: String,
    /// OpenMind's own server id (`typescript`, `python`, `rust`, ...); the app adds its install/running state.
    pub builtin: Option<String>,
    /// For a server OpenMind doesn't start: where the executable was found, if anywhere.
    pub found: Option<Found>,
    /// What the user should know: how to get it, or that OpenMind can't start it.
    pub note: String,
}

pub fn candidates(server_ids: &[&str], env: &ToolEnv) -> Vec<LspCandidate> {
    server_ids
        .iter()
        .map(|id| {
            let status = status_of(id, env);
            let builtin = builtin_server(id).map(str::to_string);
            let note = match (&builtin, &status.found) {
                (Some(_), _) => {
                    "OpenMind starts this server itself (from its offline bundle, or installed from Language Tools).".to_string()
                }
                (None, Some(_)) => "Found on this computer, but OpenMind can't start this language server yet, so there are no completions or diagnostics from it.".to_string(),
                (None, None) => format!(
                    "Not found. {} OpenMind can't start this language server yet.",
                    status.hint
                ),
            };
            LspCandidate {
                tool: status.id,
                name: status.name,
                found: if builtin.is_some() { None } else { status.found },
                builtin,
                note,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::Os;
    use std::collections::HashMap;

    fn env(dir: &std::path::Path) -> ToolEnv {
        ToolEnv {
            os: Os::Linux,
            project_dirs: vec![],
            bundled_dirs: vec![],
            portable_dirs: vec![],
            system_dirs: vec![dir.to_path_buf()],
            launchers: Default::default(),
            pathext: vec![],
            vars: HashMap::new(),
        }
    }

    #[test]
    fn builtin_servers_are_marked_and_others_are_honest() {
        let dir = tempfile::tempdir().expect("tmp");
        std::fs::write(dir.path().join("gopls"), "").expect("file");
        let e = env(dir.path());
        let list = candidates(&["typescript-language-server", "gopls", "jdtls"], &e);
        assert_eq!(list[0].builtin.as_deref(), Some("typescript"));
        assert!(list[0].found.is_none());
        assert!(list[1].found.is_some());
        assert!(list[1].note.contains("can't start"));
        assert!(list[2].found.is_none());
        assert!(list[2].note.contains("Eclipse") && list[2].note.contains("can't start"));
    }

    #[test]
    fn the_builtin_servers_are_exactly_openmind_s_own() {
        let all: std::collections::BTreeSet<&str> = crate::tools::TOOLS
            .iter()
            .filter_map(|t| builtin_server(t.id))
            .collect();
        assert_eq!(
            all.into_iter().collect::<Vec<_>>(),
            [
                "bash",
                "clangd",
                "css",
                "dockerfile",
                "html",
                "json",
                "php",
                "python",
                "rust",
                "typescript",
                "yaml"
            ]
        );
    }
}
