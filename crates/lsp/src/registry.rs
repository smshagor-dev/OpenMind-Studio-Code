//! The language servers OpenMind knows, as data. Most are npm packages pinned by
//! a lockfile (embedded here) and run by Node.js; a few are native programs. A
//! release build carries every package pre-built in its LSP bundle (see
//! `bundle`), which is unpacked into `language-servers/<package>/<revision>/`
//! the first time a server is needed; an npm package can also be installed
//! from its lockfile on request (`install`).

use serde::Serialize;

use crate::language::language_id;

/// Where a package comes from.
#[derive(Debug, Clone, Copy)]
pub enum Source {
    /// An npm package pinned by `package-lock.json` (every file checked against an integrity hash).
    Npm {
        package_json: &'static str,
        package_lock: &'static str,
    },
    /// A native program that only the LSP bundle carries (pinned by SHA256 in `servers/bundle-sources.json`).
    Native,
}

/// A package installed once, holding one or more servers.
#[derive(Debug, Clone, Copy)]
pub struct Package {
    pub id: &'static str,
    /// Bumped whenever the pinned contents change, so an app update installs
    /// into a fresh folder instead of trusting an older one.
    pub revision: &'static str,
    /// What it holds, for the UI ("typescript-language-server 5.1.3, typescript 5.9.3").
    pub contents: &'static str,
    pub source: Source,
    /// Whether its licence lets OpenMind ship it in the offline bundle. When it
    /// doesn't, the user installs it themselves (from npm, on request).
    pub redistributable: bool,
}

/// What runs a server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Runtime {
    /// `node <entry> <args>`.
    Node,
    /// `<entry> <args>`: the entry is the program itself.
    Native,
}

#[derive(Debug, Clone, Copy)]
pub struct ServerDef {
    pub id: &'static str,
    pub name: &'static str,
    pub package: &'static str,
    /// The script Node runs, or the program itself, relative to the installed package folder.
    pub entry: &'static str,
    pub args: &'static [&'static str],
    pub runtime: Runtime,
    /// The language ids (see `language_id`) this server handles.
    pub languages: &'static [&'static str],
    /// A note the UI shows next to the server (licence limits, what else it needs, ...).
    pub note: Option<&'static str>,
    /// `initializationOptions` as JSON text: what keeps the server offline and quiet.
    pub init_options: &'static str,
    /// Notifications sent right after `initialized` (no parameters).
    pub after_initialized: &'static [&'static str],
    /// Extra environment for the server process only.
    pub env: &'static [(&'static str, &'static str)],
}

/// The defaults for the three offline/behaviour fields.
const PLAIN: (&str, &[&str], &[(&str, &str)]) = ("{}", &[], &[]);

macro_rules! npm {
    ($id:literal, $revision:literal, $contents:literal, $redistributable:literal) => {
        Package {
            id: $id,
            revision: $revision,
            contents: $contents,
            redistributable: $redistributable,
            source: Source::Npm {
                package_json: include_str!(concat!("../servers/", $id, "/package.json")),
                package_lock: include_str!(concat!("../servers/", $id, "/package-lock.json")),
            },
        }
    };
}

pub const PACKAGES: &[Package] = &[
    npm!(
        "typescript",
        "1",
        "typescript-language-server 5.1.3, typescript 5.9.3",
        true
    ),
    npm!("python", "1", "pyright 1.1.414", true),
    // Intelephense's licence forbids redistribution: never in the bundle, installed by the user on request.
    npm!("php", "1", "intelephense 1.18.5", false),
    npm!("web", "1", "vscode-langservers-extracted 4.10.0", true),
    npm!("yaml", "1", "yaml-language-server 1.24.0", true),
    npm!("bash", "1", "bash-language-server 5.8.1", true),
    npm!(
        "dockerfile",
        "1",
        "dockerfile-language-server-nodejs 0.15.0",
        true
    ),
    Package {
        id: "rust",
        revision: "1",
        contents: "rust-analyzer 2026-09-21",
        source: Source::Native,
        redistributable: true,
    },
    Package {
        id: "clangd",
        revision: "1",
        contents: "clangd 22.1.6",
        source: Source::Native,
        redistributable: true,
    },
];

