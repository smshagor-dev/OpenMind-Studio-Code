//! The tools OpenMind knows by name (interpreters, compilers, package managers, formatters, linters, language
//! servers) and how it finds them. Finding a tool only *looks for a file*: nothing is run, nothing is installed and
//! no PATH is changed. The search order is the product rule for every tool: the project's own copy first
//! (`node_modules/.bin`, a virtual environment, `vendor/bin`), then OpenMind's portable runtimes, then the machine's
//! PATH — and the answer says which of the three it was.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Os {
    Windows,
    MacOs,
    Linux,
}

impl Os {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::MacOs
        } else {
            Self::Linux
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    /// The project's own copy.
    Project,
    /// A bundled app-local tool version (`<app>/tools`).
    Bundled,
    /// One of OpenMind's portable runtimes.
    Portable,
    /// The machine's PATH.
    System,
    /// An environment variable (an SDK location).
    Env,
}

#[derive(Debug, Clone, Copy)]
pub enum Kind {
    /// One or more executable names.
    Exe(&'static [&'static str]),
    /// Found when one of these environment variables names an existing folder.
    Env(&'static [&'static str]),
}

#[derive(Debug, Clone, Copy)]
pub struct ToolDef {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: Kind,
    /// What to do when it is missing.
    pub hint: &'static str,
}

const fn exe(
    id: &'static str,
    name: &'static str,
    names: &'static [&'static str],
    hint: &'static str,
) -> ToolDef {
    ToolDef {
        id,
        name,
        kind: Kind::Exe(names),
        hint,
    }
}

