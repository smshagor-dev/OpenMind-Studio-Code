//! The catalog: every component a workload or language pack can contain, and how OpenMind really provides it.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    Runtime,
    Sdk,
    PackageManager,
    Framework,
    LanguageServer,
    Debugger,
    Formatter,
    Linter,
    Database,
    Tool,
}

/// How a component gets onto this computer. Only `Runtime` (and what comes with one) is installed by OpenMind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Provision {
    /// A Runtime Manager download (checksum-verified, app-local).
    Runtime { id: &'static str },
    /// Part of a runtime (npm with Node.js, LLDB with LLVM-MinGW).
    IncludedWith { runtime: &'static str },
    /// A language server in OpenMind's offline bundle.
    LspBundled { server: &'static str },
    /// A language server installed on request from Language Tools (not redistributable).
    LspOnRequest { server: &'static str },
    /// Added to a project by its own package manager; the command is shown, never run for you.
    Project { command: &'static str },
    /// Part of OpenMind itself.
    BuiltIn,
    /// Installed outside OpenMind (an installer, a system component, a service).
    External { admin: bool },
    /// Not available yet.
    Planned,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub id: &'static str,
    pub name: &'static str,
    pub category: Category,
    pub provision: Provision,
    /// A tool id of `openmind-language` used to find a copy on this computer.
    pub detect: Option<&'static str>,
    /// Why it is external/manual/planned, or a note (English; the UI translates known ids).
    pub note: &'static str,
    /// Other components it needs.
    pub requires: &'static [&'static str],
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Framework {
    pub id: &'static str,
    pub name: &'static str,
    /// What a project of this kind needs to be ready (component ids).
    pub needs: &'static [&'static str],
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workload {
    pub id: &'static str,
    pub name: &'static str,
    pub summary: &'static str,
    pub components: &'static [&'static str],
    pub frameworks: &'static [&'static str],
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pack {
    pub id: &'static str,
    pub name: &'static str,
    pub components: &'static [&'static str],
}

use Category::*;

const fn c(
    id: &'static str,
    name: &'static str,
    category: Category,
    provision: Provision,
    detect: Option<&'static str>,
    note: &'static str,
    requires: &'static [&'static str],
) -> Component {
    Component {
        id,
        name,
        category,
        provision,
        detect,
        note,
        requires,
    }
}

const fn rt(
    id: &'static str,
    name: &'static str,
    category: Category,
    detect: Option<&'static str>,
    requires: &'static [&'static str],
) -> Component {
    c(
        id,
        name,
        category,
        Provision::Runtime { id },
        detect,
        "",
        requires,
    )
}

const fn with(
    id: &'static str,
    name: &'static str,
    category: Category,
    runtime: &'static str,
    note: &'static str,
) -> Component {
    c(
        id,
        name,
        category,
        Provision::IncludedWith { runtime },
        None,
        note,
        &[],
    )
}

const fn project(
    id: &'static str,
    name: &'static str,
    category: Category,
    command: &'static str,
    detect: Option<&'static str>,
) -> Component {
    c(
        id,
        name,
        category,
        Provision::Project { command },
        detect,
        "",
        &[],
    )
}

const fn ext(
    id: &'static str,
    name: &'static str,
    category: Category,
    admin: bool,
    detect: Option<&'static str>,
    note: &'static str,
) -> Component {
    c(
        id,
        name,
        category,
        Provision::External { admin },
        detect,
        note,
        &[],
    )
}

const fn planned(
    id: &'static str,
    name: &'static str,
    category: Category,
    detect: Option<&'static str>,
    note: &'static str,
) -> Component {
    c(id, name, category, Provision::Planned, detect, note, &[])
}

const fn lsp(id: &'static str, name: &'static str, server: &'static str) -> Component {
    c(
        id,
        name,
        LanguageServer,
        Provision::LspBundled { server },
        None,
        "",
        &[],
    )
}

const fn builtin(
    id: &'static str,
    name: &'static str,
    category: Category,
    note: &'static str,
) -> Component {
    c(id, name, category, Provision::BuiltIn, None, note, &[])
}

