//! Installing a missing Python or npm package for a project, on the user's request only: which folder is the project,
//! whether a name is safe to pass to pip/npm, and the exact argument list. Nothing here runs a program — the app types
//! the command into a terminal after the user confirmed it. Python packages always go into an interpreter named by its
//! absolute path (a project virtual environment or OpenMind's portable Python), never a bare `python` that could be the
//! user's own Python; nothing is installed with `--user` or globally (`npm -g`).

use std::path::{Path, PathBuf};

use crate::env::file_url;
use crate::wheelhouse::{valid_requirement, RequirementError};

/// Modules that ship with Python (or are built into it): pip can't install them, and `pip install tkinter` would fetch
/// an unrelated package. A missing one means the Python build lacks a component (Tcl/Tk, SQLite, OpenSSL ...).
pub const PYTHON_STDLIB: &[&str] = &[
    "tkinter",
    "_tkinter",
    "turtle",
    "turtledemo",
    "idlelib",
    "sqlite3",
    "_sqlite3",
    "ssl",
    "_ssl",
    "hashlib",
    "_hashlib",
    "ctypes",
    "_ctypes",
    "venv",
    "ensurepip",
    "lzma",
    "_lzma",
    "bz2",
    "_bz2",
    "zlib",
    "readline",
    "curses",
    "_curses",
    "dbm",
    "_dbm",
    "_gdbm",
    "decimal",
    "_decimal",
    "uuid",
    "_uuid",
    "json",
    "os",
    "sys",
    "re",
    "math",
    "random",
    "datetime",
    "time",
    "pathlib",
    "subprocess",
    "threading",
    "asyncio",
    "socket",
    "http",
    "urllib",
    "email",
    "xml",
    "csv",
    "logging",
    "unittest",
    "collections",
    "itertools",
    "functools",
    "typing",
    "statistics",
    "string",
    "struct",
    "shutil",
    "glob",
    "tempfile",
    "pickle",
    "copy",
    "argparse",
    "configparser",
    "zipfile",
    "tarfile",
    "gzip",
    "base64",
    "secrets",
    "hmac",
    "html",
    "io",
    "abc",
    "enum",
    "dataclasses",
    "contextlib",
    "traceback",
    "inspect",
    "platform",
    "signal",
    "queue",
    "multiprocessing",
    "concurrent",
    "select",
    "selectors",
    "codecs",
    "locale",
    "gettext",
    "textwrap",
    "difflib",
    "pprint",
    "heapq",
    "bisect",
    "array",
    "weakref",
    "fractions",
    "numbers",
    "operator",
    "timeit",
    "cProfile",
    "profile",
    "pdb",
    "doctest",
    "wave",
    "audioop",
    "winreg",
    "winsound",
    "msvcrt",
    "_winapi",
    "nt",
    "posix",
    "tomllib",
    "zoneinfo",
    "graphlib",
    "ipaddress",
    "mimetypes",
    "webbrowser",
    "smtplib",
    "imaplib",
    "poplib",
    "ftplib",
    "telnetlib",
    "xmlrpc",
    "wsgiref",
    "sched",
    "calendar",
    "cmath",
    "colorsys",
    "filecmp",
    "fileinput",
    "fnmatch",
    "getpass",
    "keyword",
    "linecache",
    "mailbox",
    "netrc",
    "optparse",
    "pkgutil",
    "plistlib",
    "py_compile",
    "compileall",
    "quopri",
    "reprlib",
    "rlcompleter",
    "runpy",
    "shelve",
    "shlex",
    "site",
    "stat",
    "symtable",
    "sysconfig",
    "tabnanny",
    "token",
    "tokenize",
    "trace",
    "tracemalloc",
    "types",
    "unicodedata",
    "warnings",
    "zipapp",
    "zipimport",
    "__future__",
    "builtins",
    "importlib",
    "atexit",
    "code",
    "codeop",
    "copyreg",
    "errno",
    "faulthandler",
    "gc",
    "marshal",
];