pub const TOOLS: &[ToolDef] = &[
    exe("node", "Node.js", &["node"], "Install Node.js from the Runtime Manager (Terminal > Manage Runtimes)."),
    exe("npm", "npm", &["npm"], "npm comes with Node.js: install Node.js from the Runtime Manager."),
    exe("npx", "npx", &["npx"], "npx comes with Node.js: install Node.js from the Runtime Manager."),
    exe("pnpm", "pnpm", &["pnpm"], "Install pnpm (for example `npm install -g pnpm` or corepack) — OpenMind doesn't install it."),
    exe("yarn", "Yarn", &["yarn"], "Install Yarn (for example `npm install -g yarn` or corepack) — OpenMind doesn't install it."),
    exe("bun", "Bun", &["bun"], "Install Bun from bun.sh — OpenMind doesn't install it."),
    exe("python", "Python", &["python", "python3", "py"], "Install Python from the Runtime Manager (Terminal > Manage Runtimes)."),
    exe("pip", "pip", &["pip", "pip3"], "pip comes with the portable Python from the Runtime Manager."),
    exe("pytest", "pytest", &["pytest"], "Install pytest in the project's environment (`pip install pytest`)."),
    exe("uvicorn", "uvicorn", &["uvicorn"], "Install uvicorn in the project's environment (`pip install uvicorn`)."),
    exe("flask", "Flask", &["flask"], "Install Flask in the project's environment (`pip install flask`)."),
    exe("php", "PHP", &["php"], "Install PHP from the Runtime Manager or the PHP Server window."),
    exe("composer", "Composer", &["composer"], "Install Composer from the PHP Server window."),
    exe("cargo", "Cargo", &["cargo"], "Install Rust (rustup) — OpenMind doesn't install it."),
    exe("rustc", "rustc", &["rustc"], "Install Rust (rustup) — OpenMind doesn't install it."),
    exe("rustfmt", "rustfmt", &["rustfmt"], "Add it with `rustup component add rustfmt`."),
    exe("go", "Go", &["go"], "Install Go from go.dev — OpenMind doesn't install it."),
    exe("gofmt", "gofmt", &["gofmt"], "gofmt comes with Go."),
    exe("java", "Java (JDK/JRE)", &["java"], "Install a JDK (for example Temurin) — OpenMind doesn't install it."),
    exe("javac", "javac", &["javac"], "Install a JDK (not only a JRE) — OpenMind doesn't install it."),
    exe("mvn", "Maven", &["mvn"], "Install Maven, or use the project's mvnw wrapper."),
    exe("gradle", "Gradle", &["gradle"], "Install Gradle, or use the project's gradlew wrapper."),
    exe("dotnet", ".NET SDK", &["dotnet"], "Install the .NET SDK from dotnet.microsoft.com — OpenMind doesn't install it."),
    exe("flutter", "Flutter SDK", &["flutter"], "Install the Flutter SDK from flutter.dev — OpenMind doesn't install it."),
    exe("dart", "Dart SDK", &["dart"], "Install the Dart SDK (it comes with Flutter) — OpenMind doesn't install it."),
    exe("adb", "Android Debug Bridge (adb)", &["adb"], "Install the Android SDK platform-tools and put them on PATH — OpenMind doesn't install them."),
    exe("xcodebuild", "Xcode command line tools", &["xcodebuild"], "Xcode is available only on macOS."),
    exe("ruby", "Ruby", &["ruby"], "Install Ruby — OpenMind doesn't install it."),
    exe("bundle", "Bundler", &["bundle"], "Install Bundler (`gem install bundler`)."),
    exe("docker", "Docker", &["docker"], "Install Docker Desktop or Docker Engine — OpenMind doesn't install it."),
    exe("powershell", "PowerShell", &["pwsh", "powershell"], "PowerShell ships with Windows."),
    exe("bash", "Bash", &["bash"], "Install Git for Windows (Git Bash) or use WSL."),
    exe("cmake", "CMake", &["cmake"], "Install CMake — OpenMind doesn't install it."),
    exe("make", "make", &["make", "mingw32-make"], "Install make (MSYS2, MinGW or build-essential)."),
    exe("gcc", "GCC", &["gcc"], "Install GCC (MinGW-w64, MSYS2 or build-essential)."),
    exe("clang", "Clang", &["clang"], "Install LLVM/Clang."),
    exe("clang-format", "clang-format", &["clang-format"], "Install LLVM (it includes clang-format)."),
    exe("git", "Git", &["git"], "Install Git from the Runtime Manager."),
    // Formatters and linters
    exe("prettier", "Prettier", &["prettier"], "Add it to the project (`npm i -D prettier`) — OpenMind doesn't install it."),
    exe("eslint", "ESLint", &["eslint"], "Add it to the project (`npm i -D eslint`) — OpenMind doesn't install it."),
    exe("biome", "Biome", &["biome"], "Add it to the project (`npm i -D @biomejs/biome`) — OpenMind doesn't install it."),
    exe("stylelint", "Stylelint", &["stylelint"], "Add it to the project (`npm i -D stylelint`) — OpenMind doesn't install it."),
    exe("black", "Black", &["black"], "Install Black in the project's environment (`pip install black`)."),
    exe("ruff", "Ruff", &["ruff"], "Install Ruff in the project's environment (`pip install ruff`)."),
    exe("isort", "isort", &["isort"], "Install isort in the project's environment (`pip install isort`)."),
    exe("php-cs-fixer", "PHP CS Fixer", &["php-cs-fixer"], "Add it to the project (`composer require --dev friendsofphp/php-cs-fixer`)."),
    exe("pint", "Laravel Pint", &["pint"], "Add it to the project (`composer require --dev laravel/pint`)."),
    exe("golangci-lint", "golangci-lint", &["golangci-lint"], "Install golangci-lint — OpenMind doesn't install it."),
    exe("ktlint", "ktlint", &["ktlint"], "Install ktlint — OpenMind doesn't install it."),
    // Language servers (found only; OpenMind starts the built-in ones itself)
    exe("typescript-language-server", "TypeScript Language Server", &["typescript-language-server"], "Install it from Language Tools (Manage > Language Tools)."),
    exe("vscode-html-language-server", "HTML Language Server", &["vscode-html-language-server"], "Install it from Language Tools (Manage > Language Tools)."),
    exe("vscode-css-language-server", "CSS Language Server", &["vscode-css-language-server"], "Install it from Language Tools (Manage > Language Tools)."),
    exe("vscode-json-language-server", "JSON Language Server", &["vscode-json-language-server"], "Install it from Language Tools (Manage > Language Tools)."),
    exe("pyright", "Pyright", &["pyright-langserver"], "Install it from Language Tools (Manage > Language Tools)."),
    exe("pylsp", "Python LSP Server (pylsp)", &["pylsp"], "Install it with `pip install python-lsp-server`."),
    exe("intelephense", "Intelephense", &["intelephense"], "Install it from Language Tools (Manage > Language Tools)."),
    exe("phpactor", "Phpactor", &["phpactor"], "Install Phpactor — OpenMind doesn't install it."),
    exe("rust-analyzer", "rust-analyzer", &["rust-analyzer"], "Add it with `rustup component add rust-analyzer`."),
    exe("gopls", "gopls", &["gopls"], "Install it with `go install golang.org/x/tools/gopls@latest`."),
    exe("jdtls", "Eclipse JDT Language Server", &["jdtls"], "Install the Eclipse JDT Language Server — OpenMind doesn't install it."),
    exe("clangd", "clangd", &["clangd"], "Install LLVM (it includes clangd)."),
    exe("omnisharp", "OmniSharp", &["OmniSharp", "omnisharp"], "Install OmniSharp — OpenMind doesn't install it."),
    exe("yaml-language-server", "YAML Language Server", &["yaml-language-server"], "Install it with `npm i -g yaml-language-server`."),
    exe("docker-langserver", "Dockerfile Language Server", &["docker-langserver"], "Install it with `npm i -g dockerfile-language-server-nodejs`."),
    exe("sql-language-server", "SQL Language Server", &["sql-language-server"], "Install it with `npm i -g sql-language-server`."),
    exe("graphql-lsp", "GraphQL Language Server", &["graphql-lsp"], "Install it with `npm i -g graphql-language-service-cli`."),
    exe("vue-language-server", "Vue Language Server (Volar)", &["vue-language-server"], "Add it to the project (`npm i -D @vue/language-server`)."),
    exe("svelteserver", "Svelte Language Server", &["svelteserver"], "Add it to the project (`npm i -D svelte-language-server`)."),
    exe("astro-ls", "Astro Language Server", &["astro-ls"], "Add it to the project (`npm i -D @astrojs/language-server`)."),
    exe("tailwindcss-language-server", "Tailwind CSS Language Server", &["tailwindcss-language-server"], "Add it to the project (`npm i -D @tailwindcss/language-server`)."),
    ToolDef {
        id: "android-sdk",
        name: "Android SDK",
        kind: Kind::Env(&["ANDROID_HOME", "ANDROID_SDK_ROOT"]),
        hint: "Install the Android SDK (Android Studio) and set ANDROID_HOME — OpenMind doesn't install it.",
    },
];