pub const SERVERS: &[ServerDef] = &[
    ServerDef {
        id: "typescript",
        name: "TypeScript Language Server",
        package: "typescript",
        entry: "node_modules/typescript-language-server/lib/cli.mjs",
        args: &["--stdio"],
        runtime: Runtime::Node,
        languages: &[
            "typescript",
            "typescriptreact",
            "javascript",
            "javascriptreact",
        ],
        note: None,
        // No automatic type acquisition: it would download @types packages with npm.
        init_options: r#"{"disableAutomaticTypingAcquisition":true}"#,
        after_initialized: PLAIN.1,
        env: PLAIN.2,
    },
    ServerDef {
        id: "python",
        name: "Pyright",
        package: "python",
        entry: "node_modules/pyright/langserver.index.js",
        args: &["--stdio"],
        runtime: Runtime::Node,
        languages: &["python"],
        note: None,
        init_options: PLAIN.0,
        after_initialized: PLAIN.1,
        env: PLAIN.2,
    },
    ServerDef {
        id: "php",
        name: "Intelephense",
        package: "php",
        entry: "node_modules/intelephense/lib/intelephense.js",
        args: &["--stdio"],
        runtime: Runtime::Node,
        languages: &["php"],
        note: Some("Not bundled (its licence doesn't allow redistribution): Install downloads it from npm. Free tier: rename and some other features need an Intelephense licence."),
        init_options: PLAIN.0,
        after_initialized: PLAIN.1,
        env: PLAIN.2,
    },
    ServerDef {
        id: "json",
        name: "JSON Language Server",
        package: "web",
        entry: "node_modules/vscode-langservers-extracted/bin/vscode-json-language-server",
        args: &["--stdio"],
        runtime: Runtime::Node,
        languages: &["json", "jsonc"],
        note: None,
        // `$schema` URLs are not fetched by the server itself: only `file:` schemas load.
        init_options: r#"{"handledSchemaProtocols":["file"],"provideFormatter":true}"#,
        after_initialized: PLAIN.1,
        env: PLAIN.2,
    },
    ServerDef {
        id: "css",
        name: "CSS Language Server",
        package: "web",
        entry: "node_modules/vscode-langservers-extracted/bin/vscode-css-language-server",
        args: &["--stdio"],
        runtime: Runtime::Node,
        languages: &["css", "scss", "less"],
        note: None,
        init_options: PLAIN.0,
        after_initialized: PLAIN.1,
        env: PLAIN.2,
    },
    ServerDef {
        id: "html",
        name: "HTML Language Server",
        package: "web",
        entry: "node_modules/vscode-langservers-extracted/bin/vscode-html-language-server",
        args: &["--stdio"],
        runtime: Runtime::Node,
        languages: &["html"],
        note: None,
        init_options: PLAIN.0,
        after_initialized: PLAIN.1,
        env: PLAIN.2,
    },
    ServerDef {
        id: "yaml",
        name: "YAML Language Server",
        package: "yaml",
        entry: "node_modules/yaml-language-server/bin/yaml-language-server",
        args: &["--stdio"],
        runtime: Runtime::Node,
        languages: &["yaml"],
        note: Some("No schemas are downloaded: validation uses only schemas inside the project."),
        init_options: PLAIN.0,
        // Remote schemas are asked of the client (which refuses) instead of being downloaded.
        after_initialized: &["yaml/registerContentRequest"],
        env: PLAIN.2,
    },
    ServerDef {
        id: "bash",
        name: "Bash Language Server",
        package: "bash",
        entry: "node_modules/bash-language-server/out/cli.js",
        args: &["start"],
        runtime: Runtime::Node,
        languages: &["shellscript"],
        note: Some("ShellCheck diagnostics appear only when shellcheck is on the PATH."),
        init_options: PLAIN.0,
        after_initialized: PLAIN.1,
        env: PLAIN.2,
    },
    ServerDef {
        id: "dockerfile",
        name: "Dockerfile Language Server",
        package: "dockerfile",
        entry: "node_modules/dockerfile-language-server-nodejs/lib/server.js",
        args: &["--stdio"],
        runtime: Runtime::Node,
        languages: &["dockerfile"],
        note: None,
        init_options: PLAIN.0,
        after_initialized: PLAIN.1,
        env: PLAIN.2,
    },
    ServerDef {
        id: "rust",
        name: "rust-analyzer",
        package: "rust",
        entry: "rust-analyzer.exe",
        args: &[],
        runtime: Runtime::Native,
        languages: &["rust"],
        note: Some("Project analysis needs the Rust toolchain (cargo, rustup) on this computer; OpenMind doesn't install it."),
        init_options: PLAIN.0,
        after_initialized: PLAIN.1,
        // cargo (run by rust-analyzer for project metadata) works from its local cache only.
        env: &[("CARGO_NET_OFFLINE", "true")],
    },
    ServerDef {
        id: "clangd",
        name: "clangd",
        package: "clangd",
        entry: "bin/clangd.exe",
        // No background index: it would write a `.cache/clangd` folder into the project.
        args: &["--background-index=false"],
        runtime: Runtime::Native,
        languages: &["c", "cpp"],
        note: Some("Best with a compile_commands.json in the project; system headers need a C/C++ toolchain."),
        init_options: PLAIN.0,
        after_initialized: PLAIN.1,
        env: PLAIN.2,
    },
];

pub fn server_by_id(id: &str) -> Option<&'static ServerDef> {
    SERVERS.iter().find(|server| server.id == id)
}

pub fn package_by_id(id: &str) -> Option<&'static Package> {
    PACKAGES.iter().find(|package| package.id == id)
}

