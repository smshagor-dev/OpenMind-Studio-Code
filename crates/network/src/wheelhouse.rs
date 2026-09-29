//! The offline Python wheelhouse: a folder of `.whl` files (from a USB drive, or `pip download` on another computer)
//! that pip installs from without any network request. This module only lists wheel files and builds the pip
//! command; importing goes through the offline cache, and the command is run only when the user asks, in a terminal.

use std::fs;
use std::path::{Path, PathBuf};

use crate::env::file_url;

/// Most wheel files read from one folder (a wheelhouse for a whole course is a few hundred).
pub const MAX_WHEELS: usize = 2_000;

/// The `.whl` files directly inside `folder` (not its sub-folders), sorted by name.
pub fn wheel_files(folder: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut files: Vec<PathBuf> = fs::read_dir(folder)?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_file()))
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("whl"))
        })
        .take(MAX_WHEELS)
        .collect();
    files.sort();
    Ok(files)
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RequirementError {
    #[error("Type at least one package name.")]
    Empty,
    #[error("\"{0}\" isn't a package name pip accepts (for example django, pandas==2.2.3 or requests[socks]).")]
    Invalid(String),
    #[error("At most 100 packages at a time.")]
    TooMany,
}

/// A requirement the offline install accepts: a PEP 508 name, optional `[extras]`, optional one version clause
/// (`==`, `>=`, `<=`, `~=`, `!=`, `<`, `>`). No URLs, paths, options or shell characters — the argument list is typed
/// into a terminal, so nothing else may get in.
pub fn valid_requirement(text: &str) -> bool {
    let name_len = text
        .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')))
        .unwrap_or(text.len());
    let (name, mut rest) = text.split_at(name_len);
    let name_ok = !name.is_empty()
        && name.len() <= 100
        && name.starts_with(|c: char| c.is_ascii_alphanumeric())
        && name.ends_with(|c: char| c.is_ascii_alphanumeric());
    if !name_ok {
        return false;
    }
    if let Some(extras) = rest.strip_prefix('[') {
        let Some((inside, after)) = extras.split_once(']') else {
            return false;
        };
        let extras_ok = !inside.is_empty()
            && inside.split(',').all(|e| {
                !e.is_empty()
                    && e.chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
            });
        if !extras_ok {
            return false;
        }
        rest = after;
    }
    if rest.is_empty() {
        return true;
    }
    let Some(version) = ["==", ">=", "<=", "~=", "!=", "<", ">"]
        .iter()
        .find_map(|op| rest.strip_prefix(op))
    else {
        return false;
    };
    !version.is_empty()
        && version.len() <= 50
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '*' | '+' | '!' | '-'))
}

/// Splits what the user typed ("django pandas", "django, pandas==2.2.3") into checked requirements.
pub fn parse_requirements(text: &str) -> Result<Vec<String>, RequirementError> {
    let items: Vec<String> = text
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect();
    if items.is_empty() {
        return Err(RequirementError::Empty);
    }
    if items.len() > 100 {
        return Err(RequirementError::TooMany);
    }
    if let Some(bad) = items.iter().find(|item| !valid_requirement(item)) {
        return Err(RequirementError::Invalid(bad.clone()));
    }
    Ok(items)
}

/// `python -m pip install --no-index --find-links=file:///... <packages>`: pip looks only in the wheelhouse and
/// makes no network request (`--no-index`). The folder is a file URL, so a path with spaces works.
pub fn offline_install_argv(wheelhouse: &Path, requirements: &[String]) -> Vec<String> {
    let mut argv = vec![
        "python".to_string(),
        "-m".to_string(),
        "pip".to_string(),
        "install".to_string(),
        "--no-index".to_string(),
        format!("--find-links={}", file_url(wheelhouse)),
    ];
    argv.extend(requirements.iter().cloned());
    argv
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_wheel_files_of_the_folder_itself_are_listed() {
        let dir = tempfile::tempdir().expect("tmp");
        let folder = dir.path().join("USB wheels");
        fs::create_dir_all(folder.join("nested")).expect("dirs");
        for name in [
            "pandas-2.2.3-cp314-cp314-win_amd64.whl",
            "Django-5.2-py3-none-any.whl",
            "readme.txt",
            "numpy-2.3.0.WHL",
        ] {
            fs::write(folder.join(name), b"x").expect("write");
        }
        fs::write(
            folder
                .join("nested")
                .join("six-1.17.0-py2.py3-none-any.whl"),
            b"x",
        )
        .expect("write");
        let names: Vec<String> = wheel_files(&folder)
            .expect("list")
            .iter()
            .map(|p| p.file_name().expect("name").to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            vec![
                "Django-5.2-py3-none-any.whl",
                "numpy-2.3.0.WHL",
                "pandas-2.2.3-cp314-cp314-win_amd64.whl"
            ]
        );
        assert!(wheel_files(&dir.path().join("missing")).is_err());
    }

    #[test]
    fn requirements_are_names_extras_and_one_version_clause_only() {
        for good in [
            "django",
            "pandas==2.2.3",
            "requests[socks]",
            "Flask-Login>=0.6",
            "zope.interface",
            "a~=1.4.*",
            "x!=2",
        ] {
            assert!(valid_requirement(good), "{good}");
        }
        for bad in [
            "",
            "-r",
            "--index-url=https://x",
            "django;rm",
            "a b",
            "https://evil/x.whl",
            "..\\x.whl",
            "pkg==",
            "pkg[",
            "pkg[]",
            "pkg==1;echo",
            "pkg&calc",
            "$(calc)",
            "pkg`x`",
        ] {
            assert!(!valid_requirement(bad), "{bad}");
        }
        assert_eq!(
            parse_requirements("django pandas, numpy==2.3.0").expect("ok"),
            vec!["django", "pandas", "numpy==2.3.0"]
        );
        assert_eq!(parse_requirements("  "), Err(RequirementError::Empty));
        assert_eq!(
            parse_requirements("django --pre"),
            Err(RequirementError::Invalid("--pre".into()))
        );
    }

    #[test]
    fn the_offline_command_uses_no_index_and_a_file_url_that_survives_spaces() {
        let argv = offline_install_argv(
            Path::new(r"E:\My USB\OpenMind Studio\cache\offline\wheels"),
            &["django".into(), "pandas".into()],
        );
        assert_eq!(
            argv,
            vec![
                "python",
                "-m",
                "pip",
                "install",
                "--no-index",
                "--find-links=file:///E:/My%20USB/OpenMind%20Studio/cache/offline/wheels",
                "django",
                "pandas"
            ]
        );
        assert!(argv.iter().all(|arg| !arg.contains(' ')), "{argv:?}");
    }
}
