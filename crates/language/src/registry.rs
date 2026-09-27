//! The languages OpenMind knows, as data: how a file is recognised, how it is commented, which formatters, linters
//! and language servers exist for it, and — honestly — what OpenMind can do with it today (`levels`).
//!
//! `levels` is not a wish list: `syntax` means the editor highlights it (`syntax` says whether that is the language's
//! own grammar or the closest one Monaco has), `lsp` means OpenMind can start a language server for it, `run` means
//! Run Code works on a single file, `debug` means the debugger supports it, `format`/`lint` mean a tool that OpenMind
//! can send to the terminal is known, and `build`/`test` mean project commands exist for its usual toolchain. Nothing
//! here claims support for a language nobody can use.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    Syntax,
    Lsp,
    Format,
    Lint,
    Run,
    Build,
    Debug,
    Test,
}

/// Whether the editor colours the language with its own grammar or the nearest one it has.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Syntax {
    Exact,
    Approximate,
    /// No highlighting: the text is shown plain.
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Group {
    Web,
    Backend,
    Systems,
    Scripting,
    Mobile,
    Config,
    Database,
    Docs,
    Data,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageDef {
    pub id: &'static str,
    pub name: &'static str,
    pub group: Group,
    /// With the dot, lower case (`.ts`).
    pub extensions: &'static [&'static str],
    /// Whole file names, lower case (`dockerfile`); a trailing `*` is a prefix (`dockerfile.*`).
    pub filenames: &'static [&'static str],
    /// The line-comment marker (`//`), or the block markers for languages with only those (`<!-- -->`).
    pub comment: &'static str,
    /// The editor (Monaco) language used for highlighting.
    pub monaco: &'static str,
    pub syntax: Syntax,
    /// Tool ids (see `tools`) that format this language.
    pub formatters: &'static [&'static str],
    pub linters: &'static [&'static str],
    /// Language server ids (see `lsp`).
    pub lsp: &'static [&'static str],
    /// Tool ids of the compiler, interpreter or SDK.
    pub toolchains: &'static [&'static str],
    pub levels: &'static [Level],
}

use Group::{Backend, Config, Data, Database, Docs, Mobile, Scripting, Systems, Web};
use Level::{Build, Debug as Dbg, Format, Lint, Lsp, Run, Syntax as Hl, Test};
use Syntax::{Approximate as Approx, Exact};

macro_rules! lang {
    ($id:literal, $name:literal, $group:expr, [$($ext:literal),*], [$($file:literal),*], $comment:literal,
     $monaco:literal, $syntax:expr, [$($fmt:literal),*], [$($lint:literal),*], [$($lsp:literal),*],
     [$($tool:literal),*], [$($level:expr),*]) => {
        LanguageDef {
            id: $id, name: $name, group: $group,
            extensions: &[$($ext),*], filenames: &[$($file),*], comment: $comment,
            monaco: $monaco, syntax: $syntax,
            formatters: &[$($fmt),*], linters: &[$($lint),*], lsp: &[$($lsp),*],
            toolchains: &[$($tool),*], levels: &[$($level),*],
        }
    };
}