pub fn tool(id: &str) -> Option<&'static ToolDef> {
    TOOLS.iter().find(|tool| tool.id == id)
}

/// Where a tool was found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub path: String,
    pub source: Source,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub id: String,
    pub name: String,
    pub found: Option<Found>,
    /// What to do about it when it is missing.
    pub hint: String,
}

/// The places to look, in order. Built once per scan from the project, the Runtime Manager and the process
/// environment; tests build their own so nothing depends on the machine.
#[derive(Debug, Clone)]
pub struct ToolEnv {
    pub os: Os,
    pub project_dirs: Vec<PathBuf>,
    /// Folders of the active app-local tool versions (`<app>/tools/...`), after the project's own copy.
    pub bundled_dirs: Vec<PathBuf>,
    pub portable_dirs: Vec<PathBuf>,
    pub system_dirs: Vec<PathBuf>,
    /// Windows executable suffixes, in order (`.exe`, `.cmd`, ...). Empty elsewhere.
    pub pathext: Vec<String>,
    pub vars: HashMap<String, String>,
}

impl ToolEnv {
    /// The environment of this process, with the given portable runtime folders.
    pub fn from_process(portable_dirs: Vec<PathBuf>) -> Self {
        Self::with_bundled(Vec::new(), portable_dirs)
    }

