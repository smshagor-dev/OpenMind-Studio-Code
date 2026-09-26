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
}

const RECIPES: &[Recipe] = &[
    Recipe {
        tool: "prettier",
        kind: Category::Format,
        args: &["--write", "{file}"],
    },
    Recipe {
        tool: "biome",
        kind: Category::Format,
        args: &["format", "--write", "{file}"],
    },
    Recipe {
        tool: "biome",
        kind: Category::Lint,
        args: &["lint", "{file}"],
    },
    Recipe {
        tool: "eslint",
        kind: Category::Lint,
        args: &["{file}"],
    },
    Recipe {
        tool: "stylelint",
        kind: Category::Lint,
        args: &["{file}"],
    },
    Recipe {
        tool: "black",
        kind: Category::Format,
        args: &["{file}"],
    },
    Recipe {
        tool: "ruff",
        kind: Category::Format,
        args: &["format", "{file}"],
    },
    Recipe {
        tool: "ruff",
        kind: Category::Lint,
        args: &["check", "{file}"],
    },
    Recipe {
        tool: "isort",
        kind: Category::Format,
        args: &["{file}"],
    },
    Recipe {
        tool: "php-cs-fixer",
        kind: Category::Format,
        args: &["fix", "{file}"],
    },
    Recipe {
        tool: "pint",
        kind: Category::Format,
        args: &["{file}"],
    },
    Recipe {
        tool: "rustfmt",
        kind: Category::Format,
        args: &["{file}"],
    },
    Recipe {
        tool: "cargo",
        kind: Category::Lint,
        args: &["clippy"],
    },
    Recipe {
        tool: "gofmt",
        kind: Category::Format,
        args: &["-w", "{file}"],
    },
    Recipe {
        tool: "go",
        kind: Category::Lint,
        args: &["vet", "./..."],
    },
    Recipe {
        tool: "golangci-lint",
        kind: Category::Lint,
        args: &["run"],
    },
    Recipe {
        tool: "clang-format",
        kind: Category::Format,
        args: &["-i", "{file}"],
    },
    Recipe {
        tool: "dotnet",
        kind: Category::Format,
        args: &["format", "--include", "{file}"],
    },
    Recipe {
        tool: "ktlint",
        kind: Category::Format,
        args: &["-F", "{file}"],
    },
    Recipe {
        tool: "ktlint",
        kind: Category::Lint,
        args: &["{file}"],
    },
    Recipe {
        tool: "dart",
        kind: Category::Format,
        args: &["format", "{file}"],
    },
    Recipe {
        tool: "dart",
        kind: Category::Lint,
        args: &["analyze", "{file}"],
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
            Some(FormatOption {
                tool: status.id,
                name: status.name,
                kind,
                found: status.found,
                hint: status.hint,
                argv,
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