/// Whether `module` (an import name such as `tkinter` or `xml.dom`) is part of Python itself.
pub fn is_python_stdlib(module: &str) -> bool {
    let top = module.split('.').next().unwrap_or(module);
    PYTHON_STDLIB.contains(&top)
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PackageError {
    #[error(transparent)]
    Requirement(#[from] RequirementError),
    #[error("{0} is part of Python itself (a Python build component), not a pip package; pip can't install it.")]
    Stdlib(String),
    #[error("\"{0}\" isn't an npm package name (for example lodash, @types/node or express@5).")]
    InvalidNpm(String),
}

/// An npm package: an optional `@scope/`, a lowercase name, and an optional `@version` of plain version characters.
/// No paths, URLs, `git+` specs, options or shell characters.
pub fn valid_npm_package(text: &str) -> bool {
    let part_ok = |part: &str| {
        !part.is_empty()
            && part.len() <= 214
            && !part.starts_with(['.', '_', '-'])
            && part.chars().all(|c| {
                c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '.' | '_' | '~')
            })
    };
    let (name, version) = match text.strip_prefix('@') {
        Some(rest) => {
            let Some((scope, rest)) = rest.split_once('/') else {
                return false;
            };
            if !part_ok(scope) {
                return false;
            }
            match rest.split_once('@') {
                Some((name, version)) => (name, Some(version)),
                None => (rest, None),
            }
        }
        None => match text.split_once('@') {
            Some((name, version)) => (name, Some(version)),
            None => (text, None),
        },
    };
    part_ok(name)
        && version.is_none_or(|v| {
            !v.is_empty()
                && v.len() <= 64
                && v.chars().all(|c| {
                    c.is_ascii_alphanumeric() || matches!(c, '.' | '^' | '~' | '*' | '-' | '+')
                })
        })
}

/// The project folder for `start` (a file's folder or a terminal's folder): the nearest folder from `start` up to
/// `stop` (inclusive) that has one of `markers`; otherwise `start` itself. Never goes above `stop`.
pub fn project_dir(start: &Path, stop: &Path, markers: &[&str]) -> PathBuf {
    let mut dir = Some(start);
    while let Some(current) = dir {
        if markers.iter().any(|marker| current.join(marker).exists()) {
            return current.to_path_buf();
        }
        if current == stop || !current.starts_with(stop) {
            break;
        }
        dir = current.parent();
    }
    start.to_path_buf()
}

/// Files that mark a Python project.
pub const PYTHON_MARKERS: &[&str] = &[
    "requirements.txt",
    "pyproject.toml",
    "setup.py",
    ".venv",
    "venv",
];
/// Files that mark an npm project.
pub const NODE_MARKERS: &[&str] = &["package.json"];

/// The project's own virtual environment interpreter (`.venv` or `venv`), if there is one.
pub fn venv_python(project: &Path) -> Option<PathBuf> {
    [".venv", "venv"]
        .iter()
        .map(|name| {
            if cfg!(windows) {
                project.join(name).join("Scripts").join("python.exe")
            } else {
                project.join(name).join("bin").join("python")
            }
        })
        .find(|path| path.is_file())
}

fn checked_packages(packages: &[String]) -> Result<Vec<String>, PackageError> {
    if packages.is_empty() {
        return Err(RequirementError::Empty.into());
    }
    for package in packages {
        if !valid_requirement(package) {
            return Err(RequirementError::Invalid(package.clone()).into());
        }
        let name = package
            .split(['[', '=', '<', '>', '!', '~'])
            .next()
            .unwrap_or(package);
        if is_python_stdlib(name) {
            return Err(PackageError::Stdlib(name.to_string()));
        }
    }
    Ok(packages.to_vec())
}

/// `<interpreter> -m pip install <packages>` (online, through the proxy the terminal has).
pub fn pip_install_argv(
    interpreter: &Path,
    packages: &[String],
) -> Result<Vec<String>, PackageError> {
    let mut argv = pip_base(interpreter);
    argv.extend(checked_packages(packages)?);
    Ok(argv)
}

/// `<interpreter> -m pip install --no-index --find-links=<file URL> <packages>`: the wheelhouse only, no request.
pub fn pip_offline_argv(
    interpreter: &Path,
    wheelhouse: &Path,
    packages: &[String],
) -> Result<Vec<String>, PackageError> {
    let mut argv = pip_base(interpreter);
    argv.push("--no-index".into());
    argv.push(format!("--find-links={}", file_url(wheelhouse)));
    argv.extend(checked_packages(packages)?);
    Ok(argv)
}

/// `<interpreter> -m pip install -r requirements.txt`, run in the project folder.
pub fn pip_requirements_argv(interpreter: &Path) -> Vec<String> {
    let mut argv = pip_base(interpreter);
    argv.push("-r".into());
    argv.push("requirements.txt".into());
    argv
}

/// Adds `--cache-dir=<folder>` right after `install`, so pip's download cache lives in the app's own folder instead
/// of the user's `%LOCALAPPDATA%\pip\cache`.
pub fn with_pip_cache(mut argv: Vec<String>, folder: &Path) -> Vec<String> {
    let at = argv
        .iter()
        .position(|arg| arg == "install")
        .map_or(argv.len(), |index| index + 1);
    argv.insert(at, format!("--cache-dir={}", folder.display()));
    argv
}

fn pip_base(interpreter: &Path) -> Vec<String> {
    vec![
        interpreter.display().to_string(),
        "-m".into(),
        "pip".into(),
        "install".into(),
    ]
}

/// `npm install [<package>]`, run in the project folder (the project's `node_modules`; never `-g`).
pub fn npm_install_argv(package: Option<&str>) -> Result<Vec<String>, PackageError> {
    let mut argv = vec!["npm".to_string(), "install".to_string()];
    if let Some(package) = package {
        if !valid_npm_package(package) {
            return Err(PackageError::InvalidNpm(package.to_string()));
        }
        argv.push(package.to_string());
    }
    Ok(argv)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_library_modules_are_never_pip_packages() {
        for module in [
            "tkinter", "_tkinter", "sqlite3", "ssl", "venv", "ctypes", "xml.dom", "turtle",
        ] {
            assert!(is_python_stdlib(module), "{module}");
        }
        for package in [
            "requests",
            "pandas",
            "numpy",
            "flask",
            "django",
            "matplotlib",
        ] {
            assert!(!is_python_stdlib(package), "{package}");
        }
        let python = Path::new(r"E:\app\runtimes\python\versions\3.14.7\python.exe");
        assert_eq!(
            pip_install_argv(python, &["tkinter".into()]),
            Err(PackageError::Stdlib("tkinter".into()))
        );
        assert!(matches!(
            pip_install_argv(python, &["sqlite3".into()]),
            Err(PackageError::Stdlib(_))
        ));
    }

    #[test]
    fn pip_commands_name_the_interpreter_and_never_use_user_or_global_options() {
        let python =
            Path::new(r"E:\My Apps\OpenMind Studio\runtimes\python\versions\3.14.7\python.exe");
        let argv =
            pip_install_argv(python, &["requests".into(), "pandas==3.0.6".into()]).expect("argv");
        assert_eq!(
            argv,
            vec![
                r"E:\My Apps\OpenMind Studio\runtimes\python\versions\3.14.7\python.exe",
                "-m",
                "pip",
                "install",
                "requests",
                "pandas==3.0.6"
            ]
        );
        assert!(!argv
            .iter()
            .any(|a| a == "--user" || a.starts_with("--prefix") || a.starts_with("--target")));
        let offline = pip_offline_argv(
            python,
            Path::new(r"E:\My Apps\cache\wheels"),
            &["django".into()],
        )
        .expect("argv");
        assert_eq!(offline[4], "--no-index");
        assert_eq!(offline[5], "--find-links=file:///E:/My%20Apps/cache/wheels");
        assert_eq!(
            pip_requirements_argv(python)[4..],
            ["-r", "requirements.txt"]
        );
        let cached = with_pip_cache(
            pip_requirements_argv(python),
            Path::new(r"E:\My Apps\OpenMind Studio\cache\pip"),
        );
        assert_eq!(
            cached[3..],
            [
                "install",
                r"--cache-dir=E:\My Apps\OpenMind Studio\cache\pip",
                "-r",
                "requirements.txt"
            ]
        );
        for bad in [
            "requests; calc",
            "--user",
            "https://evil/x.whl",
            "-r",
            "a b",
            "../x",
            "pkg`x`",
        ] {
            assert!(
                pip_install_argv(python, &[bad.to_string()]).is_err(),
                "{bad}"
            );
        }
        assert!(pip_install_argv(python, &[]).is_err());
    }

    #[test]
    fn npm_names_are_checked_and_never_global() {
        for good in [
            "lodash",
            "@types/node",
            "express@5",
            "left-pad@1.3.0",
            "@scope/pkg@^2.0.0",
            "chalk",
        ] {
            assert!(valid_npm_package(good), "{good}");
        }
        for bad in [
            "",
            "Lodash",
            "-g",
            "./local",
            "../x",
            "git+https://x",
            "https://x/y.tgz",
            "a b",
            "pkg;calc",
            "@scope",
            "pkg@",
            "_private",
            "a&b",
        ] {
            assert!(!valid_npm_package(bad), "{bad}");
        }
        assert_eq!(
            npm_install_argv(Some("lodash")).expect("argv"),
            vec!["npm", "install", "lodash"]
        );
        assert_eq!(
            npm_install_argv(None).expect("argv"),
            vec!["npm", "install"]
        );
        assert!(npm_install_argv(Some("-g")).is_err());
    }

    #[test]
    fn the_project_folder_is_the_nearest_with_a_marker_and_never_above_the_workspace() {
        let dir = tempfile::tempdir().expect("tmp");
        let root = dir.path().join("my work");
        let project = root.join("api");
        let src = project.join("src").join("pkg");
        std::fs::create_dir_all(&src).expect("dirs");
        std::fs::write(project.join("requirements.txt"), "requests\n").expect("req");
        assert_eq!(project_dir(&src, &root, PYTHON_MARKERS), project);
        // No marker anywhere: the starting folder.
        let other = root.join("scripts");
        std::fs::create_dir_all(&other).expect("dirs");
        assert_eq!(project_dir(&other, &root, PYTHON_MARKERS), other);
        // A marker above the workspace is not used.
        std::fs::write(dir.path().join("package.json"), "{}").expect("pkg");
        assert_eq!(project_dir(&other, &root, NODE_MARKERS), other);
        // A project venv is found.
        assert!(venv_python(&project).is_none());
        let scripts = if cfg!(windows) {
            project.join(".venv").join("Scripts")
        } else {
            project.join(".venv").join("bin")
        };
        std::fs::create_dir_all(&scripts).expect("venv");
        std::fs::write(
            scripts.join(if cfg!(windows) {
                "python.exe"
            } else {
                "python"
            }),
            b"",
        )
        .expect("py");
        assert!(venv_python(&project).is_some());
    }
}
