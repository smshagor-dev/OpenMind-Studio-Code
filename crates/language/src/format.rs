//! Formatter and linter discovery. For a language the registry lists candidate tools; this looks for each (the
//! project's own copy first, then portable runtimes, then PATH) and, for the ones found, builds the exact argument
//! list that would run — never run by this crate. Nothing is installed and nothing is formatted without the user
//! choosing the command.

use serde::Serialize;

use crate::commands::Category;
use crate::registry::LanguageDef;
use crate::tools::{status_of, Found, Source, ToolEnv};

struct Recipe {
    tool: &'static str,
    kind: Category,
    /// Arguments; `{file}` is replaced by the file. A recipe without `{file}` works on the whole project.
    args: &'static [&'static str],
    /// Arguments that make the tool read the *text* from stdin and print the formatted text to stdout (`{file}` = the
    /// file's name, for its config and language). `None`: the tool only works on files on disk.
    stdin: Option<&'static [&'static str]>,
}

const RECIPES: &[Recipe] = &[
    Recipe {
        tool: "prettier",
        kind: Category::Format,
        args: &["--write", "{file}"],
        stdin: Some(&["--stdin-filepath", "{file}"]),
    },
    Recipe {
        tool: "biome",
        kind: Category::Format,
        args: &["format", "--write", "{file}"],
        stdin: Some(&["format", "--stdin-file-path={file}"]),
    },
    Recipe {
        tool: "biome",
        kind: Category::Lint,
        args: &["lint", "{file}"],
        stdin: None,
    },
    Recipe {
        tool: "eslint",
        kind: Category::Lint,
        args: &["{file}"],
        stdin: None,
    },
    Recipe {
        tool: "stylelint",
        kind: Category::Lint,
        args: &["{file}"],
        stdin: None,
    },
    Recipe {
        tool: "black",
        kind: Category::Format,
        args: &["{file}"],
        stdin: Some(&["-q", "--stdin-filename", "{file}", "-"]),
    },
    Recipe {
        tool: "ruff",
        kind: Category::Format,
        args: &["format", "{file}"],
        stdin: Some(&["format", "--stdin-filename", "{file}", "-"]),
    },
    Recipe {
        tool: "ruff",
        kind: Category::Lint,
        args: &["check", "{file}"],
        stdin: None,
    },
    Recipe {
        tool: "isort",
        kind: Category::Format,
        args: &["{file}"],
        stdin: None,
    },
    Recipe {
        tool: "php-cs-fixer",
        kind: Category::Format,
        args: &["fix", "{file}"],
        stdin: None,
    },
    Recipe {
        tool: "pint",
        kind: Category::Format,
        args: &["{file}"],
        stdin: None,
    },
    Recipe {
        tool: "rustfmt",
        kind: Category::Format,
        args: &["{file}"],
        stdin: Some(&["--edition", "2021", "--emit", "stdout"]),
    },
    Recipe {
        tool: "cargo",
        kind: Category::Lint,
        args: &["clippy"],
        stdin: None,
    },
    Recipe {
        tool: "gofmt",
        kind: Category::Format,
        args: &["-w", "{file}"],
        stdin: Some(&[]),
    },
    Recipe {
        tool: "go",
        kind: Category::Lint,
        args: &["vet", "./..."],
        stdin: None,
    },
    Recipe {
        tool: "golangci-lint",
        kind: Category::Lint,
        args: &["run"],
        stdin: None,
    },
    Recipe {
        tool: "clang-format",
        kind: Category::Format,
        args: &["-i", "{file}"],
        stdin: Some(&["--assume-filename={file}"]),
    },
    Recipe {
        tool: "dotnet",
        kind: Category::Format,
        args: &["format", "--include", "{file}"],
        stdin: None,
    },
    Recipe {
        tool: "ktlint",
        kind: Category::Format,
        args: &["-F", "{file}"],
        stdin: None,
    },
    Recipe {
        tool: "ktlint",
        kind: Category::Lint,
        args: &["{file}"],
        stdin: None,
    },
    Recipe {
        tool: "dart",
        kind: Category::Format,
        args: &["format", "{file}"],
        stdin: None,
    },
    Recipe {
        tool: "dart",
        kind: Category::Lint,
        args: &["analyze", "{file}"],
        stdin: None,
    },
];

/// One formatter or linter for a file: what it is, whether it was found, and what would run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatOption {
    pub tool: String,
    pub name: String,
    pub kind: Category,
    pub found: Option<Found>,
    pub hint: String,
    /// The whole argument list with the program's resolved path first (only when found).
    pub argv: Vec<String>,
    /// The argument list (program first) that formats text passed on stdin; empty when the tool only works on files.
    pub stdin_argv: Vec<String>,
    /// The tool works on the project rather than on the one file.
    pub whole_project: bool,
}

fn rank(option: &FormatOption) -> u8 {
    match option.found.as_ref().map(|f| f.source) {
        Some(Source::Project) => 0,
        Some(Source::Bundled) => 1,
        Some(Source::Portable) => 2,
        Some(Source::System | Source::Env) => 3,
        None => 4,
    }
}

