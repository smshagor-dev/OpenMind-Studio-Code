use crate::error::RunError;

/// The shells a run can be typed into.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShellStyle {
    PowerShell,
    Cmd,
    Bash,
}

/// A command line for showing in the Output panel: arguments with spaces are
/// double-quoted. For display only — a run is always started from the
/// argument list, never from this text.
pub fn command_line(argv: &[String]) -> String {
    argv.iter()
        .map(|arg| {
            if arg.is_empty() || arg.contains([' ', '\t']) {
                format!("\"{arg}\"")
            } else {
                arg.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The argument list as one line to *type into a terminal*, quoted for that
/// shell so no argument can be read as anything but data. Anything that can't
/// be quoted safely (a newline that would submit a second command, or, for
/// `cmd`, characters that its parser expands even inside quotes) is refused.
pub fn shell_command_line(argv: &[String], style: ShellStyle) -> Result<String, RunError> {
    let mut quoted = Vec::with_capacity(argv.len());
    for arg in argv {
        if arg.contains(['\n', '\r', '\0']) {
            return Err(RunError::BadCommand(
                "an argument contains a line break, which can't be typed safely".into(),
            ));
        }
        quoted.push(match style {
            ShellStyle::PowerShell => format!("'{}'", arg.replace('\'', "''")),
            ShellStyle::Bash => format!("'{}'", arg.replace('\'', r"'\''")),
            ShellStyle::Cmd => {
                if arg.contains(['"', '%', '^', '&', '|', '<', '>', '!']) {
                    return Err(RunError::BadCommand(format!(
                        "\"{arg}\" contains characters cmd.exe would interpret, so it can't be typed into it safely — use PowerShell or run it in the Output panel"
                    )));
                }
                format!("\"{arg}\"")
            }
        });
    }
    let line = quoted.join(" ");
    Ok(match style {
        // PowerShell needs the call operator to run a quoted program path.
        ShellStyle::PowerShell => format!("& {line}"),
        _ => line,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn display_quotes_only_arguments_with_spaces() {
        assert_eq!(
            command_line(&argv(&["python", r"C:\My Files\a.py", "-u", ""])),
            r#"python "C:\My Files\a.py" -u """#
        );
    }

    #[test]
    fn powershell_quoting_uses_single_quotes_and_doubles_embedded_ones() {
        let line = shell_command_line(
            &argv(&[r"C:\Program Files\py\python.exe", r"C:\it's here\a b.py"]),
            ShellStyle::PowerShell,
        )
        .expect("quoted");

        assert_eq!(
            line,
            r"& 'C:\Program Files\py\python.exe' 'C:\it''s here\a b.py'"
        );
    }

    #[test]
    fn a_hostile_file_name_stays_data_in_every_shell() {
        let evil = argv(&["python", "a.py; calc"]);

        assert_eq!(
            shell_command_line(&evil, ShellStyle::PowerShell).expect("ps"),
            "& 'python' 'a.py; calc'"
        );
        assert_eq!(
            shell_command_line(&evil, ShellStyle::Bash).expect("bash"),
            "'python' 'a.py; calc'"
        );
        assert_eq!(
            shell_command_line(&evil, ShellStyle::Cmd).expect("cmd"),
            "\"python\" \"a.py; calc\""
        );
    }

    #[test]
    fn bash_quoting_handles_single_quotes() {
        assert_eq!(
            shell_command_line(&argv(&["it's"]), ShellStyle::Bash).expect("bash"),
            r"'it'\''s'"
        );
    }

    #[test]
    fn line_breaks_are_refused_everywhere() {
        for style in [ShellStyle::PowerShell, ShellStyle::Cmd, ShellStyle::Bash] {
            assert!(
                shell_command_line(&argv(&["a\nb"]), style).is_err(),
                "{style:?}"
            );
            assert!(
                shell_command_line(&argv(&["a\rb"]), style).is_err(),
                "{style:?}"
            );
        }
    }

    #[test]
    fn cmd_refuses_characters_it_expands_inside_quotes() {
        for bad in ["100%", "a&b", "a|b", "a^b", "a\"b", "a<b", "a!b"] {
            assert!(
                shell_command_line(&argv(&[bad]), ShellStyle::Cmd).is_err(),
                "{bad}"
            );
        }
        assert!(shell_command_line(&argv(&["C:\\a b\\c.py"]), ShellStyle::Cmd).is_ok());
    }
}
