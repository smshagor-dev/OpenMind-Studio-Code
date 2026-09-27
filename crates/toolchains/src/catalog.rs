//! The tools OpenMind knows about, as static data compiled into the app. A tool that is in this list but not in
//! `tools/toolchains.json` is shown honestly as Missing (or External for the big SDKs): nothing is invented.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    Runtime,
    PackageManager,
    LanguageServer,
    Formatter,
    Linter,
    Debugger,
    Vcs,
    DatabaseTool,
    HelperTool,
    /// Mobile and desktop SDKs: always external, never bundled.
    Sdk,
}

#[derive(Debug, Clone, Copy)]
pub struct Known {
    pub id: &'static str,
    pub name: &'static str,
    pub category: Category,
    /// One short sentence for the card (two lines at most in the UI).
    pub summary: &'static str,
    /// The long explanation, shown in the details dialog only.
    pub details: &'static str,
    /// Languages and projects that use it.
    pub used_by: &'static [&'static str],
    /// The command a bundled copy provides (the manifest path's file name), so the language support can find it.
    pub command: &'static str,
    /// Large or not redistributable: never bundled, always installed by the user.
    pub external: bool,
    /// What to do when it is missing.
    pub hint: &'static str,
}

#[allow(clippy::too_many_arguments)]
const fn tool(
    id: &'static str,
    name: &'static str,
    category: Category,
    summary: &'static str,
    details: &'static str,
    used_by: &'static [&'static str],
    command: &'static str,
    hint: &'static str,
) -> Known {
    Known {
        id,
        name,
        category,
        summary,
        details,
        used_by,
        command,
        external: false,
        hint,
    }
}

#[allow(clippy::too_many_arguments)]
const fn external(
    id: &'static str,
    name: &'static str,
    category: Category,
    summary: &'static str,
    details: &'static str,
    used_by: &'static [&'static str],
    command: &'static str,
    hint: &'static str,
) -> Known {
    Known {
        id,
        name,
        category,
        summary,
        details,
        used_by,
        command,
        external: true,
        hint,
    }
}

use Category::*;

const NOT_SHIPPED: &str =
    "Not bundled in this build. Copy a version into tools/ and list it in tools/toolchains.json (see docs/toolchains.md).";

