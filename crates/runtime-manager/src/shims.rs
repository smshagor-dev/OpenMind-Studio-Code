use std::fs;
use std::path::Path;

use crate::error::RuntimeError;
use crate::manifest::{RuntimeManifest, Shim};

/// The file a shim is written to: `pip.cmd` on Windows, `pip` elsewhere.
pub fn shim_file_name(shim: &Shim) -> String {
    if cfg!(windows) {
        format!("{}.cmd", shim.name)
    } else {
        shim.name.clone()
    }
}

/// The script text for one shim. It finds its runtime by a path *relative to
/// the shim's own location* (`runtimes/<kind>/shims/<version>/` ->
/// `runtimes/<kind>/versions/<version>/`), so the whole app folder can be
/// moved and nothing here has to be rewritten. Compare `pip.exe`, which
/// Python generates with the absolute interpreter path baked in.
///
/// Names, targets and arguments are validated by the manifest (no quotes,
/// `%`, `&`, ...), so they can be written into a script as they are.
pub fn render(shim: &Shim, version: &str) -> String {
    let args: String = shim.args.iter().map(|arg| format!(" {arg}")).collect();
    if cfg!(windows) {
        let target = shim.target.replace('/', "\\");
        format!("@echo off\r\n\"%~dp0..\\..\\versions\\{version}\\{target}\"{args} %*\r\n")
    } else {
        format!(
            "#!/bin/sh\nexec \"$(dirname \"$0\")/../../versions/{version}/{}\"{args} \"$@\"\n",
            shim.target
        )
    }
}

/// Writes every shim the manifest declares into `shim_dir`, replacing any
/// that exist. Fails loudly: a runtime whose commands can't be created isn't
/// reported as installed.
pub fn write_shims(
    manifest: &RuntimeManifest,
    version: &str,
    shim_dir: &Path,
) -> Result<(), RuntimeError> {
    if manifest.shims.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(shim_dir).map_err(|err| RuntimeError::io(shim_dir, err))?;
    for shim in &manifest.shims {
        let file = shim_dir.join(shim_file_name(shim));
        fs::write(&file, render(shim, version)).map_err(|err| RuntimeError::io(&file, err))?;
        make_executable(&file)?;
    }
    Ok(())
}

/// Whether every declared shim exists in `shim_dir` (trivially true with none).
pub fn shims_present(manifest: &RuntimeManifest, shim_dir: &Path) -> bool {
    manifest
        .shims
        .iter()
        .all(|shim| shim_dir.join(shim_file_name(shim)).is_file())
}

#[cfg(unix)]
fn make_executable(file: &Path) -> Result<(), RuntimeError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(file, fs::Permissions::from_mode(0o755))
        .map_err(|err| RuntimeError::io(file, err))
}

#[cfg(not(unix))]
fn make_executable(_file: &Path) -> Result<(), RuntimeError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pip() -> Shim {
        Shim {
            name: "pip".into(),
            target: "python.exe".into(),
            args: vec!["-m".into(), "pip".into()],
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_shim_calls_the_interpreter_relative_to_itself_and_forwards_arguments() {
        assert_eq!(
            render(&pip(), "3.14.7"),
            "@echo off\r\n\"%~dp0..\\..\\versions\\3.14.7\\python.exe\" -m pip %*\r\n"
        );
    }

    #[cfg(windows)]
    #[test]
    fn nested_targets_use_backslashes_and_never_an_absolute_path() {
        let shim = Shim {
            name: "git".into(),
            target: "cmd/git.exe".into(),
            args: vec![],
        };

        let text = render(&shim, "2.55.0.5");

        assert!(text.contains("versions\\2.55.0.5\\cmd\\git.exe"), "{text}");
        assert!(!text.contains(":\\"), "{text}");
    }

    #[cfg(unix)]
    #[test]
    fn a_unix_shim_is_relative_and_forwards_arguments() {
        assert!(render(&pip(), "3.14.7")
            .contains("$(dirname \"$0\")/../../versions/3.14.7/python.exe\" -m pip \"$@\""));
    }
}