/// The options of `kind` for `language` and `file`, found ones first (the project's own tool before a system one).
pub fn options(
    language: &LanguageDef,
    kind: Category,
    file: &str,
    env: &ToolEnv,
) -> Vec<FormatOption> {
    let candidates = if kind == Category::Format {
        language.formatters
    } else {
        language.linters
    };
    let mut out: Vec<FormatOption> = candidates
        .iter()
        .filter_map(|tool_id| {
            let recipe = RECIPES
                .iter()
                .find(|r| r.tool == *tool_id && r.kind == kind)?;
            let status = status_of(tool_id, env);
            let argv = status
                .found
                .as_ref()
                .map(|found| {
                    let mut argv = vec![found.path.clone()];
                    argv.extend(recipe.args.iter().map(|a| a.replace("{file}", file)));
                    argv
                })
                .unwrap_or_default();
            let stdin_argv = match (&status.found, recipe.stdin) {
                (Some(found), Some(args)) => std::iter::once(found.path.clone())
                    .chain(args.iter().map(|a| a.replace("{file}", file)))
                    .collect(),
                _ => Vec::new(),
            };
            Some(FormatOption {
                tool: status.id,
                name: status.name,
                kind,
                found: status.found,
                hint: status.hint,
                argv,
                stdin_argv,
                whole_project: !recipe.args.iter().any(|a| a.contains("{file}")),
            })
        })
        .collect();
    out.sort_by_key(rank);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::by_id;
    use crate::tools::Os;
    use std::collections::HashMap;

    fn env(project: &std::path::Path, system: &std::path::Path) -> ToolEnv {
        ToolEnv {
            os: Os::Linux,
            project_dirs: vec![project.to_path_buf()],
            bundled_dirs: vec![],
            portable_dirs: vec![],
            system_dirs: vec![system.to_path_buf()],
            pathext: vec![],
            vars: HashMap::new(),
        }
    }

    #[test]
    fn the_projects_own_formatter_is_listed_before_a_system_one_and_builds_its_command() {
        let project = tempfile::tempdir().expect("tmp");
        let system = tempfile::tempdir().expect("tmp");
        std::fs::write(system.path().join("biome"), "").expect("file");
        std::fs::write(project.path().join("prettier"), "").expect("file");
        let e = env(project.path(), system.path());
        let ts = by_id("typescript").expect("ts");
        let list = options(ts, Category::Format, "/w/a b.ts", &e);
        assert_eq!(
            list.iter().map(|o| o.tool.as_str()).collect::<Vec<_>>(),
            ["prettier", "biome"]
        );
        assert_eq!(
            list[0].found.as_ref().map(|f| f.source),
            Some(Source::Project)
        );
        assert_eq!(list[0].argv[1..], ["--write", "/w/a b.ts"]);
        assert!(!list[0].whole_project);
    }

    #[test]
    fn tools_that_can_read_stdin_say_how_and_file_only_tools_do_not() {
        let project = tempfile::tempdir().expect("tmp");
        for tool in [
            "prettier", "biome", "black", "ruff", "rustfmt", "gofmt", "pint",
        ] {
            std::fs::write(project.path().join(tool), "").expect("file");
        }
        let e = env(project.path(), project.path());
        let stdin = |language: &str, tool: &str| {
            options(
                by_id(language).expect("language"),
                Category::Format,
                "/w/a b.x",
                &e,
            )
            .into_iter()
            .find(|o| o.tool == tool)
            .map(|o| o.stdin_argv[1..].to_vec())
            .unwrap_or_default()
        };
        assert_eq!(
            stdin("typescript", "prettier"),
            ["--stdin-filepath", "/w/a b.x"]
        );
        assert_eq!(
            stdin("typescript", "biome"),
            ["format", "--stdin-file-path=/w/a b.x"]
        );
        assert_eq!(
            stdin("python", "black"),
            ["-q", "--stdin-filename", "/w/a b.x", "-"]
        );
        assert_eq!(
            stdin("python", "ruff"),
            ["format", "--stdin-filename", "/w/a b.x", "-"]
        );
        assert_eq!(
            stdin("rust", "rustfmt"),
            ["--edition", "2021", "--emit", "stdout"]
        );
        assert!(
            options(by_id("go").expect("go"), Category::Format, "/w/a.go", &e)[0]
                .stdin_argv
                .len()
                == 1
        );
        // Pint and PHP CS Fixer only rewrite files on disk.
        let php = options(by_id("php").expect("php"), Category::Format, "/w/a.php", &e);
        assert!(php.iter().all(|o| o.stdin_argv.is_empty()));
    }

    #[test]
    fn a_missing_formatter_has_no_command_and_a_hint() {
        let project = tempfile::tempdir().expect("tmp");
        let e = env(project.path(), project.path());
        let py = by_id("python").expect("py");
        let list = options(py, Category::Format, "/w/a.py", &e);
        assert!(list.iter().all(|o| o.found.is_none() && o.argv.is_empty()));
        assert!(list
            .iter()
            .any(|o| o.tool == "black" && o.hint.contains("pip install black")));
    }

    #[test]
    fn linters_and_project_wide_tools() {
        let project = tempfile::tempdir().expect("tmp");
        std::fs::write(project.path().join("cargo"), "").expect("file");
        let e = env(project.path(), project.path());
        let rust = by_id("rust").expect("rust");
        let lint = options(rust, Category::Lint, "/w/main.rs", &e);
        assert_eq!(lint.len(), 1);
        assert!(lint[0].whole_project);
        assert_eq!(lint[0].argv[1..], ["clippy"]);
        assert!(options(
            by_id("plaintext").expect("txt"),
            Category::Format,
            "a.txt",
            &e
        )
        .is_empty());
    }

    #[test]
    fn every_registry_formatter_has_a_recipe() {
        for language in crate::registry::LANGUAGES {
            for tool in language.formatters {
                assert!(
                    RECIPES
                        .iter()
                        .any(|r| r.tool == *tool && r.kind == Category::Format),
                    "{} formatter {tool}",
                    language.id
                );
            }
            for tool in language.linters {
                assert!(
                    RECIPES
                        .iter()
                        .any(|r| r.tool == *tool && r.kind == Category::Lint),
                    "{} linter {tool}",
                    language.id
                );
            }
        }
    }
}