pub const COMPONENTS: &[Component] = &[
    // Runtimes and SDKs OpenMind installs (Runtime Manager manifests).
    rt("node", "Node.js", Runtime, Some("node"), &[]),
    rt("python", "Python", Runtime, Some("python"), &[]),
    rt("php", "PHP", Runtime, Some("php"), &[]),
    rt("composer", "Composer", PackageManager, Some("composer"), &["php"]),
    rt("git", "Git", Tool, Some("git"), &[]),
    rt("git-lfs", "Git LFS", Tool, Some("git-lfs"), &["git"]),
    rt("mariadb", "MariaDB", Database, Some("mysql"), &[]),
    rt("phpmyadmin", "phpMyAdmin", Database, None, &["php", "mariadb"]),
    rt("debugpy", "Python debugger (debugpy)", Debugger, None, &["python"]),
    rt("js-debug", "JavaScript debugger (js-debug)", Debugger, None, &["node"]),
    rt("jdk", "Java JDK (Temurin 21)", Sdk, Some("java"), &[]),
    rt("maven", "Maven", Tool, Some("mvn"), &["jdk"]),
    rt("gradle", "Gradle", Tool, Some("gradle"), &["jdk"]),
    rt("kotlin", "Kotlin compiler", Sdk, Some("kotlinc"), &["jdk"]),
    rt("go", "Go", Sdk, Some("go"), &[]),
    rt("cmake", "CMake", Tool, Some("cmake"), &[]),
    rt("ninja", "Ninja", Tool, Some("ninja"), &[]),
    rt("llvm-mingw", "C/C++ toolchain (LLVM-MinGW)", Sdk, Some("clang"), &[]),
    rt("fortran", "Fortran compiler (gfortran)", Sdk, Some("gfortran"), &[]),
    rt("pascal", "Free Pascal compiler", Sdk, Some("fpc"), &[]),
    rt("assembly", "Assembly toolchain (NASM, MinGW-w64 linker, binutils, GDB)", Sdk, Some("nasm"), &[]),
    rt("kubectl", "kubectl", Tool, Some("kubectl"), &[]),
    rt("helm", "Helm", Tool, Some("helm"), &[]),
    rt("terraform", "Terraform", Tool, Some("terraform"), &[]),
    rt("dotnet", ".NET SDK", Sdk, Some("dotnet"), &[]),
    rt("dart", "Dart SDK", Sdk, Some("dart"), &[]),
    rt("flutter", "Flutter SDK", Sdk, Some("flutter"), &["git"]),
    rt("android-cmdline-tools", "Android command-line tools", Sdk, Some("android-sdk"), &["jdk"]),
    rt("android-platform-tools", "Android platform tools (adb)", Sdk, Some("adb"), &[]),
    rt("sqlite", "SQLite tools", Database, Some("sqlite3"), &[]),
    rt("postgresql", "PostgreSQL client tools", Database, Some("psql"), &[]),
    rt("livekit", "Classroom voice server (LiveKit, for large collaboration calls)", Tool, None, &[]),
    rt("llamacpp", "Local AI engine (llama.cpp, for the OpenMindAI Agent)", Tool, None, &[]),
    // Parts of a runtime.
    with("npm", "npm", PackageManager, "node", "Comes with Node.js."),
    with("pip", "pip", PackageManager, "python", "Comes with OpenMind's Python."),
    with("venv", "venv", Tool, "python", "Comes with OpenMind's Python (python -m venv)."),
    with("dotnet-runtime", ".NET Runtime", Runtime, "dotnet", "Included in the .NET SDK."),
    with("aspnet-runtime", "ASP.NET Core Runtime", Runtime, "dotnet", "Included in the .NET SDK."),
    with("dotnet-templates", ".NET project templates", Tool, "dotnet", "dotnet new (console, web, blazor, classlib ...) comes with the SDK."),
    with("mysql-client", "MySQL / MariaDB client", Database, "mariadb", "The mariadb client (MySQL-compatible) comes with MariaDB."),
    with("lldb", "LLDB debugger", Debugger, "llvm-mingw", "Comes with LLVM-MinGW."),
    with("dart-analysis-server", "Dart analysis server", LanguageServer, "dart", "Comes with the Dart SDK (dart language-server). OpenMind doesn't start it as a language server yet."),
    // OpenMind's offline language servers.
    lsp("lsp-typescript", "TypeScript / JavaScript language server", "typescript"),
    lsp("lsp-html", "HTML language server", "html"),
    lsp("lsp-css", "CSS / SCSS / Less language server", "css"),
    lsp("lsp-json", "JSON language server", "json"),
    lsp("lsp-pyright", "Pyright (Python language server)", "python"),
    lsp("lsp-yaml", "YAML language server", "yaml"),
    lsp("lsp-bash", "Bash language server", "bash"),
    lsp("lsp-dockerfile", "Dockerfile language server", "dockerfile"),
    lsp("lsp-rust-analyzer", "rust-analyzer", "rust"),
    lsp("lsp-clangd", "clangd", "clangd"),
    c("lsp-fortls", "fortls (Fortran language server)", LanguageServer, Provision::LspOnRequest { server: "fortran" }, Some("fortls"),
      "Installed with Python/pip when you click Install in Language Tools.", &["python"]),
    c("lsp-asm-lsp", "asm-lsp (Assembly language server)", LanguageServer, Provision::LspOnRequest { server: "assembly" }, Some("asm-lsp"),
      "Downloaded from conda-forge (SHA-256 checked) when you click Install in Language Tools.", &[]),
    c("lsp-intelephense", "Intelephense (PHP language server)", LanguageServer, Provision::LspOnRequest { server: "php" }, Some("intelephense"),
      "Its licence doesn't allow bundling: installed from npm when you click Install in Language Tools.", &["node"]),
    // Added to a project by its package manager.
    project("pnpm", "pnpm", PackageManager, "corepack enable pnpm", Some("pnpm")),
    project("yarn", "Yarn", PackageManager, "corepack enable yarn", Some("yarn")),
    project("typescript", "TypeScript compiler", Tool, "npm i -D typescript", None),
    project("vite", "Vite", Framework, "npm create vite@latest", None),
    project("eslint", "ESLint", Linter, "npm i -D eslint", Some("eslint")),
    project("prettier", "Prettier", Formatter, "npm i -D prettier", Some("prettier")),
    project("biome", "Biome", Formatter, "npm i -D @biomejs/biome", Some("biome")),
    project("tailwind", "Tailwind CSS", Framework, "npm i -D tailwindcss", None),
    project("angular-cli", "Angular CLI", Framework, "npx @angular/cli new my-app", None),
    project("ruff", "Ruff", Linter, "pip install ruff", Some("ruff")),
    project("black", "Black", Formatter, "pip install black", Some("black")),
    project("pytest", "pytest", Tool, "pip install pytest", Some("pytest")),
    project("jupyter", "Jupyter kernel (ipykernel)", Tool, "pip install ipykernel", None),
    project("onnxruntime", "ONNX Runtime", Tool, "pip install onnxruntime", None),
    project("laravel-installer", "Laravel", Framework, "composer create-project laravel/laravel my-app", None),
    project("pint", "Laravel Pint", Formatter, "composer require --dev laravel/pint", Some("pint")),
    project("artisan", "Artisan", Tool, "php artisan list", None),
    project("spring-boot", "Spring Boot", Framework, "Spring Initializr project (Maven or Gradle)", None),
    project("javafx", "JavaFX", Framework, "org.openjfx dependencies in Maven or Gradle", None),
    project("gopls", "gopls (Go language server)", LanguageServer, "go install golang.org/x/tools/gopls@latest", Some("gopls")),
    project("react-native", "React Native", Framework, "npx @react-native-community/cli init MyApp", None),
    project("expo", "Expo", Framework, "npx create-expo-app@latest", None),
    project("ionic", "Ionic", Framework, "npx @ionic/cli start", None),
    project("capacitor", "Capacitor", Framework, "npm i @capacitor/core @capacitor/cli", None),
    project("db-migrations", "Migration tools", Tool, "Prisma, Alembic, Laravel migrations, Flyway ... from the project", None),
    // Part of OpenMind.
    builtin("offline-cache", "Offline package cache (wheels, VSIX, runtime archives)", Tool, "Network > Offline Packages."),
    builtin("browser-preview", "Markdown / HTML preview and Open in Browser", Tool, "File previews and the PHP server."),
    builtin("notebooks", "Notebook editor", Tool, "Opens .ipynb files; runs cells with a Python kernel."),
    builtin("laravel-helper", "Laravel helper (PHP Configuration)", Tool, "Copies DB settings and shows Laravel commands."),
    builtin("local-ai", "Local AI providers", Tool, "Talks to a model server you run (Ollama, LM Studio ...)."),
    // External or system-level: never installed by OpenMind.
    ext("docker", "Docker Desktop / Docker Engine", Tool, true, Some("docker"), "A system service with admin rights: install Docker Desktop yourself. OpenMind detects the docker CLI."),
    ext("docker-compose", "Docker Compose", Tool, true, Some("docker"), "Comes with Docker Desktop (docker compose)."),
    ext("msvc", "Visual Studio Build Tools (MSVC)", Sdk, true, Some("cl"), "Needs the Visual Studio installer and admin rights. OpenMind never installs it; LLVM-MinGW covers MinGW builds."),
    ext("dotnet-framework", ".NET Framework (legacy)", Runtime, true, None, "A Windows system component (4.8 ships with Windows). Not the modern .NET SDK; OpenMind only detects it."),
    ext("maui", ".NET MAUI", Framework, false, None, "Needs `dotnet workload install maui` plus the Android/iOS SDKs; OpenMind doesn't install it."),
    ext("android-studio", "Android Studio", Sdk, false, None, "A large IDE installer; OpenMind never installs it silently."),
    ext("android-emulator", "Android Emulator", Sdk, false, None, "Heavy (system images, hardware acceleration); install it with sdkmanager or Android Studio yourself."),
    ext("xcode", "Xcode (iOS builds)", Sdk, false, Some("xcodebuild"), "iOS and macOS builds need Xcode on a Mac."),
    ext("rustup", "Rust toolchain (rustup)", Sdk, false, Some("rustup"), "Installed with rustup into your user profile; OpenMind detects cargo and rustc."),
    ext("cargo", "Cargo", PackageManager, false, Some("cargo"), "Comes with the Rust toolchain (rustup)."),
    ext("redis", "Redis", Database, false, Some("redis-server"), "Redis publishes no official Windows build: use WSL or Docker."),
    ext("cuda", "NVIDIA CUDA", Sdk, true, Some("nvcc"), "A driver-level stack installed by NVIDIA's installer. OpenMind never installs GPU drivers."),
    ext("rocm", "AMD ROCm", Sdk, true, None, "A driver-level stack; not available for Windows desktops in general. Never installed by OpenMind."),
    // Not available yet.
    with("gdb", "GDB", Debugger, "assembly", "Comes with the Assembly toolchain (w64devkit's GDB)."),
    planned("jdtls", "Java language server (JDT LS)", LanguageServer, Some("jdtls"), "OpenMind can't start JDT LS yet."),
    planned("csharp-lsp", "C# language server (OmniSharp / Roslyn)", LanguageServer, Some("omnisharp"), "OpenMind can't start a C# language server yet."),
    planned("phpactor", "Phpactor (PHP language server)", LanguageServer, Some("phpactor"), "A future offline (MIT) option for PHP."),
    planned("nuget-offline", "NuGet offline import", Tool, None, "Importing .nupkg files into the offline cache is not supported yet."),
];

