//! `${...}` variables of VS Code's `launch.json` and `tasks.json`, expanded from what the app knows: the open folder,
//! the file in front and the environment. Anything else (`${input:...}`, `${command:...}`, `${config:...}`, unknown
//! names) is refused with its name, so a configuration never runs with a half-expanded value.

use std::path::Path;

/// What the variables are expanded from.
#[derive(Debug, Clone, Default)]
pub struct VarContext {
    /// The open folder (absolute).
    pub workspace_folder: Option<String>,
    /// The file in front (absolute).
    pub file: Option<String>,
}

/// Why a value couldn't be expanded.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum VarError {
    #[error("The variable ${{{0}}} is not supported by OpenMind Studio yet.")]
    Unsupported(String),
    #[error("The variable ${{{0}}} needs an open folder.")]
    NeedsFolder(String),
    #[error("The variable ${{{0}}} needs a file open in the editor.")]
    NeedsFile(String),
    #[error("An unclosed ${{ in \"{0}\".")]
    Unclosed(String),
}

fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

fn parent(path: &str) -> &str {
    path.rfind(['/', '\\']).map_or("", |cut| &path[..cut])
}

fn relative<'a>(file: &'a str, folder: &str) -> &'a str {
    let folder = folder.trim_end_matches(['/', '\\']);
    let lower_file = file.to_ascii_lowercase().replace('\\', "/");
    let lower_folder = folder.to_ascii_lowercase().replace('\\', "/");
    if lower_file.starts_with(&format!("{lower_folder}/")) {
        &file[folder.len() + 1..]
    } else {
        file
    }
}

fn value_of(name: &str, context: &VarContext) -> Result<String, VarError> {
    let folder = || {
        context
            .workspace_folder
            .clone()
            .ok_or_else(|| VarError::NeedsFolder(name.to_string()))
    };
    let file = || {
        context
            .file
            .clone()
            .ok_or_else(|| VarError::NeedsFile(name.to_string()))
    };
    if let Some(key) = name.strip_prefix("env:") {
        return Ok(std::env::var(key).unwrap_or_default());
    }
    let value = match name {
        "workspaceFolder" | "workspaceRoot" => folder()?,
        "workspaceFolderBasename" => file_name(&folder()?).to_string(),
        "file" => file()?,
        "fileDirname" => parent(&file()?).to_string(),
        "fileBasename" => file_name(&file()?).to_string(),
        "fileBasenameNoExtension" => {
            let name = file_name(&file()?).to_string();
            name.rsplit_once('.')
                .map_or(name.clone(), |(stem, _)| stem.to_string())
        }
        "fileExtname" => {
            let name = file_name(&file()?).to_string();
            name.rsplit_once('.')
                .map_or(String::new(), |(_, ext)| format!(".{ext}"))
        }
        "relativeFile" => relative(&file()?, &folder()?).to_string(),
        "relativeFileDirname" => parent(relative(&file()?, &folder()?)).to_string(),
        "cwd" => folder()?,
        "pathSeparator" | "/" => std::path::MAIN_SEPARATOR.to_string(),
        other => return Err(VarError::Unsupported(other.to_string())),
    };
    Ok(value)
}

/// Expands every `${name}` in `text`.
pub fn expand(text: &str, context: &VarContext) -> Result<String, VarError> {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            return Err(VarError::Unclosed(text.to_string()));
        };
        out.push_str(&value_of(&after[..end], context)?);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// Whether `path` is the folder itself or inside it (by name, case-insensitive on Windows-style paths).
pub fn is_inside(path: &str, folder: &str) -> bool {
    let normalize = |p: &str| {
        let text = p.replace('\\', "/").to_ascii_lowercase();
        text.trim_end_matches('/').to_string()
    };
    let path = normalize(path);
    let folder = normalize(folder);
    !path.split('/').any(|part| part == "..")
        && (path == folder || path.starts_with(&format!("{folder}/")))
}

/// `path` made absolute against `base` when it is relative.
pub fn absolute(path: &str, base: &str) -> String {
    if Path::new(path).is_absolute() || path.starts_with(['/', '\\']) {
        path.to_string()
    } else {
        format!("{}/{}", base.trim_end_matches(['/', '\\']), path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context() -> VarContext {
        VarContext {
            workspace_folder: Some("C:/My Work".into()),
            file: Some("C:/My Work/src/app.test.py".into()),
        }
    }

    #[test]
    fn folder_and_file_variables_expand() {
        let c = context();
        assert_eq!(
            expand("${workspaceFolder}/out", &c).unwrap(),
            "C:/My Work/out"
        );
        assert_eq!(expand("${file}", &c).unwrap(), "C:/My Work/src/app.test.py");
        assert_eq!(expand("${fileDirname}", &c).unwrap(), "C:/My Work/src");
        assert_eq!(expand("${fileBasename}", &c).unwrap(), "app.test.py");
        assert_eq!(
            expand("${fileBasenameNoExtension}", &c).unwrap(),
            "app.test"
        );
        assert_eq!(expand("${fileExtname}", &c).unwrap(), ".py");
        assert_eq!(expand("${relativeFile}", &c).unwrap(), "src/app.test.py");
        assert_eq!(expand("${workspaceFolderBasename}", &c).unwrap(), "My Work");
        assert_eq!(expand("plain", &c).unwrap(), "plain");
    }

    #[test]
    fn unsupported_and_missing_values_are_refused_by_name() {
        let c = context();
        assert_eq!(
            expand("${input:pick}", &c).unwrap_err().to_string(),
            "The variable ${input:pick} is not supported by OpenMind Studio yet."
        );
        assert!(matches!(
            expand("${command:x}", &c),
            Err(VarError::Unsupported(_))
        ));
        assert!(matches!(expand("${oops", &c), Err(VarError::Unclosed(_))));
        let empty = VarContext::default();
        assert!(matches!(
            expand("${file}", &empty),
            Err(VarError::NeedsFile(_))
        ));
        assert!(matches!(
            expand("${workspaceFolder}", &empty),
            Err(VarError::NeedsFolder(_))
        ));
    }

    #[test]
    fn inside_checks_folders_by_name_and_refuses_climbing_out() {
        assert!(is_inside("C:/My Work/src", "C:/My Work"));
        assert!(is_inside(r"c:\my work\src\a.py", "C:/My Work/"));
        assert!(is_inside("C:/My Work", "C:/My Work"));
        assert!(!is_inside("C:/My Workshop", "C:/My Work"));
        assert!(!is_inside("C:/My Work/../etc", "C:/My Work"));
        assert_eq!(absolute("src", "C:/My Work/"), "C:/My Work/src");
        assert_eq!(absolute("C:/x", "C:/My Work"), "C:/x");
    }
}