pub const LANGUAGES: &[LanguageDef] = &[
    // Web / frontend
    lang!(
        "html",
        "HTML",
        Web,
        [".html", ".htm", ".xhtml"],
        [],
        "<!-- -->",
        "html",
        Exact,
        ["prettier", "biome"],
        [],
        ["vscode-html-language-server"],
        [],
        [Hl, Lsp, Format]
    ),
    lang!(
        "css",
        "CSS",
        Web,
        [".css"],
        [],
        "/* */",
        "css",
        Exact,
        ["prettier", "biome"],
        ["stylelint"],
        ["vscode-css-language-server", "tailwindcss-language-server"],
        [],
        [Hl, Lsp, Format, Lint]
    ),
    lang!(
        "scss",
        "SCSS",
        Web,
        [".scss"],
        [],
        "//",
        "scss",
        Exact,
        ["prettier"],
        ["stylelint"],
        ["vscode-css-language-server"],
        [],
        [Hl, Lsp, Format, Lint]
    ),
    lang!(
        "sass",
        "Sass",
        Web,
        [".sass"],
        [],
        "//",
        "scss",
        Approx,
        ["prettier"],
        ["stylelint"],
        [],
        [],
        [Hl]
    ),
    lang!(
        "less",
        "Less",
        Web,
        [".less"],
        [],
        "//",
        "less",
        Exact,
        ["prettier"],
        ["stylelint"],
        ["vscode-css-language-server"],
        [],
        [Hl, Lsp, Format, Lint]
    ),
    lang!(
        "javascript",
        "JavaScript",
        Web,
        [".js", ".mjs", ".cjs"],
        [],
        "//",
        "javascript",
        Exact,
        ["prettier", "biome"],
        ["eslint", "biome"],
        ["typescript-language-server"],
        ["node"],
        [Hl, Lsp, Format, Lint, Run, Dbg, Test, Build]
    ),
    lang!(
        "javascriptreact",
        "JavaScript React (JSX)",
        Web,
        [".jsx"],
        [],
        "//",
        "javascript",
        Exact,
        ["prettier", "biome"],
        ["eslint", "biome"],
        ["typescript-language-server"],
        ["node"],
        [Hl, Lsp, Format, Lint, Test, Build]
    ),
    lang!(
        "typescript",
        "TypeScript",
        Web,
        [".ts", ".mts", ".cts"],
        [],
        "//",
        "typescript",
        Exact,
        ["prettier", "biome"],
        ["eslint", "biome"],
        ["typescript-language-server"],
        ["node"],
        [Hl, Lsp, Format, Lint, Run, Test, Build]
    ),
    lang!(
        "typescriptreact",
        "TypeScript React (TSX)",
        Web,
        [".tsx"],
        [],
        "//",
        "typescript",
        Exact,
        ["prettier", "biome"],
        ["eslint", "biome"],
        ["typescript-language-server"],
        ["node"],
        [Hl, Lsp, Format, Lint, Test, Build]
    ),
    lang!(
        "json",
        "JSON",
        Web,
        [".json", ".jsonc", ".webmanifest"],
        [".babelrc", ".eslintrc", "tsconfig.json"],
        "",
        "json",
        Exact,
        ["prettier", "biome"],
        [],
        ["vscode-json-language-server"],
        [],
        [Hl, Lsp, Format]
    ),
    lang!(
        "yaml",
        "YAML",
        Config,
        [".yaml", ".yml"],
        [],
        "#",
        "yaml",
        Exact,
        ["prettier"],
        [],
        ["yaml-language-server"],
        [],
        [Hl, Lsp, Format]
    ),
    lang!(
        "toml",
        "TOML",
        Config,
        [".toml"],
        ["cargo.lock", "pipfile"],
        "#",
        "ini",
        Approx,
        [],
        [],
        [],
        [],
        [Hl]
    ),
    lang!(
        "markdown",
        "Markdown",
        Docs,
        [".md", ".markdown", ".mdx"],
        [],
        "<!-- -->",
        "markdown",
        Exact,
        ["prettier"],
        [],
        [],
        [],
        [Hl, Format]
    ),
    lang!(
        "xml",
        "XML",
        Config,
        [
            ".xml", ".xsd", ".xsl", ".svg", ".plist", ".csproj", ".vbproj", ".fsproj", ".props",
            ".targets", ".resx", ".xaml", ".axml"
        ],
        ["pom.xml", "androidmanifest.xml"],
        "<!-- -->",
        "xml",
        Exact,
        [],
        [],
        [],
        [],
        [Hl]
    ),
    lang!(
        "vue",
        "Vue",
        Web,
        [".vue"],
        [],
        "<!-- -->",
        "html",
        Approx,
        ["prettier"],
        ["eslint"],
        ["vue-language-server"],
        ["node"],
        [Hl, Format, Lint]
    ),
    lang!(
        "svelte",
        "Svelte",
        Web,
        [".svelte"],
        [],
        "<!-- -->",
        "html",
        Approx,
        ["prettier"],
        ["eslint"],
        ["svelteserver"],
        ["node"],
        [Hl, Format, Lint]
    ),
    lang!(
        "astro",
        "Astro",
        Web,
        [".astro"],
        [],
        "<!-- -->",
        "html",
        Approx,
        ["prettier"],
        ["eslint"],
        ["astro-ls"],
        ["node"],
        [Hl, Format, Lint]
    ),
    // Backend
    lang!(
        "python",
        "Python",
        Backend,
        [".py", ".pyi", ".pyw"],
        [],
        "#",
        "python",
        Exact,
        ["black", "ruff", "isort"],
        ["ruff"],
        ["pyright", "pylsp"],
        ["python"],
        [Hl, Lsp, Format, Lint, Run, Dbg, Test]
    ),
    lang!(
        "php",
        "PHP",
        Backend,
        [".php", ".phtml", ".inc"],
        ["artisan"],
        "//",
        "php",
        Exact,
        ["pint", "php-cs-fixer"],
        [],
        ["intelephense", "phpactor"],
        ["php", "composer"],
        [Hl, Lsp, Format, Run, Test]
    ),
    lang!(
        "go",
        "Go",
        Systems,
        [".go"],
        [],
        "//",
        "go",
        Exact,
        ["gofmt"],
        ["golangci-lint", "go"],
        ["gopls"],
        ["go"],
        [Hl, Format, Lint, Build, Test]
    ),
    lang!(
        "rust",
        "Rust",
        Systems,
        [".rs"],
        [],
        "//",
        "rust",
        Exact,
        ["rustfmt"],
        ["cargo"],
        ["rust-analyzer"],
        ["cargo"],
        [Hl, Lsp, Format, Lint, Build, Test]
    ),
    lang!(
        "java",
        "Java",
        Backend,
        [".java"],
        [],
        "//",
        "java",
        Exact,
        [],
        [],
        ["jdtls"],
        ["java", "javac", "mvn", "gradle"],
        [Hl, Build, Test]
    ),
    lang!(
        "kotlin",
        "Kotlin",
        Mobile,
        [".kt", ".kts"],
        [],
        "//",
        "kotlin",
        Exact,
        ["ktlint"],
        ["ktlint"],
        [],
        ["java", "gradle"],
        [Hl, Format, Lint, Build, Test]
    ),
    lang!(
        "csharp",
        "C#",
        Backend,
        [".cs"],
        [],
        "//",
        "csharp",
        Exact,
        ["dotnet"],
        [],
        ["omnisharp"],
        ["dotnet"],
        [Hl, Format, Build, Test]
    ),
    lang!(
        "ruby",
        "Ruby",
        Backend,
        [".rb", ".rake", ".gemspec", ".ru"],
        ["gemfile", "rakefile"],
        "#",
        "ruby",
        Exact,
        [],
        [],
        [],
        ["ruby", "bundle"],
        [Hl, Test]
    ),
    lang!(
        "swift",
        "Swift",
        Mobile,
        [".swift"],
        ["package.swift"],
        "//",
        "swift",
        Exact,
        [],
        [],
        [],
        ["xcodebuild"],
        [Hl]
    ),
    lang!(
        "dart",
        "Dart",
        Mobile,
        [".dart"],
        ["pubspec.yaml"],
        "//",
        "plaintext",
        Syntax::None,
        ["dart"],
        ["dart"],
        [],
        ["dart", "flutter"],
        [Format, Lint, Build, Test]
    ),
    lang!(
        "objective-c",
        "Objective-C",
        Mobile,
        [".m", ".mm"],
        [],
        "//",
        "objective-c",
        Exact,
        ["clang-format"],
        [],
        [],
        [],
        [Hl]
    ),
    // Systems
    lang!(
        "c",
        "C",
        Systems,
        [".c", ".h"],
        [],
        "//",
        "c",
        Exact,
        ["clang-format"],
        [],
        ["clangd"],
        ["gcc", "clang", "cmake", "make"],
        [Hl, Lsp, Format, Build]
    ),
    lang!(
        "cpp",
        "C++",
        Systems,
        [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx", ".ino"],
        [],
        "//",
        "cpp",
        Exact,
        ["clang-format"],
        [],
        ["clangd"],
        ["gcc", "clang", "cmake", "make"],
        [Hl, Lsp, Format, Build]
    ),
    // Shell / scripting
    lang!(
        "shellscript",
        "Shell Script",
        Scripting,
        [".sh", ".bash", ".zsh"],
        [".bashrc", ".zshrc", ".profile"],
        "#",
        "shell",
        Exact,
        [],
        [],
        ["bash-language-server"],
        ["bash"],
        [Hl, Lsp]
    ),
    lang!(
        "powershell",
        "PowerShell",
        Scripting,
        [".ps1", ".psm1", ".psd1"],
        [],
        "#",
        "powershell",
        Exact,
        [],
        [],
        [],
        ["powershell"],
        [Hl]
    ),
    lang!(
        "bat",
        "Batch / CMD",
        Scripting,
        [".bat", ".cmd"],
        [],
        "REM",
        "bat",
        Exact,
        [],
        [],
        [],
        [],
        [Hl]
    ),
    lang!(
        "lua",
        "Lua",
        Scripting,
        [".lua"],
        [],
        "--",
        "lua",
        Exact,
        [],
        [],
        [],
        [],
        [Hl]
    ),
    lang!(
        "perl",
        "Perl",
        Scripting,
        [".pl", ".pm"],
        [],
        "#",
        "perl",
        Exact,
        [],
        [],
        [],
        [],
        [Hl]
    ),
    lang!(
        "r",
        "R",
        Data,
        [".r", ".rmd"],
        ["description"],
        "#",
        "r",
        Exact,
        [],
        [],
        [],
        [],
        [Hl]
    ),
    lang!(
        "jupyter",
        "Jupyter Notebook",
        Data,
        [".ipynb"],
        [],
        "",
        "json",
        Approx,
        [],
        [],
        [],
        [],
        [Hl]
    ),
    // DevOps / config / database
    lang!(
        "dockerfile",
        "Dockerfile",
        Config,
        [".dockerfile"],
        ["dockerfile", "dockerfile.*", "containerfile"],
        "#",
        "dockerfile",
        Exact,
        [],
        [],
        ["docker-langserver"],
        ["docker"],
        [Hl, Lsp, Build]
    ),
    lang!(
        "dockercompose",
        "Docker Compose",
        Config,
        [],
        [
            "docker-compose.yml",
            "docker-compose.yaml",
            "compose.yml",
            "compose.yaml",
            "docker-compose.*.yml",
            "docker-compose.*.yaml"
        ],
        "#",
        "yaml",
        Exact,
        ["prettier"],
        [],
        ["yaml-language-server"],
        ["docker"],
        [Hl, Lsp, Build]
    ),
    lang!(
        "sql",
        "SQL",
        Database,
        [".sql", ".ddl"],
        [],
        "--",
        "sql",
        Exact,
        [],
        [],
        ["sql-language-server"],
        [],
        [Hl]
    ),
    lang!(
        "prisma",
        "Prisma Schema",
        Database,
        [".prisma"],
        [],
        "//",
        "plaintext",
        Syntax::None,
        [],
        [],
        [],
        ["node"],
        []
    ),
    lang!(
        "graphql",
        "GraphQL",
        Database,
        [".graphql", ".gql"],
        [],
        "#",
        "graphql",
        Exact,
        ["prettier"],
        [],
        ["graphql-lsp"],
        [],
        [Hl, Format]
    ),
    lang!(
        "dotenv",
        "Environment file (.env)",
        Config,
        [".env"],
        [".env", ".env.*"],
        "#",
        "ini",
        Approx,
        [],
        [],
        [],
        [],
        [Hl]
    ),
    lang!(
        "ini",
        "INI",
        Config,
        [".ini", ".cfg", ".conf"],
        [],
        ";",
        "ini",
        Exact,
        [],
        [],
        [],
        [],
        [Hl]
    ),
    lang!(
        "properties",
        "Java Properties",
        Config,
        [".properties"],
        [],
        "#",
        "ini",
        Approx,
        [],
        [],
        [],
        [],
        [Hl]
    ),
    lang!(
        "gradle",
        "Gradle",
        Config,
        [".gradle"],
        [],
        "//",
        "java",
        Approx,
        [],
        [],
        [],
        ["gradle", "java"],
        [Hl, Build, Test]
    ),
    lang!(
        "makefile",
        "Makefile",
        Config,
        [".mk"],
        ["makefile", "gnumakefile"],
        "#",
        "plaintext",
        Syntax::None,
        [],
        [],
        [],
        ["make"],
        [Build]
    ),
    lang!(
        "cmake",
        "CMake",
        Config,
        [".cmake"],
        ["cmakelists.txt"],
        "#",
        "plaintext",
        Syntax::None,
        [],
        [],
        [],
        ["cmake"],
        [Build]
    ),
    lang!(
        "plaintext",
        "Plain Text",
        Docs,
        [".txt", ".log"],
        [],
        "",
        "plaintext",
        Exact,
        [],
        [],
        [],
        [],
        [Hl]
    ),
    lang!(
        "latex",
        "LaTeX",
        Docs,
        [".tex", ".sty", ".cls", ".bib"],
        [],
        "%",
        "plaintext",
        Syntax::None,
        [],
        [],
        [],
        [],
        []
    ),
    lang!(
        "csv",
        "CSV",
        Data,
        [".csv", ".tsv"],
        [],
        "",
        "plaintext",
        Syntax::None,
        [],
        [],
        [],
        [],
        []
    ),
];

/// Looks a language up by its id.
pub fn by_id(id: &str) -> Option<&'static LanguageDef> {
    LANGUAGES.iter().find(|language| language.id == id)
}