    /// Like `from_process`, plus the folders of the bundled toolchain packs' active versions.
    pub fn with_bundled(bundled_dirs: Vec<PathBuf>, portable_dirs: Vec<PathBuf>) -> Self {
        let os = Os::current();
        let system_dirs = std::env::var_os("PATH")
            .map(|path| std::env::split_paths(&path).collect())
            .unwrap_or_default();
        let pathext = if os == Os::Windows {
            vec![".exe".into(), ".cmd".into(), ".bat".into(), ".com".into()]
        } else {
            Vec::new()
        };
        let vars = ["ANDROID_HOME", "ANDROID_SDK_ROOT"]
            .iter()
            .filter_map(|name| {
                std::env::var(name)
                    .ok()
                    .map(|value| ((*name).to_string(), value))
            })
            .collect();
        Self {
            os,
            project_dirs: Vec::new(),
            bundled_dirs,
            portable_dirs,
            system_dirs,
            pathext,
            vars,
        }
    }

    /// The same environment for a project rooted at `root`: its own tool folders come first.
    pub fn for_project(&self, root: &Path) -> Self {
        let mut env = self.clone();
        env.project_dirs = project_tool_dirs(root);
        env
    }
}

/// The folders inside a project where its own tools live.
pub fn project_tool_dirs(root: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![root.join("node_modules").join(".bin")];
    for venv in [".venv", "venv", "env"] {
        dirs.push(root.join(venv).join("Scripts"));
        dirs.push(root.join(venv).join("bin"));
    }
    dirs.push(root.join("vendor").join("bin"));
    dirs
}

fn candidates(name: &str, env: &ToolEnv) -> Vec<String> {
    if env.os == Os::Windows {
        if Path::new(name).extension().is_some() {
            return vec![name.to_string()];
        }
        return env
            .pathext
            .iter()
            .map(|ext| format!("{name}{ext}"))
            .collect();
    }
    vec![name.to_string()]
}

fn find_in(dirs: &[PathBuf], names: &[&str], env: &ToolEnv) -> Option<PathBuf> {
    for dir in dirs {
        for name in names {
            for file in candidates(name, env) {
                let path = dir.join(&file);
                if path.is_file() {
                    return Some(path);
                }
            }
        }
    }
    None
}

/// Looks for `def` (a file lookup; nothing is run).
pub fn resolve(def: &ToolDef, env: &ToolEnv) -> ToolStatus {
    let found = match def.kind {
        Kind::Exe(names) => [
            (&env.project_dirs, Source::Project),
            (&env.bundled_dirs, Source::Bundled),
            (&env.portable_dirs, Source::Portable),
            (&env.system_dirs, Source::System),
        ]
        .iter()
        .find_map(|(dirs, source)| {
            find_in(dirs, names, env).map(|path| Found {
                path: path.display().to_string(),
                source: *source,
            })
        }),
        Kind::Env(vars) => vars.iter().find_map(|var| {
            let value = env.vars.get(*var)?;
            Path::new(value).is_dir().then(|| Found {
                path: value.clone(),
                source: Source::Env,
            })
        }),
    };
    ToolStatus {
        id: def.id.to_string(),
        name: def.name.to_string(),
        found,
        hint: def.hint.to_string(),
    }
}