/// The server that handles `path`, by its language.
pub fn server_for_path(path: &str) -> Option<&'static ServerDef> {
    let language = language_id(path)?;
    SERVERS
        .iter()
        .find(|server| server.languages.contains(&language))
}

/// What the UI lists for one server.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerSummary {
    pub id: &'static str,
    pub name: &'static str,
    pub languages: Vec<&'static str>,
    pub note: Option<&'static str>,
    pub contents: &'static str,
    pub runtime: Runtime,
    /// Only the LSP bundle carries it (no "Install" from npm).
    pub bundle_only: bool,
}

pub fn summaries() -> Vec<ServerSummary> {
    SERVERS
        .iter()
        .map(|server| ServerSummary {
            id: server.id,
            name: server.name,
            languages: server.languages.to_vec(),
            note: server.note,
            contents: package_by_id(server.package).map_or("", |package| package.contents),
            runtime: server.runtime,
            bundle_only: package_by_id(server.package)
                .is_some_and(|package| matches!(package.source, Source::Native)),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_server_has_an_existing_package_and_a_language() {
        for server in SERVERS {
            assert!(package_by_id(server.package).is_some(), "{}", server.id);
            assert!(!server.languages.is_empty());
            let package = package_by_id(server.package).expect("package");
            match (server.runtime, package.source) {
                (Runtime::Node, Source::Npm { .. }) => {
                    assert!(server.entry.starts_with("node_modules/"), "{}", server.id);
                }
                (Runtime::Native, Source::Native) => {
                    assert!(server.entry.ends_with(".exe"), "{}", server.id);
                }
                _ => panic!("{}: runtime and package source disagree", server.id),
            }
            assert!(!server.entry.contains(".."), "{}", server.id);
        }
    }

    #[test]
    fn lookups_by_id_and_by_file() {
        assert_eq!(server_by_id("python").map(|s| s.name), Some("Pyright"));
        assert!(server_by_id("nope").is_none());
        assert_eq!(
            server_for_path("C:/My Site/a.tsx").map(|s| s.id),
            Some("typescript")
        );
        assert_eq!(server_for_path("x.mjs").map(|s| s.id), Some("typescript"));
        assert_eq!(server_for_path("m.py").map(|s| s.id), Some("python"));
        assert_eq!(server_for_path("i.php").map(|s| s.id), Some("php"));
        assert_eq!(server_for_path("a.scss").map(|s| s.id), Some("css"));
        assert_eq!(server_for_path("ci.yml").map(|s| s.id), Some("yaml"));
        assert_eq!(server_for_path("run.sh").map(|s| s.id), Some("bash"));
        assert_eq!(
            server_for_path("C:/p/Dockerfile").map(|s| s.id),
            Some("dockerfile")
        );
        assert_eq!(server_for_path("main.rs").map(|s| s.id), Some("rust"));
        assert_eq!(server_for_path("a.cpp").map(|s| s.id), Some("clangd"));
        assert_eq!(server_for_path("a.h").map(|s| s.id), Some("clangd"));
        assert!(server_for_path("notes.txt").is_none());
    }

    #[test]
    fn every_language_maps_to_exactly_one_server() {
        for server in SERVERS {
            for language in server.languages {
                let owners = SERVERS
                    .iter()
                    .filter(|other| other.languages.contains(language))
                    .count();
                assert_eq!(owners, 1, "{language}");
            }
        }
    }

    #[test]
    fn lockfiles_pin_integrity_hashes() {
        for package in PACKAGES {
            if let Source::Npm {
                package_json,
                package_lock,
            } = package.source
            {
                assert!(package_lock.contains("\"integrity\""), "{}", package.id);
                assert!(package_json.contains("\"dependencies\""));
            }
        }
    }

    #[test]
    fn native_packages_are_redistributable_and_intelephense_is_not() {
        for package in PACKAGES {
            if matches!(package.source, Source::Native) {
                assert!(package.redistributable, "{}", package.id);
            }
        }
        assert!(!package_by_id("php").expect("php").redistributable);
    }

    #[test]
    fn native_packages_match_the_pinned_bundle_sources() {
        let sources: serde_json::Value =
            serde_json::from_str(include_str!("../servers/bundle-sources.json")).expect("json");
        let native = sources["native"].as_array().expect("native list");
        let pinned: Vec<(&str, &str)> = native
            .iter()
            .map(|entry| {
                assert_eq!(entry["sha256"].as_str().map(str::len), Some(64));
                (
                    entry["package"].as_str().expect("package"),
                    entry["revision"].as_str().expect("revision"),
                )
            })
            .collect();
        let registry: Vec<(&str, &str)> = PACKAGES
            .iter()
            .filter(|package| matches!(package.source, Source::Native))
            .map(|package| (package.id, package.revision))
            .collect();
        assert_eq!(pinned, registry);
        for entry in native {
            let package = package_by_id(entry["package"].as_str().expect("id")).expect("known");
            assert_eq!(entry["contents"].as_str(), Some(package.contents));
        }
    }
}
