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
    let text = render_plain(shim, version);
    let Some(var) = &shim.proxy_env else {
        return text;
    };
    // The proxy is set for this command only: `setlocal` keeps it out of the shell that ran it.
    if cfg!(windows) {
        text.replacen(
            "@echo off\r\n",
            &format!("@echo off\r\nsetlocal\r\nif defined {var} set \"HTTPS_PROXY=%{var}%\"\r\n"),
            1,
        )
    } else {
        text.replacen(
            "#!/bin/sh\n",
            &format!("#!/bin/sh\n[ -n \"${var}\" ] && export HTTPS_PROXY=\"${var}\"\n"),
            1,
        )
    }
}

fn render_plain(shim: &Shim, version: &str) -> String {
    let args: String = shim.args.iter().map(|arg| format!(" {arg}")).collect();
    if let Some(var) = &shim.via_env {
        return render_via(shim, version, var, &args);
    }
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

/// A shim whose target is a script run by the interpreter in `var` (set at
/// launch from the active install). With the variable unset it says so
/// instead of falling back to whatever `php` happens to be on the machine.
fn render_via(shim: &Shim, version: &str, var: &str, args: &str) -> String {
    if cfg!(windows) {
        let target = shim.target.replace('/', "\\");
        format!(
            "@echo off\r\nif not defined {var} (\r\n  echo OpenMind Studio: the runtime this command needs is not installed or not active. Install it from its Runtime Manager view.>&2\r\n  exit /b 1\r\n)\r\n\"%{var}%\" \"%~dp0..\\..\\versions\\{version}\\{target}\"{args} %*\r\n"
        )
    } else {
        format!(
            "#!/bin/sh\n[ -n \"${var}\" ] || {{ echo \"OpenMind Studio: the runtime this command needs is not installed or not active.\" >&2; exit 1; }}\nexec \"${var}\" \"$(dirname \"$0\")/../../versions/{version}/{}\"{args} \"$@\"\n",
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

/// Whether every declared shim exists in `shim_dir` with the text this version of OpenMind writes, so a launcher
/// written by an older version is rewritten (trivially true with none).
pub fn shims_present(manifest: &RuntimeManifest, version: &str, shim_dir: &Path) -> bool {
    manifest.shims.iter().all(|shim| {
        fs::read_to_string(shim_dir.join(shim_file_name(shim)))
            .is_ok_and(|text| text == render(shim, version))
    })
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
            via_env: None,
            proxy_env: None,
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
    fn a_via_env_shim_runs_its_target_with_the_named_interpreter_and_never_a_global_one() {
        let shim = Shim {
            name: "composer".into(),
            target: "composer.phar".into(),
            args: vec![],
            via_env: Some("OPENMIND_PHP".into()),
            proxy_env: None,
        };

        let text = render(&shim, "2.10.3");

        assert!(text.contains("if not defined OPENMIND_PHP"), "{text}");
        assert!(
            text.contains("\"%OPENMIND_PHP%\" \"%~dp0..\\..\\versions\\2.10.3\\composer.phar\" %*"),
            "{text}"
        );
        assert!(!text.contains(":\\"), "{text}");
        assert!(!text.contains("php.exe"), "{text}");
    }

    #[cfg(windows)]
    #[test]
    fn nested_targets_use_backslashes_and_never_an_absolute_path() {
        let shim = Shim {
            name: "git".into(),
            target: "cmd/git.exe".into(),
            args: vec![],
            via_env: None,
            proxy_env: None,
        };

        let text = render(&shim, "2.55.0.5");

        assert!(text.contains("versions\\2.55.0.5\\cmd\\git.exe"), "{text}");
        assert!(!text.contains(":\\"), "{text}");
    }

    #[cfg(windows)]
    #[test]
    fn a_proxy_env_shim_sets_the_proxy_for_its_own_command_only() {
        let shim = Shim {
            name: "composer".into(),
            target: "composer.phar".into(),
            args: vec![],
            via_env: Some("OPENMIND_PHP".into()),
            proxy_env: Some("OPENMIND_COMPOSER_PROXY".into()),
        };
        let text = render(&shim, "2.10.3");
        assert!(
            text.starts_with("@echo off\r\nsetlocal\r\nif defined OPENMIND_COMPOSER_PROXY set \"HTTPS_PROXY=%OPENMIND_COMPOSER_PROXY%\"\r\n"),
            "{text}"
        );
        assert!(text.contains("\"%OPENMIND_PHP%\""), "{text}");
        let plain = Shim {
            proxy_env: None,
            ..shim
        };
        assert!(
            !render(&plain, "2.10.3").contains("setlocal"),
            "unchanged without proxyEnv"
        );
    }

    #[test]
    fn an_outdated_launcher_is_not_counted_as_present() {
        let tmp = tempfile::tempdir().expect("tmp");
        let manifest: RuntimeManifest =
            serde_json::from_str(include_str!("../manifests/composer.json")).expect("manifest");
        assert_eq!(
            manifest.shims[0].proxy_env.as_deref(),
            Some("OPENMIND_COMPOSER_PROXY")
        );
        let file = tmp.path().join(shim_file_name(&manifest.shims[0]));
        std::fs::write(&file, "@echo off\r\nold launcher\r\n").expect("old");
        assert!(!shims_present(&manifest, "2.10.3", tmp.path()));
        write_shims(&manifest, "2.10.3", tmp.path()).expect("write");
        assert!(shims_present(&manifest, "2.10.3", tmp.path()));
    }

    #[cfg(unix)]
    #[test]
    fn a_unix_shim_is_relative_and_forwards_arguments() {
        assert!(render(&pip(), "3.14.7")
            .contains("$(dirname \"$0\")/../../versions/3.14.7/python.exe\" -m pip \"$@\""));
    }
}
