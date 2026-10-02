//! How each downloadable tool of Runtime Manager > Language Tools is installed into `tools/<id>/<version>/`, as data.
//! Every download is pinned: npm tools by an embedded `package-lock.json` (each file checked against its integrity
//! hash), PHP programs and rustup-init by SHA-256, pip tools by exact version (pip checks the index's hashes, the
//! download gateway checks PyPI's), gopls by Go's checksum database. The app's installer does the work; this crate
//! never downloads or runs anything (see `tests/policy.rs`).

/// How a tool is fetched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecipeKind {
    /// `npm ci --ignore-scripts` on the embedded lockfile; a `<command>.cmd` launcher in the tool folder runs
    /// `node_modules/.bin/<bin>.cmd`, so only the tool's own command goes on a PATH, never its dependencies'.
    Npm {
        package_json: &'static str,
        package_lock: &'static str,
        bin: &'static str,
    },
    /// `pip install --target lib <requirement>` on OpenMind's Python; a `<command>.cmd` launcher runs
    /// `python -m <module>` with `lib` on `PYTHONPATH` (relocatable: no absolute path is written).
    Pip {
        requirement: &'static str,
        module: &'static str,
    },
    /// One PHP archive (`.phar`), checked by SHA-256; a `<command>.cmd` launcher runs it on `php` from the PATH.
    Phar {
        url: &'static str,
        sha256: &'static str,
        file: &'static str,
    },
    /// `go install <module>@<version>` with `GOBIN` in the tool's folder (needs a Go SDK).
    GoInstall { module: &'static str },
    /// rustup-init (checked by SHA-256) is copied in as `rustup.exe`, which installs the stable toolchain with
    /// `RUSTUP_HOME` and `CARGO_HOME` inside the tool's folder and the self-contained GNU host (no Visual Studio needed).
    /// rustup never installs itself, so nothing is written to the Registry or PATH.
    Rustup {
        url: &'static str,
        sha256: &'static str,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Recipe {
    pub tool: &'static str,
    pub version: &'static str,
    pub kind: RecipeKind,
    pub license: &'static str,
    /// What must be installed first, said in the UI when it is missing.
    pub needs: &'static str,
    /// Arguments that print the version (Verify); `None` = only check the program exists.
    pub verify_args: Option<&'static [&'static str]>,
}

macro_rules! npm {
    ($tool:literal, $version:literal, $bin:literal, $license:literal, $verify:expr) => {
        Recipe {
            tool: $tool,
            version: $version,
            kind: RecipeKind::Npm {
                package_json: include_str!(concat!("../recipes/", $tool, "/package.json")),
                package_lock: include_str!(concat!("../recipes/", $tool, "/package-lock.json")),
                bin: $bin,
            },
            license: $license,
            needs: "Node.js (install it in the Runtimes tab) to install and run it.",
            verify_args: $verify,
        }
    };
}

const fn pip(
    tool: &'static str,
    version: &'static str,
    requirement: &'static str,
    module: &'static str,
    license: &'static str,
) -> Recipe {
    Recipe {
        tool,
        version,
        kind: RecipeKind::Pip {
            requirement,
            module,
        },
        license,
        needs: "Python (install it in the Runtimes tab) to install and run it.",
        verify_args: Some(&["--version"]),
    }
}

const fn phar(
    tool: &'static str,
    version: &'static str,
    url: &'static str,
    sha256: &'static str,
    file: &'static str,
    license: &'static str,
) -> Recipe {
    Recipe {
        tool,
        version,
        kind: RecipeKind::Phar { url, sha256, file },
        license,
        needs: "PHP (install it in the Runtimes tab or the PHP Server window) to run it.",
        verify_args: Some(&["--version"]),
    }
}

const VERSION: Option<&[&str]> = Some(&["--version"]);

