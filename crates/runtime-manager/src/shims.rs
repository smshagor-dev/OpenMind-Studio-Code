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
    let text = with_path_dirs(shim, version, render_plain(shim, version));
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

/// Puts the shim's `pathDirs` in front of PATH for the command it starts only (`setlocal` on Windows; a variable of the
/// `exec`ed process elsewhere), found relative to the shim like its target.
fn with_path_dirs(shim: &Shim, version: &str, text: String) -> String {
    if shim.path_dirs.is_empty() {
        return text;
    }
    if cfg!(windows) {
        let dirs: String = shim
            .path_dirs
            .iter()
            .map(|dir| {
                format!(
                    "%~dp0..\\..\\versions\\{version}\\{};",
                    dir.replace('/', "\\")
                )
            })
            .collect();
        text.replacen(
            "@echo off\r\n",
            &format!("@echo off\r\nsetlocal\r\nset \"PATH={dirs}%PATH%\"\r\n"),
            1,
        )
    } else {
        let dirs: String = shim
            .path_dirs
            .iter()
            .map(|dir| format!("$(dirname \"$0\")/../../versions/{version}/{dir}:"))
            .collect();
        text.replacen(
            "#!/bin/sh\n",
            &format!("#!/bin/sh\nPATH=\"{dirs}$PATH\"\nexport PATH\n"),
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
            path_dirs: Vec::new(),
        }
    }

    #[cfg(windows)]
    #[test]
    fn path_dirs_reach_only_the_command_the_shim_starts() {
        let gcc = Shim {
            name: "gcc".into(),
            target: "bin/gcc.exe".into(),
            args: Vec::new(),
            via_env: None,
            proxy_env: None,
            path_dirs: vec!["bin".into()],
        };
        assert_eq!(
            render(&gcc, "13.1.0"),
            "@echo off\r\nsetlocal\r\nset \"PATH=%~dp0..\\..\\versions\\13.1.0\\bin;%PATH%\"\r\n\"%~dp0..\\..\\versions\\13.1.0\\bin\\gcc.exe\" %*\r\n"
        );
        // Without path_dirs nothing changes.
        assert!(!render(&pip(), "3.14.7").contains("setlocal"));
    }

    /// A launcher written for the real w64devkit (`OPENMIND_TEST_W64DEVKIT` = the install folder holding `bin/`) runs
    /// gcc with a PATH that has only System32, and the build still finds `as` and `ld`.
    #[cfg(windows)]
    #[test]
    fn a_path_dirs_launcher_builds_with_a_bare_path() {
        let Some(install) = std::env::var_os("OPENMIND_TEST_W64DEVKIT") else {
            eprintln!("skipped: OPENMIND_TEST_W64DEVKIT is not set");
            return;
        };
        let temp = tempfile::tempdir().expect("tempdir");
        let kind = temp.path().join("runtimes").join("fortran");
        let version = kind.join("versions").join("13.1.0");
        std::fs::create_dir_all(version.parent().expect("parent")).expect("dirs");
        // The install is too big to copy: `versions/13.1.0` is a directory junction to it (no privileges needed).
        let linked = std::process::Command::new("cmd")
            .arg("/c")
            .arg("mklink")
            .arg("/J")
            .arg(&version)
            .arg(&install)
            .output()
            .is_ok_and(|out| out.status.success());
        assert!(linked, "couldn't create the junction");
        let shim_dir = kind.join("shims").join("13.1.0");
        std::fs::create_dir_all(&shim_dir).expect("shims");
        let gfortran = Shim {
            name: "gfortran".into(),
            target: "bin/gfortran.exe".into(),
            args: Vec::new(),
            via_env: None,
            proxy_env: None,
            path_dirs: vec!["bin".into()],
        };
        std::fs::write(shim_dir.join("gfortran.cmd"), render(&gfortran, "13.1.0")).expect("shim");
        let source = temp.path().join("hello.f90");
        std::fs::write(
            &source,
            "program hello\n  print '(a)', 'shim ok'\nend program\n",
        )
        .expect("source");
        let exe = temp.path().join("hello.exe");
        let system32 =
            std::path::PathBuf::from(std::env::var_os("SystemRoot").expect("SystemRoot"))
                .join("System32");
        let status = std::process::Command::new(shim_dir.join("gfortran.cmd"))
            .arg(&source)
            .arg("-o")
            .arg(&exe)
            .env("PATH", &system32)
            .status()
            .expect("run shim");
        assert!(status.success(), "the build failed through the launcher");
        let out = std::process::Command::new(&exe)
            .output()
            .expect("run program");
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "shim ok");
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
            path_dirs: Vec::new(),
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
            path_dirs: Vec::new(),
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
            path_dirs: Vec::new(),
        };
        let text = render(&shim, "2.10.3");
        assert!(
            text.starts_with("@echo off\r\nsetlocal\r\nif defined OPENMIND_COMPOSER_PROXY set \"HTTPS_PROXY=%OPENMIND_COMPOSER_PROXY%\"\r\n"),
            "{text}"
        );
        assert!(text.contains("\"%OPENMIND_PHP%\""), "{text}");
        let plain = Shim {
            proxy_env: None,
            path_dirs: Vec::new(),
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