pub fn component(id: &str) -> Option<&'static Component> {
    COMPONENTS.iter().find(|c| c.id == id)
}

pub const FRAMEWORKS: &[Framework] = &[
    Framework {
        id: "react",
        name: "React",
        needs: &["node"],
    },
    Framework {
        id: "nextjs",
        name: "Next.js",
        needs: &["node"],
    },
    Framework {
        id: "vue",
        name: "Vue",
        needs: &["node"],
    },
    Framework {
        id: "svelte",
        name: "Svelte",
        needs: &["node"],
    },
    Framework {
        id: "astro",
        name: "Astro",
        needs: &["node"],
    },
    Framework {
        id: "angular",
        name: "Angular",
        needs: &["node"],
    },
    Framework {
        id: "express",
        name: "Express",
        needs: &["node"],
    },
    Framework {
        id: "nestjs",
        name: "NestJS",
        needs: &["node"],
    },
    Framework {
        id: "vite",
        name: "Vite",
        needs: &["node"],
    },
    Framework {
        id: "tailwind",
        name: "Tailwind CSS",
        needs: &["node"],
    },
    Framework {
        id: "django",
        name: "Django",
        needs: &["python"],
    },
    Framework {
        id: "fastapi",
        name: "FastAPI",
        needs: &["python"],
    },
    Framework {
        id: "flask",
        name: "Flask",
        needs: &["python"],
    },
    Framework {
        id: "jupyter",
        name: "Jupyter",
        needs: &["python"],
    },
    Framework {
        id: "pytest",
        name: "pytest",
        needs: &["python"],
    },
    Framework {
        id: "laravel",
        name: "Laravel",
        needs: &["php", "composer"],
    },
    Framework {
        id: "symfony",
        name: "Symfony",
        needs: &["php", "composer"],
    },
    Framework {
        id: "composer-project",
        name: "Composer project",
        needs: &["php", "composer"],
    },
    Framework {
        id: "dotnet-console",
        name: "Console app",
        needs: &["dotnet"],
    },
    Framework {
        id: "aspnetcore",
        name: "ASP.NET Core",
        needs: &["dotnet"],
    },
    Framework {
        id: "blazor",
        name: "Blazor",
        needs: &["dotnet"],
    },
    Framework {
        id: "winforms-wpf",
        name: "WinForms / WPF",
        needs: &["dotnet"],
    },
    Framework {
        id: "maui",
        name: ".NET MAUI",
        needs: &["dotnet", "maui"],
    },
    Framework {
        id: "spring-boot",
        name: "Spring Boot",
        needs: &["jdk"],
    },
    Framework {
        id: "maven-project",
        name: "Maven project",
        needs: &["jdk", "maven"],
    },
    Framework {
        id: "gradle-project",
        name: "Gradle project",
        needs: &["jdk", "gradle"],
    },
    Framework {
        id: "javafx",
        name: "JavaFX",
        needs: &["jdk"],
    },
    Framework {
        id: "flutter-app",
        name: "Flutter app",
        needs: &["flutter"],
    },
    Framework {
        id: "dart-package",
        name: "Dart package",
        needs: &["dart"],
    },
    Framework {
        id: "android-project",
        name: "Android project",
        needs: &["jdk", "android-cmdline-tools"],
    },
    Framework {
        id: "react-native",
        name: "React Native",
        needs: &["node", "jdk", "android-cmdline-tools"],
    },
    Framework {
        id: "expo",
        name: "Expo",
        needs: &["node"],
    },
    Framework {
        id: "ionic",
        name: "Ionic",
        needs: &["node"],
    },
    Framework {
        id: "capacitor",
        name: "Capacitor",
        needs: &["node"],
    },
    Framework {
        id: "cargo-project",
        name: "Rust Cargo project",
        needs: &["cargo"],
    },
    Framework {
        id: "go-module",
        name: "Go module",
        needs: &["go"],
    },
    Framework {
        id: "cmake-project",
        name: "CMake project",
        needs: &["cmake", "llvm-mingw"],
    },
    Framework {
        id: "makefile-project",
        name: "Makefile project",
        needs: &["llvm-mingw"],
    },
];

