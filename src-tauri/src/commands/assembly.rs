//! Assembly support's app side: the user's Assembly settings as the runner's build options, and asm-lsp's
//! configuration (which `.asm-lsp.toml` it reads).

use std::path::{Path, PathBuf};

use openmind_runner::{Arch, AssemblyOptions, RunEnvironment};

use crate::app_state::AppState;
use crate::commands::preferences::{user_bool, user_string};

/// The build options of an assembly file, from the user's settings (never from the page asking for the run).
pub fn options(state: &AppState) -> AssemblyOptions {
    AssemblyOptions {
        arch: Arch::parse(&user_string(state, "assembly.architecture")),
        assembler_args: user_string(state, "assembly.extraAssemblerArgs"),
        linker_args: user_string(state, "assembly.extraLinkerArgs"),
    }
}

/// The Assembly runtime's optional 32-bit toolchain.
pub const X86_ADDON: &str = "x86";

/// After the Assembly runtime is installed: with the architecture set to x86, its x86 part is added in the same step,
/// so the install is complete for what Run Code will build. A failure keeps the runtime and names what is missing.
pub async fn after_install(
    state: &AppState,
    installed: &openmind_runtime_manager::InstalledVersion,
    progress: openmind_runtime_manager::manager::ProgressSink,
) -> Result<(), String> {
    if options(state).arch != Arch::X86 || x86_present(installed) {
        return Ok(());
    }
    state
        .runtime
        .install_addon("assembly", &installed.version, X86_ADDON, progress)
        .await
        .map_err(|err| {
            format!(
                "Assembly {} was installed, but its x86 (32-bit) toolchain couldn't be added: {} Add it on the Assembly card.",
                installed.version,
                err.user_message()
            )
        })
}

fn x86_present(installed: &openmind_runtime_manager::InstalledVersion) -> bool {
    installed
        .addons
        .iter()
        .any(|addon| addon.id == X86_ADDON && addon.installed)
}

/// Whether asm-lsp may run for assembly files (the `assembly.enableLanguageServer` setting, on by default).
pub fn language_server_enabled(state: &AppState) -> bool {
    user_bool(state, "assembly.enableLanguageServer")
}

/// The folder asm-lsp reads its `.asm-lsp.toml` from: `None` when the project has its own (asm-lsp then reads the
/// workspace's), else `AppPaths::asm_lsp_config_dir` (`<app>/settings/asm-lsp`, or this computer's folder in the
/// per-computer data scope: it holds this computer's absolute NASM path), with the configuration written from the
/// Assembly settings and the NASM the Run Code environment finds. Nothing is ever written into the project.
pub fn lsp_config_root(
    state: &AppState,
    workspace: &Path,
    environment: &RunEnvironment,
) -> Result<Option<PathBuf>, String> {
    if workspace.join(".asm-lsp.toml").is_file() {
        return Ok(None);
    }
    let system_path = std::env::var_os("PATH");
    let nasm = openmind_runner::assembly::find_nasm(environment, system_path.as_deref());
    let arch = options(state).arch;
    let config = openmind_runner::assembly::asm_lsp_config(nasm.as_deref(), arch);
    let folder = state.paths.asm_lsp_config_dir.clone();
    write_if_changed(&folder.join(".asm-lsp.toml"), &config)?;
    note_config_folder();
    Ok(Some(folder))
}

/// Whether `%APPDATA%\asm-lsp` existed before OpenMind first started asm-lsp in this run (asm-lsp creates it, empty,
/// while it looks for a global configuration — upstream behaviour). Set once.
static CONFIG_FOLDER_EXISTED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

fn global_config_folder() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|appdata| PathBuf::from(appdata).join("asm-lsp"))
}

fn note_config_folder() {
    CONFIG_FOLDER_EXISTED
        .get_or_init(|| global_config_folder().is_some_and(|folder| folder.exists()));
}

/// At shutdown (after the language servers stopped): removes `%APPDATA%\asm-lsp` only when this run's asm-lsp made
/// it and it is still empty. A folder that was there before, or that holds anything, is left alone.
pub fn remove_empty_config_folder() {
    if CONFIG_FOLDER_EXISTED.get() != Some(&false) {
        return;
    }
    if let Some(folder) = global_config_folder() {
        remove_if_empty(&folder);
    }
}

fn remove_if_empty(folder: &Path) {
    let empty = std::fs::read_dir(folder).is_ok_and(|mut entries| entries.next().is_none());
    // `remove_dir` (never recursive) also refuses a folder that gained a file meanwhile.
    if empty && std::fs::remove_dir(folder).is_ok() {
        tracing::info!(folder = %folder.display(), "removed the empty folder asm-lsp created");
    }
}

fn write_if_changed(file: &Path, text: &str) -> Result<(), String> {
    if std::fs::read_to_string(file).is_ok_and(|current| current == text) {
        return Ok(());
    }
    let folder = file.parent().ok_or("asm-lsp's settings have no folder.")?;
    std::fs::create_dir_all(folder)
        .map_err(|err| format!("Couldn't create {}: {err}", folder.display()))?;
    std::fs::write(file, text).map_err(|err| format!("Couldn't write {}: {err}", file.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_empty_folder_is_removed() {
        let dir = tempfile::tempdir().expect("tmp");
        let empty = dir.path().join("asm-lsp");
        std::fs::create_dir(&empty).expect("dir");
        remove_if_empty(&empty);
        assert!(!empty.exists());
        let used = dir.path().join("used");
        std::fs::create_dir(&used).expect("dir");
        std::fs::write(used.join(".asm-lsp.toml"), "x").expect("file");
        remove_if_empty(&used);
        assert!(
            used.join(".asm-lsp.toml").is_file(),
            "a folder with anything in it stays"
        );
        remove_if_empty(&dir.path().join("missing"));
    }

    #[test]
    fn the_config_is_rewritten_only_when_it_changes() {
        let dir = tempfile::tempdir().expect("tmp");
        let file = dir.path().join("asm-lsp").join(".asm-lsp.toml");
        write_if_changed(&file, "a = 1\n").expect("write");
        let first = std::fs::metadata(&file)
            .and_then(|m| m.modified())
            .expect("time");
        std::thread::sleep(std::time::Duration::from_millis(20));
        write_if_changed(&file, "a = 1\n").expect("same");
        assert_eq!(
            std::fs::metadata(&file)
                .and_then(|m| m.modified())
                .expect("time"),
            first
        );
        write_if_changed(&file, "a = 2\n").expect("changed");
        assert_eq!(std::fs::read_to_string(&file).expect("read"), "a = 2\n");
    }
}