pub const RECIPES: &[Recipe] = &[
    npm!("eslint", "10.11.0", "eslint", "MIT", VERSION),
    npm!("prettier", "3.9.9", "prettier", "MIT", VERSION),
    npm!("biome", "2.5.15", "biome", "MIT OR Apache-2.0", VERSION),
    npm!("tailwindcss-language-server", "0.16.0", "tailwindcss-language-server", "MIT", None),
    npm!("vue-language-server", "3.3.12", "vue-language-server", "MIT", None),
    npm!("svelte-language-server", "0.18.4", "svelteserver", "MIT", None),
    npm!("astro-language-server", "2.17.1", "astro-ls", "MIT", None),
    npm!("graphql-language-service", "3.5.0", "graphql-lsp", "MIT", None),
    npm!("sql-language-server", "1.7.1", "sql-language-server", "MIT", None),
    pip("ruff", "0.16.10", "ruff==0.16.10", "ruff", "MIT"),
    pip("black", "26.5.1", "black==26.5.1", "black", "MIT"),
    pip("isort", "9.0.2", "isort==9.0.2", "isort", "MIT"),
    pip("pytest", "9.1.1", "pytest==9.1.1", "pytest", "MIT"),
    // Phpactor is not here: it needs PHP's posix extension, which PHP doesn't have on Windows.
    phar(
        "php-cs-fixer",
        "3.95.27",
        "https://github.com/PHP-CS-Fixer/PHP-CS-Fixer/releases/download/v3.95.27/php-cs-fixer.phar",
        "47231757eefdd08778e2bd047d98a63dfaad881006c8c1d1bc870d63be7f6a9b",
        "php-cs-fixer.phar",
        "MIT",
    ),
    phar(
        "pint",
        "1.32.1",
        "https://github.com/laravel/pint/releases/download/v1.32.1/pint.phar",
        "8af85d94c4b6ada1d90099ff1f2bc32e2c88538649473236719c519c69e34e5f",
        "pint.phar",
        "MIT",
    ),
    Recipe {
        tool: "gopls",
        version: "0.23.0",
        kind: RecipeKind::GoInstall { module: "golang.org/x/tools/gopls" },
        license: "BSD-3-Clause",
        needs: "the Go SDK (install it in the Runtimes tab) to build it.",
        verify_args: Some(&["version"]),
    },
    Recipe {
        tool: "rust-toolchain",
        version: "stable",
        kind: RecipeKind::Rustup {
            url: "https://static.rust-lang.org/rustup/archive/1.29.1/x86_64-pc-windows-msvc/rustup-init.exe",
            sha256: "6f4bef66261261fcb43131be8720bab817d403a09edec7455c371974b90bdb7e",
        },
        license: "MIT OR Apache-2.0",
        needs: "about 700 MB of disk space and a few minutes.",
        verify_args: Some(&["--version"]),
    },
];

pub fn recipe(tool: &str) -> Option<&'static Recipe> {
    RECIPES.iter().find(|recipe| recipe.tool == tool)
}

/// The tool's folder, relative to the app folder (forward slashes, as the manifest writes paths).
pub fn tool_dir(recipe: &Recipe) -> String {
    format!("tools/{}/{}", recipe.tool, recipe.version)
}

/// The program the manifest lists for `recipe` (`command` is the catalog's command name).
pub fn program_path(recipe: &Recipe, command: &str) -> String {
    let dir = tool_dir(recipe);
    match recipe.kind {
        RecipeKind::Npm { .. } | RecipeKind::Pip { .. } | RecipeKind::Phar { .. } => {
            format!("{dir}/{command}.cmd")
        }
        RecipeKind::GoInstall { .. } => format!("{dir}/{command}.exe"),
        RecipeKind::Rustup { .. } => format!("{dir}/cargo/bin/{command}.exe"),
    }
}

/// Environment a process needs to use the tool (only the Rust toolchain: where rustup and cargo keep their files).
pub fn program_env(recipe: &Recipe) -> Vec<(&'static str, String)> {
    let dir = tool_dir(recipe);
    match recipe.kind {
        RecipeKind::Rustup { .. } => vec![
            ("RUSTUP_HOME", format!("{dir}/rustup")),
            ("CARGO_HOME", format!("{dir}/cargo")),
        ],
        _ => Vec::new(),
    }
}