pub fn framework(id: &str) -> Option<&'static Framework> {
    FRAMEWORKS.iter().find(|f| f.id == id)
}

pub const WORKLOADS: &[Workload] = &[
    Workload { id: "minimal", name: "Minimal install", summary: "OpenMind Studio only: no optional downloads. Install anything later from Runtime Manager > Workloads.", components: &[], frameworks: &[] },
    Workload {
        id: "web", name: "Web development", summary: "Node.js, package managers, TypeScript, the web language servers, linters, formatters and front-end frameworks.",
        components: &["node", "npm", "pnpm", "yarn", "typescript", "js-debug", "lsp-typescript", "lsp-html", "lsp-css", "lsp-json", "vite", "eslint", "prettier", "biome", "tailwind", "angular-cli", "browser-preview"],
        frameworks: &["react", "nextjs", "vue", "svelte", "astro", "angular", "express", "nestjs", "vite", "tailwind"],
    },
    Workload {
        id: "python", name: "Python development", summary: "Python with pip and venv, the debugger, Pyright, Ruff, Black, pytest, notebooks and offline wheels.",
        components: &["python", "pip", "venv", "debugpy", "lsp-pyright", "ruff", "black", "pytest", "jupyter", "notebooks", "offline-cache"],
        frameworks: &["django", "fastapi", "flask", "jupyter", "pytest"],
    },
    Workload {
        id: "php", name: "PHP / Laravel", summary: "PHP, Composer, MariaDB and phpMyAdmin, Laravel tools and the PHP language server.",
        components: &["php", "composer", "mariadb", "phpmyadmin", "laravel-installer", "pint", "artisan", "laravel-helper", "lsp-intelephense", "phpactor"],
        frameworks: &["laravel", "symfony", "composer-project"],
    },
    Workload {
        id: "dotnet", name: ".NET / C# development", summary: "The .NET 10 SDK with its runtimes and templates. Visual Studio Build Tools, .NET Framework and MAUI stay external.",
        components: &["dotnet", "dotnet-runtime", "aspnet-runtime", "dotnet-templates", "csharp-lsp", "nuget-offline", "dotnet-framework", "msvc", "maui"],
        frameworks: &["dotnet-console", "aspnetcore", "blazor", "winforms-wpf", "maui"],
    },
    Workload {
        id: "java", name: "Java / Kotlin development", summary: "Temurin JDK 21, Maven, Gradle and the Kotlin compiler.",
        components: &["jdk", "maven", "gradle", "kotlin", "jdtls", "spring-boot", "javafx"],
        frameworks: &["spring-boot", "maven-project", "gradle-project", "javafx"],
    },
    Workload {
        id: "mobile", name: "Flutter / Dart / mobile", summary: "Flutter and Dart, the Android command-line and platform tools with the JDK and Gradle, and React Native / Expo / Ionic / Capacitor helpers. Android Studio and the emulator stay external.",
        components: &["flutter", "dart", "dart-analysis-server", "android-cmdline-tools", "android-platform-tools", "jdk", "gradle", "react-native", "expo", "ionic", "capacitor", "android-studio", "android-emulator", "xcode"],
        frameworks: &["flutter-app", "dart-package", "android-project", "react-native", "expo", "ionic", "capacitor"],
    },
    Workload {
        id: "systems", name: "Systems development", summary: "Go, C/C++, Fortran, Pascal, Assembly (NASM), CMake, Ninja, clangd, fortls, asm-lsp and rust-analyzer. Rust itself installs with rustup.",
        components: &["go", "gopls", "llvm-mingw", "lldb", "fortran", "pascal", "assembly", "lsp-asm-lsp", "cmake", "ninja", "lsp-clangd", "lsp-fortls", "lsp-rust-analyzer", "rustup", "cargo", "gdb", "msvc"],
        frameworks: &["cargo-project", "go-module", "cmake-project", "makefile-project"],
    },
    Workload {
        id: "database", name: "Database development", summary: "MariaDB with its client, PostgreSQL client tools, SQLite tools and phpMyAdmin.",
        components: &["mariadb", "mysql-client", "postgresql", "sqlite", "phpmyadmin", "redis", "db-migrations"],
        frameworks: &[],
    },
    Workload {
        id: "devops", name: "DevOps / cloud tools", summary: "Git and Git LFS, kubectl, Helm, Terraform and the YAML/Dockerfile/Bash language servers. Docker stays external.",
        components: &["git", "git-lfs", "kubectl", "helm", "terraform", "lsp-yaml", "lsp-dockerfile", "lsp-bash", "docker", "docker-compose"],
        frameworks: &[],
    },
    Workload {
        id: "aiml", name: "AI / ML development", summary: "Python with notebooks and offline wheels, ONNX Runtime in projects and local model providers. GPU drivers stay external.",
        components: &["python", "pip", "jupyter", "notebooks", "offline-cache", "onnxruntime", "local-ai", "llamacpp", "cuda", "rocm"],
        frameworks: &["jupyter"],
    },
    Workload {
        id: "full-offline", name: "Full offline toolkit", summary: "Every runtime and SDK OpenMind can install, the offline language servers, the debuggers and the offline cache. Several GB: deselect the heavy SDKs you don't need.",
        components: &["node", "python", "php", "composer", "git", "git-lfs", "mariadb", "phpmyadmin", "debugpy", "js-debug", "jdk", "maven", "gradle", "kotlin", "go", "cmake", "ninja", "llvm-mingw", "fortran", "pascal", "assembly", "kubectl", "helm", "terraform", "dotnet", "dart", "flutter", "android-cmdline-tools", "android-platform-tools", "sqlite", "postgresql", "livekit", "llamacpp", "lsp-typescript", "lsp-html", "lsp-css", "lsp-json", "lsp-pyright", "lsp-yaml", "lsp-bash", "lsp-dockerfile", "lsp-rust-analyzer", "lsp-clangd", "offline-cache"],
        frameworks: &[],
    },
];

