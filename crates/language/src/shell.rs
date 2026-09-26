//! A command as one line to type into a terminal: plain words stay plain (`pnpm run dev`), anything else is quoted
//! for the shell, and a line that couldn't be quoted safely is refused. The command itself is always an argument
//! list; this only renders it for the terminal the user is looking at.

use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShellStyle {
    PowerShell,
    Cmd,
    Bash,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ShellError {
    #[error("{0}")]
    Unsafe(String),
}

fn is_bare(arg: &str, style: ShellStyle) -> bool {
    let extra = if style == ShellStyle::Bash {
        "-_./:@=+,%"
    } else {
        "-_./\\:@=+,%"
    };
    !arg.is_empty()
        && arg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || extra.contains(c))
        && !(style == ShellStyle::PowerShell && arg.starts_with('-') && arg.contains(':'))
}

fn quote(arg: &str, style: ShellStyle) -> Result<String, ShellError> {
    if arg.contains(['\n', '\r', '\0']) {
        return Err(ShellError::Unsafe(
            "an argument contains a line break, which can't be typed safely".into(),
        ));
    }
    match style {
        ShellStyle::PowerShell => Ok(format!("'{}'", arg.replace('\'', "''"))),
        ShellStyle::Bash => Ok(format!("'{}'", arg.replace('\'', "'\\''"))),
        ShellStyle::Cmd => {
            if arg.contains(['"', '%', '^', '&', '|', '<', '>', '!']) {
                return Err(ShellError::Unsafe(format!(
                    "\"{arg}\" contains characters cmd.exe would interpret, so it can't be typed into it safely — use PowerShell"
                )));
            }
            Ok(format!("\"{arg}\""))
        }
    }
}

/// The line to type for `argv` in a `style` shell.
pub fn typed_line(argv: &[String], style: ShellStyle) -> Result<String, ShellError> {
    if argv.is_empty() {
        return Err(ShellError::Unsafe("there is nothing to run".into()));
    }
    let mut parts = Vec::with_capacity(argv.len());
    let mut first_quoted = false;
    for (index, arg) in argv.iter().enumerate() {
        if is_bare(arg, style) {
            parts.push(arg.clone());
        } else {
            first_quoted |= index == 0;
            parts.push(quote(arg, style)?);
        }
    }
    let line = parts.join(" ");
    // PowerShell needs the call operator to run a quoted program path.
    Ok(if style == ShellStyle::PowerShell && first_quoted {
        format!("& {line}")
    } else {
        line
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn plain_words_stay_plain() {
        assert_eq!(
            typed_line(&v(&["pnpm", "run", "dev"]), ShellStyle::PowerShell).expect("ok"),
            "pnpm run dev"
        );
        assert_eq!(
            typed_line(
                &v(&[".\\gradlew.bat", "assembleDebug"]),
                ShellStyle::PowerShell
            )
            .expect("ok"),
            ".\\gradlew.bat assembleDebug"
        );
        assert_eq!(
            typed_line(&v(&["./gradlew", "test"]), ShellStyle::Bash).expect("ok"),
            "./gradlew test"
        );
        assert_eq!(
            typed_line(&v(&["uvicorn", "main:app", "--reload"]), ShellStyle::Cmd).expect("ok"),
            "uvicorn main:app --reload"
        );
    }

    #[test]
    fn a_path_with_spaces_is_quoted_and_called() {
        let argv = v(&[
            "C:\\My Site\\node_modules\\.bin\\prettier.cmd",
            "--write",
            "C:\\My Site\\a b.ts",
        ]);
        assert_eq!(
            typed_line(&argv, ShellStyle::PowerShell).expect("ok"),
            "& 'C:\\My Site\\node_modules\\.bin\\prettier.cmd' --write 'C:\\My Site\\a b.ts'"
        );
        assert_eq!(
            typed_line(&argv, ShellStyle::Cmd).expect("ok"),
            "\"C:\\My Site\\node_modules\\.bin\\prettier.cmd\" --write \"C:\\My Site\\a b.ts\""
        );
        assert_eq!(
            typed_line(&v(&["echo", "it's"]), ShellStyle::PowerShell).expect("ok"),
            "echo 'it''s'"
        );
        assert_eq!(
            typed_line(&v(&["echo", "it's"]), ShellStyle::Bash).expect("ok"),
            "echo 'it'\\''s'"
        );
    }

    #[test]
    fn unsafe_lines_are_refused() {
        assert!(typed_line(&v(&["echo", "a\nb"]), ShellStyle::Bash).is_err());
        assert!(typed_line(&v(&["echo", "a&b"]), ShellStyle::Cmd).is_err());
        assert!(typed_line(&[], ShellStyle::Bash).is_err());
    }
}
