//! Formatters the offline bundle carries (Milestone 18). Their packs unpack into
//! `language-servers/<package>/<revision>/` exactly like a language server's, the
//! first time formatting is asked for — never at launch. A ready tool is either a
//! folder holding its program (Ruff, gofmt, clang-format, StyLua) or a launcher:
//! Node.js, the tool's script and its plugins (Prettier), run as an argument list.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::bundle::Bundle;
use crate::install::package_dir;
use crate::registry::{package_by_id, BundledTool, Runtime, BUNDLED_TOOLS};
use crate::unpack;

/// One process unpacks at a time (two windows formatting at once must not race).
static UNPACK_GATE: Mutex<()> = Mutex::new(());

/// A bundled tool that is unpacked and can run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadyTool {
    /// The `openmind-language` tool id (`prettier`, `ruff`, ...).
    pub tool: &'static str,
    /// The folder of a native tool's program, to search like any bundled tool folder.
    pub dir: Option<PathBuf>,
    /// For a Node tool: the program and leading arguments (`node <script> --plugin=...`).
    pub launcher: Option<Vec<String>>,
}

fn files_of(tool: &BundledTool) -> impl Iterator<Item = &'static str> {
    std::iter::once(tool.entry).chain(tool.plugins.iter().copied())
}

fn tool_present(root: &Path, tool: &BundledTool) -> bool {
    package_by_id(tool.package).is_some_and(|package| {
        let dir = package_dir(root, package);
        files_of(tool).all(|file| dir.join(file).is_file())
    })
}

/// Unpacks every bundled tool's pack that isn't there yet (or came from another pack).
/// Returns one message per pack that failed; the others are still unpacked.
pub fn ensure_unpacked(app_root: &Path, bundle: &Bundle) -> Vec<String> {
    let _guard = UNPACK_GATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut problems = Vec::new();
    let mut done: Vec<&str> = Vec::new();
    for tool in BUNDLED_TOOLS {
        if done.contains(&tool.package) {
            continue;
        }
        done.push(tool.package);
        let Some(package) = package_by_id(tool.package) else {
            continue;
        };
        let Some(pack) = bundle.pack_for(package) else {
            continue;
        };
        if tool_present(app_root, tool) && unpack::is_current(app_root, package, pack) {
            continue;
        }
        tracing::info!(package = package.id, "unpacking a bundled formatter");
        if let Err(err) = unpack::unpack(app_root, bundle, pack, package) {
            problems.push(format!("{}: {err}", package.contents));
        }
    }
    problems
}

/// The bundled tools that are unpacked. A Node tool needs `node`; without it, it is left out.
pub fn ready_tools(app_root: &Path, node: Option<&Path>) -> Vec<ReadyTool> {
    BUNDLED_TOOLS
        .iter()
        .filter(|tool| tool_present(app_root, tool))
        .filter_map(|tool| {
            let dir = package_dir(app_root, package_by_id(tool.package)?);
            let entry = dir.join(tool.entry);
            match tool.runtime {
                Runtime::Native => Some(ReadyTool {
                    tool: tool.tool,
                    dir: entry.parent().map(Path::to_path_buf),
                    launcher: None,
                }),
                Runtime::Node => {
                    let mut launcher =
                        vec![node?.display().to_string(), entry.display().to_string()];
                    launcher.extend(
                        tool.plugins
                            .iter()
                            .map(|plugin| format!("--plugin={}", dir.join(plugin).display())),
                    );
                    Some(ReadyTool {
                        tool: tool.tool,
                        dir: None,
                        launcher: Some(launcher),
                    })
                }
                // No bundled formatter runs as a Python module.
                Runtime::PythonModule => None,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::{bundle_dir, load};
    use crate::pack::create_pack;
    use crate::unpack::sha256_file;

    /// A bundle whose `stylua` and `prettier` packs hold the tools' files.
    fn bundle_with_tools(root: &Path) -> Bundle {
        let packs = bundle_dir(root).join("packs");
        std::fs::create_dir_all(&packs).expect("mkdir");
        let mut entries = Vec::new();
        for id in ["stylua", "prettier"] {
            let src = root.join(format!("src {id}"));
            for tool in BUNDLED_TOOLS.iter().filter(|t| t.package == id) {
                for file in files_of(tool) {
                    let path = src.join(file);
                    std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
                    std::fs::write(path, "x").expect("write");
                }
            }
            let zip = packs.join(format!("{id}-1.zip"));
            create_pack(&src, &zip).expect("pack");
            entries.push(format!(
                r#"{{"package":"{id}","revision":"1","contents":"{id}","file":"packs/{id}-1.zip","sha256":"{}","size":{}}}"#,
                sha256_file(&zip).expect("sha"),
                std::fs::metadata(&zip).expect("meta").len()
            ));
        }
        let json = format!(
            r#"{{"format":"openmind-lsp-bundle","version":1,"platform":"windows-x64","packs":[{}]}}"#,
            entries.join(",")
        );
        std::fs::write(bundle_dir(root).join("bundle.json"), json).expect("json");
        load(root).expect("ok").expect("bundle")
    }

    #[test]
    fn formatter_packs_unpack_once_and_become_ready_tools() {
        let root = tempfile::tempdir().expect("tempdir");
        let app = root.path().join("My App");
        let bundle = bundle_with_tools(&app);
        if !bundle.platform_supported() {
            return; // The bundle is Windows x64 only.
        }
        assert!(ready_tools(&app, None).is_empty());
        assert!(ensure_unpacked(&app, &bundle).is_empty());
        let node = app.join("lsp").join("node").join("node.exe");
        let ready = ready_tools(&app, Some(&node));
        let stylua = ready.iter().find(|t| t.tool == "stylua").expect("stylua");
        assert!(stylua
            .dir
            .as_ref()
            .is_some_and(|dir| dir.join("stylua.exe").is_file()));
        let prettier = ready
            .iter()
            .find(|t| t.tool == "prettier")
            .expect("prettier");
        let launcher = prettier.launcher.as_ref().expect("launcher");
        assert_eq!(launcher[0], node.display().to_string());
        assert!(launcher[1].ends_with("prettier.cjs"));
        assert!(launcher
            .iter()
            .any(|a| a.starts_with("--plugin=") && a.contains("plugin-php")));
        // Without Node, Prettier is not offered; native tools still are.
        let without_node = ready_tools(&app, None);
        assert!(without_node.iter().all(|t| t.tool != "prettier"));
        assert!(without_node.iter().any(|t| t.tool == "stylua"));
        // Already unpacked: nothing to do the second time.
        assert!(ensure_unpacked(&app, &bundle).is_empty());
    }
}