/// The status of a tool by id; an id the catalog doesn't know is reported as missing with no hint.
pub fn status_of(id: &str, env: &ToolEnv) -> ToolStatus {
    match tool(id) {
        Some(def) => resolve(def, env),
        None => ToolStatus {
            id: id.to_string(),
            name: id.to_string(),
            found: None,
            hint: String::new(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make(dir: &Path, name: &str) {
        std::fs::create_dir_all(dir).expect("dir");
        std::fs::write(dir.join(name), "").expect("file");
    }

    fn env(base: &Path, os: Os) -> ToolEnv {
        ToolEnv {
            os,
            project_dirs: vec![base.join("project")],
            bundled_dirs: vec![base.join("bundled")],
            portable_dirs: vec![base.join("portable")],
            system_dirs: vec![base.join("system")],
            pathext: if os == Os::Windows {
                vec![".exe".into(), ".cmd".into()]
            } else {
                vec![]
            },
            vars: HashMap::new(),
        }
    }

    #[test]
    fn the_project_copy_wins_then_bundled_then_portable_then_system() {
        let dir = tempfile::tempdir().expect("tmp");
        let e = env(dir.path(), Os::Windows);
        make(&dir.path().join("system"), "prettier.exe");
        let found = status_of("prettier", &e).found.expect("system");
        assert_eq!(found.source, Source::System);
        make(&dir.path().join("portable"), "prettier.cmd");
        assert_eq!(
            status_of("prettier", &e).found.expect("portable").source,
            Source::Portable
        );
        make(&dir.path().join("bundled"), "prettier.cmd");
        assert_eq!(
            status_of("prettier", &e).found.expect("bundled").source,
            Source::Bundled
        );
        make(&dir.path().join("project"), "prettier.cmd");
        assert_eq!(
            status_of("prettier", &e).found.expect("project").source,
            Source::Project
        );
    }

    #[test]
    fn a_missing_tool_says_what_to_do_and_a_bare_name_is_not_runnable_on_windows() {
        let dir = tempfile::tempdir().expect("tmp");
        let e = env(dir.path(), Os::Windows);
        make(&dir.path().join("system"), "cargo"); // a shell script without a suffix
        let status = status_of("cargo", &e);
        assert!(status.found.is_none());
        assert!(status.hint.contains("rustup"));
        let unix = env(dir.path(), Os::Linux);
        assert!(status_of("cargo", &unix).found.is_some());
    }

    #[test]
    fn several_names_and_an_unknown_id() {
        let dir = tempfile::tempdir().expect("tmp");
        let e = env(dir.path(), Os::Linux);
        make(&dir.path().join("system"), "python3");
        assert!(status_of("python", &e).found.is_some());
        let unknown = status_of("no-such-tool", &e);
        assert!(unknown.found.is_none() && unknown.hint.is_empty());
    }

    #[test]
    fn an_sdk_is_found_through_its_variable() {
        let dir = tempfile::tempdir().expect("tmp");
        let mut e = env(dir.path(), Os::Linux);
        assert!(status_of("android-sdk", &e).found.is_none());
        let sdk = dir.path().join("sdk");
        std::fs::create_dir_all(&sdk).expect("sdk");
        e.vars
            .insert("ANDROID_HOME".into(), sdk.display().to_string());
        assert_eq!(
            status_of("android-sdk", &e).found.expect("sdk").source,
            Source::Env
        );
        e.vars.insert(
            "ANDROID_HOME".into(),
            dir.path().join("missing").display().to_string(),
        );
        assert!(status_of("android-sdk", &e).found.is_none());
    }

    #[test]
    fn every_tool_the_registry_names_exists_in_the_catalog() {
        for language in crate::registry::LANGUAGES {
            for id in language
                .formatters
                .iter()
                .chain(language.linters)
                .chain(language.toolchains)
                .chain(language.lsp)
            {
                assert!(
                    tool(id).is_some(),
                    "{} names unknown tool {id}",
                    language.id
                );
            }
        }
    }

    #[test]
    fn project_tool_folders_are_inside_the_project() {
        let dirs = project_tool_dirs(Path::new("/p"));
        assert!(dirs.iter().all(|d| d.starts_with("/p")));
        assert!(dirs.contains(&Path::new("/p").join("node_modules").join(".bin")));
    }
}
