//! The language servers OpenMind knows, as data. Each is an npm package that
//! is installed from a pinned, integrity-checked lockfile (embedded here) into
//! `language-servers/<package>/<revision>/` and run by Node.js.

use serde::Serialize;

use crate::language::language_id;

/// An npm package installed once, holding one or more servers.
#[derive(Debug, Clone, Copy)]
pub struct Package {
    pub id: &'static str,
    /// Bumped whenever the pinned lockfile changes, so an app update installs
    /// into a fresh folder instead of trusting an older one.
    pub revision: &'static str,
    /// What gets downloaded, for the UI ("typescript-language-server 5.1.3, typescript 5.9.3").
    pub contents: &'static str,
    pub package_json: &'static str,
    pub package_lock: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct ServerDef {
    pub id: &'static str,
    pub name: &'static str,
    pub package: &'static str,
    /// The script Node runs, relative to the installed package folder.
    pub entry: &'static str,
    pub args: &'static [&'static str],
    /// The language ids (see `language_id`) this server handles.
    pub languages: &'static [&'static str],
    /// A note the UI shows next to the server (licence limits, ...).
    pub note: Option<&'static str>,
}

pub const PACKAGES: &[Package] = &[
    Package {
        id: "typescript",
        revision: "1",
        contents: "typescript-language-server 5.1.3, typescript 5.9.3",
        package_json: include_str!("../servers/typescript/package.json"),
        package_lock: include_str!("../servers/typescript/package-lock.json"),
    },
    Package {
        id: "python",
        revision: "1",
        contents: "pyright 1.1.414",
        package_json: include_str!("../servers/python/package.json"),
        package_lock: include_str!("../servers/python/package-lock.json"),
    },
    Package {
        id: "php",
        revision: "1",
        contents: "intelephense 1.18.5",
        package_json: include_str!("../servers/php/package.json"),
        package_lock: include_str!("../servers/php/package-lock.json"),
    },
    Package {
        id: "web",
        revision: "1",
        contents: "vscode-langservers-extracted 4.10.0",
        package_json: include_str!("../servers/web/package.json"),
        package_lock: include_str!("../servers/web/package-lock.json"),
    },
];

pub const SERVERS: &[ServerDef] = &[
    ServerDef {
        id: "typescript",
        name: "TypeScript Language Server",
        package: "typescript",
        entry: "node_modules/typescript-language-server/lib/cli.mjs",
        args: &["--stdio"],
        languages: &[
            "typescript",
            "typescriptreact",
            "javascript",
            "javascriptreact",
        ],
        note: None,
    },
    ServerDef {
        id: "python",
        name: "Pyright",
        package: "python",
        entry: "node_modules/pyright/langserver.index.js",
        args: &["--stdio"],
        languages: &["python"],
        note: None,
    },
    ServerDef {
        id: "php",
        name: "Intelephense",
        package: "php",
        entry: "node_modules/intelephense/lib/intelephense.js",
        args: &["--stdio"],
        languages: &["php"],
        note: Some("Free tier: rename and some other features need an Intelephense licence."),
    },
    ServerDef {
        id: "json",
        name: "JSON Language Server",
        package: "web",
        entry: "node_modules/vscode-langservers-extracted/bin/vscode-json-language-server",
        args: &["--stdio"],
        languages: &["json", "jsonc"],
        note: None,
    },
    ServerDef {
        id: "css",
        name: "CSS Language Server",
        package: "web",
        entry: "node_modules/vscode-langservers-extracted/bin/vscode-css-language-server",
        args: &["--stdio"],
        languages: &["css", "scss", "less"],
        note: None,
    },
    ServerDef {
        id: "html",
        name: "HTML Language Server",
        package: "web",
        entry: "node_modules/vscode-langservers-extracted/bin/vscode-html-language-server",
        args: &["--stdio"],
        languages: &["html"],
        note: None,
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
            assert!(server.entry.starts_with("node_modules/"));
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
            assert!(
                package.package_lock.contains("\"integrity\""),
                "{}",
                package.id
            );
            assert!(package.package_json.contains("\"dependencies\""));
        }
    }
}
