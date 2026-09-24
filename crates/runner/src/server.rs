//! The PHP built-in web server as a managed process: `php -S 127.0.0.1:<port>
//! -t <root>`, run by the portable PHP only, bound to loopback so nothing is
//! exposed to the network. Planning only — starting, streaming and killing the
//! process tree is the same [`crate::RunRegistry`] machinery Run Code uses.

use std::ffi::OsString;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::display::command_line;
use crate::error::RunError;
use crate::kind::RunnableKind;
use crate::plan::{child_path, RunPlan};
use crate::runtime::{resolve_executable, runtime_label, RunEnvironment, RuntimeSource};

/// The only address the server binds to.
pub const LOOPBACK: &str = "127.0.0.1";
pub const DEFAULT_PORT: u16 = 8000;
/// Ports below this need elevated rights on some systems; they are never offered.
pub const MIN_PORT: u16 = 1024;

/// What the UI asks for: which folder to serve and on which port.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhpServerRequest {
    pub root: PathBuf,
    pub port: u16,
}

/// The URL the server answers on.
pub fn server_url(port: u16) -> String {
    format!("http://{LOOPBACK}:{port}")
}

/// Whether nothing is listening on (or has reserved) `port` on the loopback
/// address right now. A check made a moment before starting — the start
/// itself can still fail if another program grabs the port in between.
pub fn port_is_free(port: u16) -> bool {
    TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).is_ok()
}

/// An existing, absolute folder to serve.
pub fn validate_root(root: &Path) -> Result<PathBuf, RunError> {
    let text = root.to_string_lossy();
    if text.is_empty() || text.contains('\0') || !root.is_absolute() || !root.is_dir() {
        return Err(RunError::BadServerRoot);
    }
    Ok(root.to_path_buf())
}

pub fn validate_port(port: u16) -> Result<u16, RunError> {
    if port < MIN_PORT {
        return Err(RunError::BadPort(port));
    }
    Ok(port)
}

/// Validates the request and resolves the portable PHP; nothing is started.
/// A machine's PHP (XAMPP, ...) is never considered: only the Runtime
/// Manager's own `path_prepend` folders are searched.
pub fn php_server_plan(
    request: &PhpServerRequest,
    environment: &RunEnvironment,
    system_path: Option<OsString>,
) -> Result<RunPlan, RunError> {
    let root = validate_root(&request.root)?;
    let port = validate_port(request.port)?;
    let resolved = resolve_executable("php", environment, &[], None)
        .filter(|found| found.source == RuntimeSource::Portable)
        .ok_or_else(|| RunError::RuntimeMissing {
            runtime: RunnableKind::Php.display_name().to_string(),
        })?;

    let address = format!("{LOOPBACK}:{port}");
    let argv = vec![
        resolved.path.to_string_lossy().into_owned(),
        "-S".to_string(),
        address.clone(),
        "-t".to_string(),
        root.to_string_lossy().into_owned(),
    ];
    let display = command_line(&[
        "php".to_string(),
        "-S".to_string(),
        address,
        "-t".to_string(),
        root.to_string_lossy().into_owned(),
    ]);
    let path_var = child_path(environment, &[], &resolved, system_path)?;
    Ok(RunPlan {
        kind: RunnableKind::Php,
        file: root.clone(),
        argv,
        cwd: root,
        env: environment.vars.clone(),
        path_var,
        runtime_label: runtime_label(RunnableKind::Php, &resolved),
        source: resolved.source,
        display,
        resolved: resolved.path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Fixture {
        dir: tempfile::TempDir,
        env: RunEnvironment,
    }

    fn fixture(with_php: bool) -> Fixture {
        let dir = tempfile::tempdir().expect("tempdir");
        let php_dir = dir
            .path()
            .join("runtimes")
            .join("php")
            .join("versions")
            .join("8.4.26");
        fs::create_dir_all(&php_dir).expect("php dir");
        if with_php {
            fs::write(php_dir.join("php.exe"), b"x").expect("php");
        }
        let env = RunEnvironment {
            path_prepend: vec![php_dir],
            vars: vec![("OPENMIND_PHP".into(), "x".into())],
        };
        Fixture { dir, env }
    }

    fn request(root: &Path, port: u16) -> PhpServerRequest {
        PhpServerRequest {
            root: root.to_path_buf(),
            port,
        }
    }

    #[cfg(windows)]
    #[test]
    fn the_command_serves_the_folder_on_loopback_with_the_portable_php() {
        let fx = fixture(true);
        let root = fx.dir.path().join("My Site");
        fs::create_dir_all(&root).expect("root");

        let plan = php_server_plan(&request(&root, 8000), &fx.env, None).expect("plan");

        assert_eq!(plan.argv[1..4], ["-S", "127.0.0.1:8000", "-t"]);
        assert_eq!(plan.argv[4], root.to_string_lossy());
        assert!(plan.argv[0].contains("versions"), "{:?}", plan.argv);
        assert_eq!(plan.resolved.to_string_lossy(), plan.argv[0]);
        assert_eq!(plan.cwd, root);
        assert_eq!(plan.runtime_label, "OpenMind portable PHP 8.4.26");
        // A path with spaces is one argument, and the display quotes it.
        assert_eq!(plan.argv.len(), 5);
        assert!(
            plan.display.starts_with("php -S 127.0.0.1:8000 -t \""),
            "{}",
            plan.display
        );
        assert!(!plan.argv.iter().any(|arg| arg.contains("0.0.0.0")));
    }

    #[test]
    fn without_a_portable_php_it_says_so_even_when_the_machine_has_one() {
        let fx = fixture(false);
        let system = fx.dir.path().join("xampp");
        fs::create_dir_all(&system).expect("xampp");
        let name = if cfg!(windows) { "php.exe" } else { "php" };
        fs::write(system.join(name), b"x").expect("system php");
        let root = fx.dir.path().join("site");
        fs::create_dir_all(&root).expect("root");
        let path = std::env::join_paths([&system]).expect("path");

        let error =
            php_server_plan(&request(&root, 8000), &fx.env, Some(path)).expect_err("no php");

        assert_eq!(error.to_string(), "PHP runtime is not installed yet.");
    }

    #[test]
    fn a_missing_relative_or_file_root_is_refused_with_the_select_a_folder_reason() {
        let fx = fixture(true);
        let file = fx.dir.path().join("a.txt");
        fs::write(&file, "x").expect("file");
        for root in [
            fx.dir.path().join("missing"),
            PathBuf::from("relative/dir"),
            PathBuf::new(),
            file,
        ] {
            let error = php_server_plan(&request(&root, 8000), &fx.env, None).expect_err("refused");
            assert_eq!(error.to_string(), "Select a valid project folder first.");
        }
    }

    #[test]
    fn privileged_or_zero_ports_are_refused() {
        assert!(validate_port(0).is_err());
        assert!(validate_port(80).is_err());
        assert!(validate_port(1023).is_err());
        assert_eq!(validate_port(1024).expect("ok"), 1024);
        assert_eq!(validate_port(65535).expect("ok"), 65535);
    }

    #[test]
    fn a_port_someone_is_listening_on_is_reported_busy() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();

        assert!(!port_is_free(port));
        drop(listener);
        assert!(port_is_free(port));
    }

    #[test]
    fn the_url_uses_the_loopback_address() {
        assert_eq!(server_url(8000), "http://127.0.0.1:8000");
    }
}