fn file_name(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_ascii_lowercase()
}

fn filename_matches(pattern: &str, name: &str) -> bool {
    match pattern.strip_suffix('*') {
        Some(prefix) => name.starts_with(prefix),
        None => match pattern.split_once('*') {
            Some((head, tail)) => {
                name.len() >= head.len() + tail.len()
                    && name.starts_with(head)
                    && name.ends_with(tail)
            }
            None => name == pattern,
        },
    }
}

/// The language of a file by its name (whole-name matches first, then the extension). Content is never read.
pub fn language_for(path: &str) -> Option<&'static LanguageDef> {
    let name = file_name(path);
    if let Some(found) = LANGUAGES.iter().find(|language| {
        language
            .filenames
            .iter()
            .any(|pattern| filename_matches(pattern, &name))
    }) {
        return Some(found);
    }
    let ext = name.rfind('.').map(|dot| &name[dot..])?;
    LANGUAGES
        .iter()
        .find(|language| language.extensions.contains(&ext))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(path: &str) -> Option<&'static str> {
        language_for(path).map(|language| language.id)
    }

    #[test]
    fn ids_and_extensions_are_unique() {
        for (i, a) in LANGUAGES.iter().enumerate() {
            for b in &LANGUAGES[i + 1..] {
                assert_ne!(a.id, b.id, "duplicate id");
                for ext in a.extensions {
                    assert!(
                        !b.extensions.contains(ext),
                        "{ext} is claimed by {} and {}",
                        a.id,
                        b.id
                    );
                }
            }
        }
    }

    #[test]
    fn common_files_map_to_their_language() {
        for (path, expected) in [
            ("C:/My Site/app.TS", "typescript"),
            ("src\\view.tsx", "typescriptreact"),
            ("a/b.mjs", "javascript"),
            ("x.jsx", "javascriptreact"),
            ("tool.py", "python"),
            ("index.php", "php"),
            ("main.go", "go"),
            ("lib.rs", "rust"),
            ("App.java", "java"),
            ("Program.cs", "csharp"),
            ("main.dart", "dart"),
            ("Main.kt", "kotlin"),
            ("build.gradle.kts", "kotlin"),
            ("build.gradle", "gradle"),
            ("ViewController.swift", "swift"),
            ("main.c", "c"),
            ("main.cpp", "cpp"),
            ("run.sh", "shellscript"),
            ("build.ps1", "powershell"),
            ("go.bat", "bat"),
            ("schema.sql", "sql"),
            ("schema.prisma", "prisma"),
            ("query.graphql", "graphql"),
            ("App.vue", "vue"),
            ("App.svelte", "svelte"),
            ("index.astro", "astro"),
            ("style.scss", "scss"),
            ("notes.md", "markdown"),
            ("data.json", "json"),
            ("ci.yml", "yaml"),
            ("Cargo.toml", "toml"),
            ("nb.ipynb", "jupyter"),
            ("Foo.csproj", "xml"),
            ("pom.xml", "xml"),
            ("AndroidManifest.xml", "xml"),
            ("settings.ini", "ini"),
            ("app.properties", "properties"),
            ("Gemfile", "ruby"),
            ("model.R", "r"),
        ] {
            assert_eq!(id(path), Some(expected), "{path}");
        }
    }

    #[test]
    fn whole_names_beat_extensions() {
        assert_eq!(id("Dockerfile"), Some("dockerfile"));
        assert_eq!(id("api/Dockerfile.prod"), Some("dockerfile"));
        assert_eq!(id("docker-compose.yml"), Some("dockercompose"));
        assert_eq!(id("docker-compose.override.yaml"), Some("dockercompose"));
        assert_eq!(id("compose.yaml"), Some("dockercompose"));
        assert_eq!(id(".env"), Some("dotenv"));
        assert_eq!(id(".env.local"), Some("dotenv"));
        assert_eq!(id("Makefile"), Some("makefile"));
        assert_eq!(id("CMakeLists.txt"), Some("cmake"));
        assert_eq!(id("artisan"), Some("php"));
        assert_eq!(id("tsconfig.json"), Some("json"));
        assert_eq!(id("notes.yml"), Some("yaml"));
    }

    #[test]
    fn unknown_files_have_no_language() {
        assert_eq!(id("README"), None);
        assert_eq!(id("dir.d/file"), None);
        assert_eq!(id("archive.zip"), None);
    }

    #[test]
    fn levels_are_honest() {
        // Only the languages OpenMind can actually start a server for claim `lsp` through a built-in server.
        let lsp: Vec<&str> = LANGUAGES
            .iter()
            .filter(|l| l.levels.contains(&Level::Lsp))
            .map(|l| l.id)
            .collect();
        for expected in [
            "typescript",
            "python",
            "php",
            "json",
            "css",
            "html",
            "yaml",
            "dockerfile",
            "shellscript",
            "rust",
            "c",
            "cpp",
        ] {
            assert!(lsp.contains(&expected), "{expected}");
        }
        for not_yet in ["go", "java", "csharp", "vue", "kotlin", "dart", "sql"] {
            assert!(!lsp.contains(&not_yet), "{not_yet} has no built-in server");
        }
        // The debugger supports Python and JavaScript only.
        let debug: Vec<&str> = LANGUAGES
            .iter()
            .filter(|l| l.levels.contains(&Level::Debug))
            .map(|l| l.id)
            .collect();
        assert_eq!(debug, ["javascript", "python"]);
        // Run Code (a single file) exists for what the runner runs.
        let run: Vec<&str> = LANGUAGES
            .iter()
            .filter(|l| l.levels.contains(&Level::Run))
            .map(|l| l.id)
            .collect();
        assert_eq!(run, ["javascript", "typescript", "python", "php"]);
        // A language with no highlighting says so.
        assert_eq!(by_id("dart").map(|l| l.syntax), Some(Syntax::None));
        assert_eq!(by_id("vue").map(|l| l.syntax), Some(Syntax::Approximate));
    }

    #[test]
    fn every_language_names_a_monaco_grammar() {
        for language in LANGUAGES {
            assert!(!language.monaco.is_empty(), "{}", language.id);
        }
    }
}