pub fn workload(id: &str) -> Option<&'static Workload> {
    WORKLOADS.iter().find(|w| w.id == id)
}

pub const PACKS: &[Pack] = &[
    Pack {
        id: "js-ts",
        name: "JavaScript / TypeScript",
        components: &[
            "node",
            "npm",
            "pnpm",
            "yarn",
            "typescript",
            "js-debug",
            "lsp-typescript",
            "eslint",
            "prettier",
            "biome",
        ],
    },
    Pack {
        id: "python",
        name: "Python",
        components: &[
            "python",
            "pip",
            "venv",
            "debugpy",
            "lsp-pyright",
            "ruff",
            "black",
            "pytest",
        ],
    },
    Pack {
        id: "php",
        name: "PHP",
        components: &["php", "composer", "lsp-intelephense", "pint"],
    },
    Pack {
        id: "dotnet",
        name: ".NET / C#",
        components: &[
            "dotnet",
            "dotnet-runtime",
            "aspnet-runtime",
            "dotnet-templates",
            "csharp-lsp",
        ],
    },
    Pack {
        id: "java-kotlin",
        name: "Java / Kotlin",
        components: &["jdk", "maven", "gradle", "kotlin", "jdtls"],
    },
    Pack {
        id: "flutter-dart",
        name: "Flutter / Dart",
        components: &[
            "flutter",
            "dart",
            "dart-analysis-server",
            "android-cmdline-tools",
            "android-platform-tools",
        ],
    },
    Pack {
        id: "rust",
        name: "Rust",
        components: &["rustup", "cargo", "lsp-rust-analyzer"],
    },
    Pack {
        id: "go",
        name: "Go",
        components: &["go", "gopls"],
    },
    Pack {
        id: "cpp",
        name: "C / C++",
        components: &["llvm-mingw", "lldb", "cmake", "ninja", "lsp-clangd", "msvc"],
    },
    Pack {
        id: "database",
        name: "Database",
        components: &["mariadb", "mysql-client", "postgresql", "sqlite", "redis"],
    },
    Pack {
        id: "devops",
        name: "DevOps",
        components: &["git", "git-lfs", "kubectl", "helm", "terraform", "docker"],
    },
    Pack {
        id: "aiml",
        name: "AI / ML",
        components: &["python", "jupyter", "onnxruntime", "cuda", "rocm"],
    },
];

pub fn pack(id: &str) -> Option<&'static Pack> {
    PACKS.iter().find(|p| p.id == id)
}
