//! The offline LSP bundle's build helper, used by `scripts/prepare-lsp-bundle.mjs`:
//!
//! ```text
//! cargo run -q -p openmind-lsp --example bundle_tool -- pack <package id> <folder> <out.zip>
//! cargo run -q -p openmind-lsp --example bundle_tool -- extract <archive.zip> <folder>
//! cargo run -q -p openmind-lsp --example bundle_tool -- packages
//! ```
//!
//! `pack` refuses a folder that lacks the entry file of any server of the package, then
//! prints one JSON line: `{"package":..,"revision":..,"contents":..,"sha256":..,"size":..,"files":..}`.
//! `extract` uses the same checked extractor as the app (no `..`, no links, size caps).
//! `packages` prints the registry's packages as JSON (`id`, `revision`, `contents`, `native`, `redistributable`).

use std::path::PathBuf;
use std::process::ExitCode;

use openmind_lsp::pack::create_pack;
use openmind_lsp::registry::{PACKAGES, SERVERS};
use openmind_lsp::unpack::{extract, sha256_file};
use openmind_lsp::{package_by_id, LspError, Source};

fn usage() -> LspError {
    LspError::InstallFailed(
        "usage: bundle_tool pack <package id> <folder> <out.zip> | extract <zip> <folder> | packages"
            .into(),
    )
}

fn run(args: &[String]) -> Result<String, LspError> {
    match args {
        [command, id, folder, out] if command == "pack" => pack(id, folder, out),
        [command, archive, folder] if command == "extract" => {
            extract(&PathBuf::from(archive), &PathBuf::from(folder))?;
            Ok(String::new())
        }
        [command] if command == "packages" => Ok(serde_json::Value::Array(
            PACKAGES
                .iter()
                .map(|package| {
                    serde_json::json!({
                        "id": package.id,
                        "revision": package.revision,
                        "contents": package.contents,
                        "native": matches!(package.source, Source::Native),
                        "redistributable": package.redistributable,
                    })
                })
                .collect(),
        )
        .to_string()),
        _ => Err(usage()),
    }
}

fn pack(id: &str, folder: &str, out: &str) -> Result<String, LspError> {
    let package = package_by_id(id)
        .ok_or_else(|| LspError::InstallFailed(format!("unknown package {id}")))?;
    let folder = PathBuf::from(folder);
    for server in SERVERS.iter().filter(|server| server.package == package.id) {
        if !folder.join(server.entry).is_file() {
            return Err(LspError::InstallFailed(format!(
                "{}: {} is missing from {}",
                server.id,
                server.entry,
                folder.display()
            )));
        }
    }
    let out = PathBuf::from(out);
    let files = create_pack(&folder, &out)?;
    let size = std::fs::metadata(&out)
        .map_err(|err| LspError::InstallFailed(err.to_string()))?
        .len();
    Ok(serde_json::json!({
        "package": package.id,
        "revision": package.revision,
        "contents": package.contents,
        "sha256": sha256_file(&out)?,
        "size": size,
        "files": files,
    })
    .to_string())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(line) => {
            if !line.is_empty() {
                println!("{line}");
            }
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("{err}");
            ExitCode::FAILURE
        }
    }
}