/// The `.cmd` launcher written into an npm, pip or PHP tool's folder. It refers only to its own folder (`%~dp0`), so the app
/// folder can be moved; `python` / `php` come from the PATH OpenMind gives its processes (its portable runtimes first).
pub fn launcher(recipe: &Recipe) -> Option<String> {
    match recipe.kind {
        RecipeKind::Pip { module, .. } => Some(format!(
            "@echo off\r\nsetlocal\r\nset \"PYTHONPATH=%~dp0lib;%PYTHONPATH%\"\r\npython -m {module} %*\r\n"
        )),
        RecipeKind::Phar { file, .. } => Some(format!("@echo off\r\nphp \"%~dp0{file}\" %*\r\n")),
        RecipeKind::Npm { bin, .. } => Some(format!("@\"%~dp0node_modules\\.bin\\{bin}.cmd\" %*\r\n")),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::known;

    #[test]
    fn every_recipe_belongs_to_a_known_tool_and_is_pinned() {
        for recipe in RECIPES {
            let known = known(recipe.tool)
                .unwrap_or_else(|| panic!("{} is not in the catalog", recipe.tool));
            match recipe.kind {
                RecipeKind::Npm {
                    package_lock, bin, ..
                } => {
                    assert!(
                        package_lock.contains("\"lockfileVersion\""),
                        "{}",
                        recipe.tool
                    );
                    assert!(package_lock.contains("\"integrity\""), "{}", recipe.tool);
                    assert_eq!(bin, known.command, "{}", recipe.tool);
                }
                RecipeKind::Pip { requirement, .. } => {
                    assert_eq!(requirement, format!("{}=={}", recipe.tool, recipe.version));
                }
                RecipeKind::Phar { url, sha256, .. } | RecipeKind::Rustup { url, sha256 } => {
                    assert!(url.starts_with("https://"), "{url}");
                    assert_eq!(sha256.len(), 64);
                    assert!(sha256
                        .chars()
                        .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
                }
                RecipeKind::GoInstall { module } => assert!(module.starts_with("golang.org/")),
            }
        }
    }

    #[test]
    fn programs_live_in_the_tool_folder_and_launchers_are_relocatable() {
        let ruff = recipe("ruff").expect("ruff");
        assert_eq!(program_path(ruff, "ruff"), "tools/ruff/0.16.10/ruff.cmd");
        let text = launcher(ruff).expect("launcher");
        assert!(
            text.contains("%~dp0lib") && text.contains("python -m ruff"),
            "{text}"
        );
        assert!(!text.contains(":\\"), "no absolute path in {text}");
        let pint = recipe("pint").expect("pint");
        assert!(launcher(pint)
            .expect("pint")
            .contains("php \"%~dp0pint.phar\""));
        let eslint = recipe("eslint").expect("eslint");
        assert_eq!(
            program_path(eslint, "eslint"),
            "tools/eslint/10.11.0/eslint.cmd"
        );
        // Only the tool's own command is exposed: its launcher calls the package's bin by path, so the bins of its
        // dependencies (a Svelte server's own Prettier) never shadow another tool.
        assert_eq!(
            launcher(eslint).expect("npm"),
            "@\"%~dp0node_modules\\.bin\\eslint.cmd\" %*\r\n"
        );
        assert!(
            recipe("phpactor").is_none(),
            "Phpactor can't run on Windows"
        );
        assert_eq!(
            program_path(recipe("gopls").expect("gopls"), "gopls"),
            "tools/gopls/0.23.0/gopls.exe"
        );
        let rust = recipe("rust-toolchain").expect("rust");
        assert_eq!(
            program_path(rust, "cargo"),
            "tools/rust-toolchain/stable/cargo/bin/cargo.exe"
        );
        assert_eq!(
            program_env(rust),
            vec![
                (
                    "RUSTUP_HOME",
                    "tools/rust-toolchain/stable/rustup".to_string()
                ),
                (
                    "CARGO_HOME",
                    "tools/rust-toolchain/stable/cargo".to_string()
                )
            ]
        );
    }
}