pub const KNOWN: &[Known] = &[
    tool("git", "Git", Vcs, "Version control used by Source Control.",
        "Git powers the Source Control view, clone, history, blame and stash. OpenMind uses the active app-local version first; the system Git is used only when you allow it. Nothing is installed system-wide.",
        &["Source Control"], "git", NOT_SHIPPED),
    tool("composer", "Composer", PackageManager, "PHP dependency manager.",
        "Composer installs a PHP project's packages. The active app-local version is used by Composer commands in Laravel and PHP projects; it runs on OpenMind's PHP, never a global one.",
        &["PHP", "Laravel"], "composer", NOT_SHIPPED),
    tool("debugpy", "Python debugger (debugpy)", Debugger, "Debug adapter for Python.",
        "debugpy is the debug adapter behind Run and Debug for Python. It runs on the active Python (OpenMind's portable Python first). Several versions can be kept; the active one is used when you start debugging. Nothing is downloaded when you debug: if no version is present the Run and Debug view says so and offers the Runtime Manager install.",
        &["Python"], "debugpy", NOT_SHIPPED),
    tool("black", "Black", Formatter, "Python code formatter.", "Black formats Python files. A project-local Black wins over this one.", &["Python"], "black", NOT_SHIPPED),
    tool("isort", "isort", Formatter, "Sorts Python imports.", "isort orders Python import statements.", &["Python"], "isort", NOT_SHIPPED),
    tool("pytest", "pytest", HelperTool, "Python test runner.", "pytest runs a Python project's tests. It is normally installed in the project's own environment.", &["Python"], "pytest", NOT_SHIPPED),
    tool("eslint", "ESLint", Linter, "JavaScript and TypeScript linter.", "ESLint lints JavaScript and TypeScript. A project-local ESLint wins over a bundled one.", &["JavaScript", "TypeScript"], "eslint", NOT_SHIPPED),
    tool("biome", "Biome", Formatter, "Formatter and linter for web languages.", "Biome formats and lints JavaScript, TypeScript, JSON and CSS.", &["JavaScript", "TypeScript", "JSON"], "biome", NOT_SHIPPED),
    tool("tailwindcss-language-server", "Tailwind CSS server", LanguageServer, "Tailwind class completions.", "The Tailwind CSS language server.", &["Tailwind CSS"], "tailwindcss-language-server", NOT_SHIPPED),
    tool("vue-language-server", "Vue language server", LanguageServer, "Vue single-file components.", "The Vue (Volar) language server.", &["Vue"], "vue-language-server", NOT_SHIPPED),
    tool("svelte-language-server", "Svelte language server", LanguageServer, "Svelte components.", "The Svelte language server.", &["Svelte"], "svelteserver", NOT_SHIPPED),
    tool("astro-language-server", "Astro language server", LanguageServer, "Astro components.", "The Astro language server.", &["Astro"], "astro-ls", NOT_SHIPPED),
    tool("intelephense", "Intelephense", LanguageServer, "PHP language server.", "Intelephense: PHP completions, hover and diagnostics (some features need its paid licence).", &["PHP"], "intelephense", NOT_SHIPPED),
    tool("phpactor", "Phpactor", LanguageServer, "Open-source PHP language server.", "Phpactor is an open-source PHP language server.", &["PHP"], "phpactor", NOT_SHIPPED),
    tool("php-cs-fixer", "PHP CS Fixer", Formatter, "PHP code style fixer.", "PHP CS Fixer formats PHP to a coding standard.", &["PHP"], "php-cs-fixer", NOT_SHIPPED),
    tool("pint", "Laravel Pint", Formatter, "Laravel code style fixer.", "Pint is normally a project dependency (vendor/bin/pint); a project-local copy wins.", &["Laravel", "PHP"], "pint", NOT_SHIPPED),
    tool("gopls", "gopls", LanguageServer, "Go language server.", "gopls, the Go language server. OpenMind can find it but cannot start it yet.", &["Go"], "gopls", NOT_SHIPPED),
    tool("graphql-language-service", "GraphQL language service", LanguageServer, "GraphQL language features.", "graphql-language-service-cli.", &["GraphQL"], "graphql-lsp", NOT_SHIPPED),
    tool("sql-language-server", "SQL language server", LanguageServer, "SQL completions and validation.", "sql-language-server.", &["SQL"], "sql-language-server", NOT_SHIPPED),
    external("rust-toolchain", "Rust toolchain", Runtime, "rustc, cargo, rustfmt and clippy.", "Install Rust with rustup. OpenMind detects cargo, rustc, rustfmt and clippy on your PATH; it does not bundle the toolchain.", &["Rust", "Tauri"], "cargo", "Install Rust (rustup) — OpenMind doesn't install it."),
    external("go-sdk", "Go SDK", Runtime, "Go compiler and tools.", "Install Go from go.dev. OpenMind detects go and gofmt.", &["Go"], "go", "Install Go from go.dev — OpenMind doesn't install it."),
    external("jdk", "Java JDK", Runtime, "Java compiler and runtime.", "Needed for Maven, Gradle and Android builds. Not bundled: the size and the choice of distribution are yours.", &["Java", "Kotlin", "Android"], "java", "Install a JDK (for example Temurin) — OpenMind doesn't install it."),
    external("dotnet-sdk", "Dotnet SDK", Runtime, ".NET compiler and tools.", "Install the .NET SDK from dotnet.microsoft.com. It is too large to bundle.", &["C#", ".NET"], "dotnet", "Install the .NET SDK from dotnet.microsoft.com — OpenMind doesn't install it."),
    external("cpp-toolchain", "C/C++ toolchain", Runtime, "Compiler and build tools.", "Install a compiler (MSVC Build Tools, LLVM or MinGW) and CMake. Not bundled.", &["C", "C++", "CMake"], "cmake", "Install CMake and a C/C++ compiler — OpenMind doesn't install them."),
    external("flutter-sdk", "Flutter SDK", Sdk, "Flutter and Dart SDK.", "Install Flutter from flutter.dev. The SDK is far too large to bundle.", &["Flutter", "Dart"], "flutter", "Install the Flutter SDK from flutter.dev — OpenMind doesn't install it."),
    external("android-sdk", "Android SDK", Sdk, "Android build tools and platforms.", "Install Android Studio or the command-line SDK and set ANDROID_HOME. OpenMind has no emulator or device manager.", &["Android", "React Native", "Flutter"], "adb", "Install the Android SDK and set ANDROID_HOME — OpenMind doesn't install it."),
    external("xcode", "Xcode", Sdk, "Apple build tools (macOS only).", "iOS and macOS builds need Xcode on a Mac. They cannot run on this operating system.", &["iOS", "macOS"], "xcodebuild", "iOS builds require macOS and Xcode."),
    external("docker", "Docker", HelperTool, "Container engine.", "Install Docker Desktop or Docker Engine. Not bundled.", &["Docker"], "docker", "Install Docker — OpenMind doesn't install it."),
];

pub fn known(id: &str) -> Option<&'static Known> {
    KNOWN.iter().find(|k| k.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn ids_are_unique_and_every_entry_is_complete() {
        let mut seen = HashSet::new();
        for k in KNOWN {
            assert!(seen.insert(k.id), "duplicate {}", k.id);
            assert!(
                !k.summary.is_empty()
                    && !k.details.is_empty()
                    && !k.hint.is_empty()
                    && !k.command.is_empty()
            );
            assert!(
                k.summary.len() <= 80,
                "{} summary is too long for a two-line card",
                k.id
            );
        }
    }

    #[test]
    fn the_big_sdks_are_external_and_the_small_tools_are_not() {
        for id in [
            "flutter-sdk",
            "android-sdk",
            "xcode",
            "jdk",
            "dotnet-sdk",
            "cpp-toolchain",
            "docker",
        ] {
            assert!(known(id).expect(id).external, "{id}");
        }
        for id in ["git", "composer", "debugpy", "biome", "eslint", "black"] {
            assert!(!known(id).expect(id).external, "{id}");
        }
    }

    #[test]
    fn servers_and_formatters_of_the_offline_lsp_bundle_are_not_tool_packs() {
        // They live in `lsp/` (Language Tools, formatting); listing them here too would show them "Missing".
        for id in [
            "pyright",
            "typescript-language-server",
            "vscode-langservers-extracted",
            "rust-analyzer",
            "clangd",
            "yaml-language-server",
            "dockerfile-language-server",
            "prettier",
            "ruff",
            "gofmt",
            "clang-format",
            "stylua",
        ] {
            assert!(known(id).is_none(), "{id}");
        }
    }
}
