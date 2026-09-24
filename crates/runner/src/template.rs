use std::path::Path;

use crate::error::RunError;

/// Values a command template can refer to.
pub struct Variables<'a> {
    pub file: &'a Path,
    pub workspace: Option<&'a Path>,
}

/// Splits a command template into arguments the way a shell would *split*
/// (whitespace, `"..."` and `'...'` grouping) — and nothing more: no
/// variable substitution, globbing, pipes or redirection ever happens. The
/// result is passed to the process as an argument list, so there is no shell
/// to inject into.
pub fn tokenize(template: &str) -> Result<Vec<String>, RunError> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_token = false;
    let mut quote: Option<char> = None;
    for ch in template.chars() {
        match quote {
            Some(open) if ch == open => quote = None,
            Some(_) => current.push(ch),
            None if ch == '"' || ch == '\'' => {
                quote = Some(ch);
                in_token = true;
            }
            None if ch.is_whitespace() => {
                if in_token {
                    tokens.push(std::mem::take(&mut current));
                    in_token = false;
                }
            }
            None => {
                current.push(ch);
                in_token = true;
            }
        }
    }
    if quote.is_some() {
        return Err(RunError::BadCommand("a quote is never closed".into()));
    }
    if in_token {
        tokens.push(current);
    }
    if tokens.is_empty() {
        return Err(RunError::BadCommand("the command is empty".into()));
    }
    Ok(tokens)
}

/// Replaces `${file}`, `${fileDir}`, `${fileBasename}` and `${workspaceFolder}`
/// inside one already-split argument. Because it works per argument, a value
/// containing spaces stays a single argument. Unknown variables are an error,
/// not silently left in.
pub fn expand(token: &str, vars: &Variables<'_>) -> Result<String, RunError> {
    let mut out = String::new();
    let mut rest = token;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after
            .find('}')
            .ok_or_else(|| RunError::BadCommand("a \"${\" is never closed".into()))?;
        out.push_str(&value_of(&after[..end], vars)?);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

fn value_of(name: &str, vars: &Variables<'_>) -> Result<String, RunError> {
    let text = |path: &Path| path.to_string_lossy().into_owned();
    match name {
        "file" => Ok(text(vars.file)),
        "fileDir" => Ok(vars.file.parent().map(text).unwrap_or_default()),
        "fileBasename" => Ok(vars
            .file
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()),
        "workspaceFolder" => vars.workspace.map(text).ok_or_else(|| {
            RunError::BadCommand("\"${workspaceFolder}\" needs an open folder".into())
        }),
        other => Err(RunError::BadCommand(format!(
            "unknown variable \"${{{other}}}\""
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn vars<'a>(file: &'a Path, workspace: Option<&'a Path>) -> Variables<'a> {
        Variables { file, workspace }
    }

    #[test]
    fn tokenize_splits_on_whitespace_and_keeps_quoted_groups_together() {
        assert_eq!(
            tokenize(r#"python -u "C:\My Files\a b.py" 'x y'"#).expect("tokens"),
            ["python", "-u", r"C:\My Files\a b.py", "x y"]
        );
        assert_eq!(
            tokenize("  node   a.js ").expect("tokens"),
            ["node", "a.js"]
        );
        assert_eq!(tokenize(r#"a "" b"#).expect("tokens"), ["a", "", "b"]);
    }

    #[test]
    fn tokenize_rejects_empty_and_unterminated_commands() {
        assert!(matches!(tokenize("   "), Err(RunError::BadCommand(_))));
        assert!(matches!(
            tokenize("python \"a"),
            Err(RunError::BadCommand(_))
        ));
    }

    #[test]
    fn shell_metacharacters_are_just_text_in_an_argument_list() {
        let tokens = tokenize("python a.py && calc | more > out.txt").expect("tokens");

        assert_eq!(
            tokens,
            ["python", "a.py", "&&", "calc", "|", "more", ">", "out.txt"]
        );
    }

    #[test]
    fn expand_substitutes_variables_and_a_path_with_spaces_stays_one_argument() {
        let file = PathBuf::from(r"C:\My Projects\demo app\hello world.py");
        let workspace = PathBuf::from(r"C:\My Projects\demo app");
        let v = vars(&file, Some(&workspace));

        let tokens: Vec<String> = tokenize(r#"python "${file}" --root "${workspaceFolder}""#)
            .expect("tokens")
            .iter()
            .map(|t| expand(t, &v).expect("expand"))
            .collect();

        assert_eq!(
            tokens,
            [
                "python",
                r"C:\My Projects\demo app\hello world.py",
                "--root",
                r"C:\My Projects\demo app"
            ]
        );
    }

    #[test]
    fn expand_knows_dir_and_basename_and_embeds_inside_a_token() {
        let file = PathBuf::from("/p/src/main.py");
        let v = vars(&file, None);

        assert_eq!(
            expand("${fileDir}/out-${fileBasename}", &v).expect("expand"),
            "/p/src/out-main.py"
        );
    }

    #[test]
    fn expand_refuses_unknown_variables_and_a_workspace_that_is_not_open() {
        let file = PathBuf::from("/p/a.py");
        let v = vars(&file, None);

        assert!(matches!(
            expand("${nope}", &v),
            Err(RunError::BadCommand(_))
        ));
        assert!(matches!(
            expand("${workspaceFolder}", &v),
            Err(RunError::BadCommand(_))
        ));
        assert!(matches!(expand("${file", &v), Err(RunError::BadCommand(_))));
    }
}
