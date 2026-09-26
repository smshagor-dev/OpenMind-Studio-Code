//! Project detection and command discovery against real folders (a temp dir with a space in its path), for every
//! stack the milestone names. Tools are looked up in a fake environment, so nothing depends on this machine.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use openmind_language::commands::Category;
use openmind_language::{workspace_status, Os, ProjectStatus, ToolEnv, WorkspaceStatus};

struct Work {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

fn work() -> Work {
    let dir = tempfile::tempdir().expect("tmp");
    let root = dir.path().join("My Project");
    fs::create_dir_all(&root).expect("root");
    Work { _dir: dir, root }
}

impl Work {
    fn file(&self, relative: &str, text: &str) -> &Self {
        let path = self.root.join(relative);
        fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
        fs::write(path, text).expect("file");
        self
    }

    fn dir(&self, relative: &str) -> &Self {
        fs::create_dir_all(self.root.join(relative)).expect("dir");
        self
    }
}

fn env(os: Os, tools: &[&str]) -> (tempfile::TempDir, ToolEnv) {
    let bin = tempfile::tempdir().expect("bin");
    for tool in tools {
        let name = if os == Os::Windows {
            format!("{tool}.exe")
        } else {
            (*tool).to_string()
        };
        fs::write(bin.path().join(name), "").expect("tool");
    }
    let env = ToolEnv {
        os,
        project_dirs: vec![],
        bundled_dirs: vec![],
        portable_dirs: vec![],
        system_dirs: vec![bin.path().to_path_buf()],
        pathext: if os == Os::Windows {
            vec![".exe".into()]
        } else {
            vec![]
        },
        vars: HashMap::new(),
    };
    (bin, env)
}

fn scan(work: &Work, os: Os, tools: &[&str]) -> WorkspaceStatus {
    let (_bin, env) = env(os, tools);
    workspace_status(&work.root, &env)
}

fn project<'a>(status: &'a WorkspaceStatus, root: &str) -> &'a ProjectStatus {
    status
        .projects
        .iter()
        .find(|p| p.project.root == root)
        .unwrap_or_else(|| {
            panic!(
                "no project at {root:?}: {:?}",
                status
                    .projects
                    .iter()
                    .map(|p| &p.project.root)
                    .collect::<Vec<_>>()
            )
        })
}

fn has(p: &ProjectStatus, id: &str) -> bool {
    p.project.has(id)
}

fn command<'a>(p: &'a ProjectStatus, id: &str) -> &'a openmind_language::CommandStatus {
    p.command_status
        .iter()
        .find(|c| c.command.id == id)
        .unwrap_or_else(|| {
            panic!(
                "no command {id}: {:?}",
                p.command_status
                    .iter()
                    .map(|c| &c.command.id)
                    .collect::<Vec<_>>()
            )
        })
}

fn line(p: &ProjectStatus, id: &str) -> String {
    command(p, id).command.argv.join(" ")
}

fn no_command(p: &ProjectStatus, id: &str) {
    assert!(
        !p.command_status.iter().any(|c| c.command.id == id),
        "unexpected command {id}"
    );
}

const WIN: Os = Os::Windows;

// ---- web ---------------------------------------------------------------------------------------------------------

#[test]
fn a_vite_react_project_shows_its_scripts_with_the_right_package_manager() {
    let w = work();
    w.file("package.json", r#"{"scripts":{"dev":"vite","build":"vite build","test":"vitest","lint":"eslint .","format":"prettier -w .","postinstall":"x"},"dependencies":{"react":"19"},"devDependencies":{"vite":"6"}}"#)
        .file("vite.config.ts", "export default {}")
        .file("pnpm-lock.yaml", "")
        .dir("node_modules");
    let status = scan(&w, WIN, &["node", "pnpm"]);
    let p = project(&status, "");
    assert!(has(p, "node") && has(p, "react") && has(p, "vite"));
    assert_eq!(p.project.package_manager.as_deref(), Some("pnpm"));
    assert_eq!(p.title, "Vite + React");
    assert_eq!(line(p, "node.script.dev"), "pnpm run dev");
    assert_eq!(
        command(p, "node.script.dev").command.category,
        Category::Dev
    );
    assert_eq!(
        command(p, "node.script.build").command.category,
        Category::Build
    );
    assert_eq!(
        command(p, "node.script.test").command.category,
        Category::Test
    );
    assert_eq!(
        command(p, "node.script.lint").command.category,
        Category::Lint
    );
    assert_eq!(
        command(p, "node.script.format").command.category,
        Category::Format
    );
    no_command(p, "node.script.postinstall");
    no_command(p, "node.install");
    assert!(command(p, "node.script.dev").available);
    assert!(
        p.summary.contains("Detected Vite + React") && p.summary.contains("Dev: pnpm run dev"),
        "{}",
        p.summary
    );
}

#[test]
fn npm_yarn_and_declared_managers_and_a_missing_node_modules() {
    let w = work();
    w.file(
        "package.json",
        r#"{"scripts":{"start":"node ."},"packageManager":"yarn@4.1.0"}"#,
    );
    let p = &scan(&w, WIN, &["node", "yarn"]).projects[0];
    assert_eq!(p.project.package_manager.as_deref(), Some("yarn"));
    assert_eq!(line(p, "node.install"), "yarn install");
    assert!(command(p, "node.install").command.network);
    let plain = work();
    plain
        .file("package.json", r#"{"scripts":{"start":"node ."}}"#)
        .file("package-lock.json", "{}")
        .dir("node_modules");
    let status = scan(&plain, WIN, &["node", "npm"]);
    assert_eq!(
        status.projects[0].project.package_manager.as_deref(),
        Some("npm")
    );
    assert_eq!(
        line(&status.projects[0], "node.script.start"),
        "npm run start"
    );
}

#[test]
fn unsafe_script_names_are_never_turned_into_commands() {
    let w = work();
    w.file(
        "package.json",
        r#"{"scripts":{"dev":"vite","build; rm -rf /":"x","test":"jest"}}"#,
    )
    .dir("node_modules");
    let status = scan(&w, WIN, &["node", "npm"]);
    let names: Vec<&str> = status.projects[0]
        .command_status
        .iter()
        .map(|c| c.command.id.as_str())
        .collect();
    assert_eq!(names, ["node.script.dev", "node.script.test"]);
}

#[test]
fn next_vue_svelte_astro_and_tailwind_are_detected_from_config_or_dependencies() {
    for (config, dep, id, name) in [
        ("next.config.mjs", "next", "next", "Next.js"),
        ("astro.config.mjs", "astro", "astro", "Astro"),
        ("svelte.config.js", "svelte", "svelte", "Svelte"),
        (
            "tailwind.config.js",
            "tailwindcss",
            "tailwind",
            "Tailwind CSS",
        ),
    ] {
        let by_config = work();
        by_config.file("package.json", "{}").file(config, "");
        let p = &scan(&by_config, WIN, &[]).projects[0];
        assert!(has(p, id), "{config}");
        assert_eq!(
            p.project
                .detections
                .iter()
                .find(|d| d.id == id)
                .map(|d| d.name.as_str()),
            Some(name)
        );
        let by_dep = work();
        by_dep.file(
            "package.json",
            &format!(r#"{{"dependencies":{{"{dep}":"1"}}}}"#),
        );
        assert!(has(&scan(&by_dep, WIN, &[]).projects[0], id), "{dep}");
    }
    let vue = work();
    vue.file("package.json", r#"{"dependencies":{"vue":"3"}}"#);
    assert!(has(&scan(&vue, WIN, &[]).projects[0], "vue"));
}

#[test]
fn express_and_nest_backends() {
    let w = work();
    w.file("package.json", r#"{"dependencies":{"express":"4"}}"#);
    assert!(has(&scan(&w, WIN, &[]).projects[0], "express"));
    let nest = work();
    nest.file("package.json", "{}").file("nest-cli.json", "{}");
    let status = scan(&nest, WIN, &[]);
    let d = status.projects[0]
        .project
        .detections
        .iter()
        .find(|d| d.id == "nestjs")
        .expect("nest");
    assert_eq!(d.confidence, openmind_language::Confidence::High);
}

#[test]
fn a_bare_index_html_is_a_low_confidence_static_page_with_no_commands() {
    let w = work();
    w.file("index.html", "<html></html>");
    let p = &scan(&w, WIN, &[]).projects[0];
    assert!(has(p, "web-static"));
    assert!(p.project.detections[0].confidence == openmind_language::Confidence::Low);
    assert!(p.command_status.is_empty());
}

#[test]
fn a_folder_with_no_project_markers_has_no_projects() {
    let w = work();
    w.file("notes.txt", "hello").file("src/readme.md", "# hi");
    assert!(scan(&w, WIN, &[]).projects.is_empty());
}

// ---- desktop -----------------------------------------------------------------------------------------------------

#[test]
fn tauri_with_a_react_frontend_uses_the_projects_tauri_script() {
    let w = work();
    w.file("package.json", r#"{"scripts":{"tauri":"tauri","dev":"vite"},"dependencies":{"react":"19","@tauri-apps/api":"2"},"devDependencies":{"@tauri-apps/cli":"2"}}"#)
        .file("src-tauri/tauri.conf.json", "{}")
        .file("src-tauri/Cargo.toml", "[package]\nname=\"app\"")
        .file("pnpm-lock.yaml", "")
        .dir("node_modules");
    let status = scan(&w, WIN, &["node", "pnpm", "cargo"]);
    assert_eq!(
        status.projects.len(),
        1,
        "src-tauri belongs to the Tauri project, not a second Rust one"
    );
    let p = project(&status, "");
    assert!(has(p, "tauri") && has(p, "react"));
    assert_eq!(p.title, "Tauri + React");
    assert_eq!(line(p, "tauri.dev"), "pnpm tauri dev");
    assert_eq!(line(p, "tauri.build"), "pnpm tauri build");
    assert!(command(p, "tauri.dev").available);
    assert!(
        p.summary.contains("Detected Tauri + React"),
        "{}",
        p.summary
    );
}

#[test]
fn tauri_with_npm_needs_run_and_without_cargo_the_command_says_why() {
    let w = work();
    w.file("package.json", r#"{"scripts":{"tauri":"tauri"}}"#)
        .file("src-tauri/tauri.conf.json", "{}")
        .dir("node_modules");
    let status = scan(&w, WIN, &["node", "npm"]);
    let p = project(&status, "");
    assert_eq!(line(p, "tauri.dev"), "npm run tauri dev");
    let c = command(p, "tauri.dev");
    assert!(!c.available);
    assert_eq!(c.missing, ["cargo"]);
    assert!(c
        .reason
        .as_deref()
        .unwrap_or("")
        .contains("Cargo not found"));
}

#[test]
fn a_tauri_project_without_a_node_side_offers_cargo_tauri() {
    let w = work();
    w.file("tauri.conf.json", "{}")
        .file("Cargo.toml", "[package]\nname=\"a\"");
    let status = scan(&w, WIN, &["cargo"]);
    let p = project(&status, "");
    assert!(has(p, "tauri") && has(p, "rust"));
    assert_eq!(line(p, "tauri.cargo.dev"), "cargo tauri dev");
    assert!(command(p, "tauri.cargo.dev")
        .command
        .note
        .as_deref()
        .unwrap_or("")
        .contains("tauri-cli"));
}

#[test]
fn electron_neutralino_and_ambiguity_free_detection() {
    let w = work();
    w.file(
        "package.json",
        r#"{"main":"main.js","dependencies":{},"devDependencies":{"electron":"30"}}"#,
    )
    .dir("node_modules");
    let status = scan(&w, WIN, &["node", "npm", "npx"]);
    let p = project(&status, "");
    let electron = p
        .project
        .detections
        .iter()
        .find(|d| d.id == "electron")
        .expect("electron");
    assert_eq!(electron.confidence, openmind_language::Confidence::High);
    assert_eq!(line(p, "electron.run"), "npx electron .");
    let scripted = work();
    scripted
        .file(
            "package.json",
            r#"{"scripts":{"start":"electron ."},"devDependencies":{"electron":"30"}}"#,
        )
        .dir("node_modules");
    no_command(
        &scan(&scripted, WIN, &["node", "npm"]).projects[0],
        "electron.run",
    );
    let neu = work();
    neu.file("neutralino.config.json", "{}")
        .file("package.json", "{}");
    assert!(has(&scan(&neu, WIN, &[]).projects[0], "neutralino"));
}

#[test]
fn flutter_desktop_and_mobile_with_the_sdk_missing() {
    let w = work();
    w.file(
        "pubspec.yaml",
        "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n",
    )
    .file("lib/main.dart", "")
    .dir("windows")
    .dir("android")
    .dir("web");
    let status = scan(&w, WIN, &[]);
    let p = project(&status, "");
    assert!(has(p, "flutter") && has(p, "flutter-desktop"));
    assert_eq!(line(p, "flutter.run"), "flutter run");
    assert!(!command(p, "flutter.run").available);
    assert!(command(p, "flutter.run")
        .reason
        .as_deref()
        .unwrap_or("")
        .contains("Flutter SDK not found"));
    assert_eq!(line(p, "flutter.build.windows"), "flutter build windows");
    assert_eq!(
        command(p, "flutter.build.apk").missing,
        ["flutter", "android-sdk"]
    );
    assert!(p
        .project
        .notes
        .iter()
        .any(|n| n.contains("emulators or devices")));
    // Not on Windows: the Windows build is unavailable for a platform reason even with Flutter present.
    let linux = scan(&w, Os::Linux, &["flutter", "dart"]);
    let c = command(project(&linux, ""), "flutter.build.windows");
    assert!(!c.available && c.reason.as_deref() == Some("A Windows build needs Windows."));
    assert!(command(project(&linux, ""), "flutter.run").available);
}

#[test]
fn a_dart_only_package() {
    let w = work();
    w.file("pubspec.yaml", "name: tool\nenvironment:\n  sdk: ^3.0.0\n");
    let p = &scan(&w, WIN, &["dart"]).projects[0];
    assert!(has(p, "dart") && !has(p, "flutter"));
    assert_eq!(line(p, "dart.test"), "dart test");
}

#[test]
fn dotnet_desktop_projects_and_platform_limits() {
    let w = work();
    w.file("App.sln", "").file("App.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><OutputType>WinExe</OutputType><UseWPF>true</UseWPF></PropertyGroup></Project>");
    let status = scan(&w, WIN, &["dotnet"]);
    let p = project(&status, "");
    assert!(has(p, "dotnet") && has(p, "wpf"));
    assert_eq!(line(p, "dotnet.run"), "dotnet run");
    assert!(command(p, "dotnet.run").available);
    assert_eq!(line(p, "dotnet.build"), "dotnet build");
    let linux = scan(&w, Os::Linux, &["dotnet"]);
    let run = command(project(&linux, ""), "dotnet.run");
    assert!(
        !run.available
            && run
                .reason
                .as_deref()
                .unwrap_or("")
                .contains("only on Windows")
    );
    let web = work();
    web.file(
        "Api.csproj",
        "<Project Sdk=\"Microsoft.NET.Sdk.Web\"></Project>",
    );
    let p = &scan(&web, WIN, &["dotnet"]).projects[0];
    assert!(has(p, "aspnet"));
    assert!(p
        .command_status
        .iter()
        .any(|c| c.command.id == "dotnet.run"));
    let lib = work();
    lib.file(
        "Lib.csproj",
        "<Project Sdk=\"Microsoft.NET.Sdk\"></Project>",
    );
    no_command(&scan(&lib, WIN, &["dotnet"]).projects[0], "dotnet.run");
}

#[test]
fn javafx_is_a_desktop_hint() {
    let w = work();
    w.file(
        "pom.xml",
        "<project><dependency><artifactId>javafx-controls</artifactId></dependency></project>",
    );
    let p = &scan(&w, WIN, &["java", "mvn"]).projects[0];
    assert!(has(p, "maven") && has(p, "javafx"));
}

// ---- backend -----------------------------------------------------------------------------------------------------

#[test]
fn laravel_with_its_frontend() {
    let w = work();
    w.file(
        "composer.json",
        r#"{"require":{"laravel/framework":"^11"}}"#,
    )
    .file("artisan", "#!/usr/bin/env php")
    .file(
        "package.json",
        r#"{"scripts":{"dev":"vite","build":"vite build"}}"#,
    )
    .file("routes/web.php", "<?php");
    let status = scan(&w, WIN, &["php", "composer", "node", "npm"]);
    let p = project(&status, "");
    assert!(has(p, "laravel") && has(p, "php") && has(p, "node"));
    assert_eq!(p.title, "Laravel");
    assert_eq!(line(p, "laravel.serve"), "php artisan serve");
    assert_eq!(line(p, "laravel.test"), "php artisan test");
    assert_eq!(line(p, "composer.install"), "composer install");
    assert!(command(p, "composer.install").command.network);
    assert_eq!(line(p, "node.script.dev"), "npm run dev");
    assert!(p.project.notes.iter().any(|n| n.contains(".env")));
    let installed = work();
    installed
        .file(
            "composer.json",
            r#"{"require":{"laravel/framework":"^11"}}"#,
        )
        .file("artisan", "")
        .dir("vendor")
        .file(".env", "");
    let p = &scan(&installed, WIN, &["php"]).projects[0];
    no_command(p, "composer.install");
}

#[test]
fn python_django_fastapi_flask_and_ambiguity() {
    let django = work();
    django
        .file("manage.py", "")
        .file("requirements.txt", "django\npytest\n");
    let status = scan(&django, WIN, &["python", "pytest"]);
    let p = project(&status, "");
    assert!(has(p, "python") && has(p, "django"));
    assert_eq!(line(p, "django.run"), "python manage.py runserver");
    assert_eq!(line(p, "django.test"), "python manage.py test");
    assert_eq!(line(p, "python.pytest"), "pytest");
    assert_eq!(
        line(p, "python.install"),
        "python -m pip install -r requirements.txt"
    );
    assert!(!p.project.ambiguous);

    let fast = work();
    fast.file("requirements.txt", "fastapi\nuvicorn\n")
        .file("main.py", "from fastapi import FastAPI\napp = FastAPI()\n");
    let status = scan(&fast, WIN, &["python"]);
    let p = project(&status, "");
    assert!(has(p, "fastapi"));
    assert_eq!(line(p, "fastapi.run"), "uvicorn main:app --reload");
    assert!(!command(p, "fastapi.run").available);
    assert_eq!(command(p, "fastapi.run").missing, ["uvicorn"]);

    let flask = work();
    flask.file("requirements.txt", "flask\n").file("app.py", "");
    assert_eq!(
        line(
            &scan(&flask, WIN, &["flask", "python"]).projects[0],
            "flask.run"
        ),
        "flask run"
    );

    let plain = work();
    plain
        .file("main.py", "print(1)")
        .file("pyproject.toml", "[project]\nname='x'\n");
    assert_eq!(
        line(&scan(&plain, WIN, &["python"]).projects[0], "python.run"),
        "python main.py"
    );

    // Two frameworks mentioned and no manage.py: every candidate is listed and the project is ambiguous.
    let both = work();
    both.file("requirements.txt", "fastapi\nflask\n");
    let status = scan(&both, WIN, &[]);
    let p = project(&status, "");
    assert!(p.project.ambiguous && has(p, "fastapi") && has(p, "flask"));
    assert!(p
        .project
        .notes
        .iter()
        .any(|n| n.contains("More than one Python web framework")));
    no_command(p, "fastapi.run");
    no_command(p, "flask.run");
}

#[test]
fn rust_go_and_their_commands() {
    let rust = work();
    rust.file("Cargo.toml", "[package]\nname=\"a\"")
        .file("src/main.rs", "fn main(){}");
    let status = scan(&rust, WIN, &["cargo", "rustfmt"]);
    let p = project(&status, "");
    for (id, expected) in [
        ("cargo.run", "cargo run"),
        ("cargo.build", "cargo build"),
        ("cargo.test", "cargo test"),
        ("cargo.clippy", "cargo clippy"),
        ("cargo.fmt", "cargo fmt"),
    ] {
        assert_eq!(line(p, id), expected);
    }
    assert!(command(p, "cargo.run").available);
    let lib = work();
    lib.file("Cargo.toml", "[package]\nname=\"a\"")
        .file("src/lib.rs", "");
    no_command(&scan(&lib, WIN, &["cargo"]).projects[0], "cargo.run");

    let go = work();
    go.file("go.mod", "module x")
        .file("main.go", "package main");
    let status = scan(&go, WIN, &["go"]);
    let p = project(&status, "");
    assert_eq!(line(p, "go.run"), "go run .");
    assert_eq!(line(p, "go.build"), "go build ./...");
    assert_eq!(line(p, "go.test"), "go test ./...");
    assert!(
        !command(p, "go.fmt").available,
        "gofmt is a separate tool that wasn't found"
    );
}

#[test]
fn java_maven_gradle_spring_and_wrappers() {
    let mvn = work();
    mvn.file(
        "pom.xml",
        "<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent></project>",
    );
    let status = scan(&mvn, WIN, &["java"]);
    let p = project(&status, "");
    assert!(has(p, "maven") && has(p, "spring"));
    assert_eq!(line(p, "maven.run"), "mvn spring-boot:run");
    assert!(!command(p, "maven.run").available, "no mvn and no wrapper");
    let wrapped = work();
    wrapped.file("pom.xml", "<project/>").file("mvnw.cmd", "");
    let status = scan(&wrapped, WIN, &["java"]);
    let p = project(&status, "");
    assert_eq!(line(p, "maven.test"), ".\\mvnw.cmd test");
    assert!(command(p, "maven.test").available);
    no_command(p, "maven.run");

    let gradle = work();
    gradle
        .file("build.gradle", "plugins { id 'org.springframework.boot' }")
        .file("gradlew", "");
    let status = scan(&gradle, Os::Linux, &["java"]);
    let p = project(&status, "");
    assert!(has(p, "gradle") && has(p, "spring"));
    assert_eq!(line(p, "gradle.run"), "./gradlew bootRun");
    assert_eq!(line(p, "gradle.test"), "./gradlew test");
}

#[test]
fn ruby_and_rails() {
    let w = work();
    w.file("Gemfile", "gem 'rails'")
        .file("config/application.rb", "");
    let status = scan(&w, WIN, &["ruby", "bundle"]);
    let p = project(&status, "");
    assert!(has(p, "ruby") && has(p, "rails"));
    assert_eq!(line(p, "rails.server"), "bundle exec rails server");
}

// ---- mobile ------------------------------------------------------------------------------------------------------

#[test]
fn react_native_and_expo_do_not_pull_in_their_platform_folders_as_projects() {
    let rn = work();
    rn.file("package.json", r#"{"scripts":{"start":"react-native start","android":"react-native run-android","ios":"react-native run-ios"},"dependencies":{"react-native":"0.76"}}"#)
        .file("android/settings.gradle", "")
        .file("android/app/src/main/AndroidManifest.xml", "<manifest/>")
        .file("ios/Podfile", "")
        .dir("node_modules");
    let status = scan(&rn, WIN, &["node", "npm"]);
    assert_eq!(status.projects.len(), 1);
    let p = project(&status, "");
    assert!(has(p, "react-native"));
    assert_eq!(line(p, "node.script.android"), "npm run android");
    assert!(!command(p, "node.script.android").available);
    assert!(command(p, "node.script.android")
        .missing
        .contains(&"android-sdk".to_string()));
    let ios = command(p, "node.script.ios");
    assert!(!ios.available);
    assert_eq!(
        ios.reason.as_deref(),
        Some("iOS builds require macOS and Xcode.")
    );
    assert!(p
        .project
        .notes
        .iter()
        .any(|n| n.contains("iOS builds require macOS")));
    let mac = scan(&rn, Os::MacOs, &["node", "npm"]);
    assert!(command(project(&mac, ""), "node.script.ios").available);

    let expo = work();
    expo.file("package.json", r#"{"dependencies":{"expo":"52"}}"#)
        .file("app.json", r#"{"expo":{"name":"x"}}"#)
        .dir("node_modules");
    let status = scan(&expo, WIN, &["node", "npm", "npx"]);
    let p = project(&status, "");
    assert!(has(p, "expo"));
    assert_eq!(line(p, "expo.start"), "npx expo start");
}

#[test]
fn android_gradle_projects_need_the_jdk_and_the_sdk() {
    let w = work();
    w.file("settings.gradle", "include ':app'")
        .file("build.gradle", "")
        .file(
            "app/build.gradle",
            "plugins { id 'com.android.application' }",
        )
        .file("app/src/main/AndroidManifest.xml", "<manifest/>")
        .file("gradlew.bat", "");
    let status = scan(&w, WIN, &[]);
    let p = project(&status, "");
    assert!(has(p, "android"));
    assert_eq!(line(p, "gradle.assemble"), ".\\gradlew.bat assembleDebug");
    assert_eq!(line(p, "gradle.test"), ".\\gradlew.bat test");
    let c = command(p, "gradle.assemble");
    assert!(!c.available);
    assert_eq!(c.missing, ["java", "android-sdk"]);
    assert!(c
        .reason
        .as_deref()
        .unwrap_or("")
        .contains("Java (JDK/JRE), Android SDK not found"));
    assert!(p
        .project
        .notes
        .iter()
        .any(|n| n.contains("emulators or devices")));
    // The `app` module belongs to the Android project; it is not a second one.
    assert_eq!(status.projects.len(), 1);
}

#[test]
fn ionic_and_capacitor_and_ios_projects() {
    let w = work();
    w.file("package.json", r#"{"scripts":{"build":"ionic build"}}"#)
        .file("ionic.config.json", "{}")
        .file("capacitor.config.ts", "");
    let p = &scan(&w, WIN, &[]).projects[0];
    assert!(has(p, "ionic") && has(p, "capacitor"));
    let ios = work();
    ios.file("Podfile", "");
    let status = scan(&ios, WIN, &[]);
    let p = project(&status, "");
    assert!(has(p, "ios"));
    let c = command(p, "ios.list");
    assert!(!c.available && c.reason.as_deref() == Some("iOS builds require macOS and Xcode."));
    let mac = scan(&ios, Os::MacOs, &["xcodebuild"]);
    assert!(command(project(&mac, ""), "ios.list").available);
}

// ---- systems / devops ---------------------------------------------------------------------------------------------

#[test]
fn cmake_make_docker_and_prisma() {
    let cmake = work();
    cmake
        .file("CMakeLists.txt", "project(x)")
        .file("main.cpp", "");
    let status = scan(&cmake, WIN, &["cmake"]);
    let p = project(&status, "");
    assert_eq!(line(p, "cmake.configure"), "cmake -S . -B build");
    assert_eq!(line(p, "cmake.build"), "cmake --build build");
    let make = work();
    make.file("Makefile", "all:");
    assert_eq!(
        line(&scan(&make, WIN, &[]).projects[0], "make.build"),
        "make"
    );

    let docker = work();
    docker
        .file("Dockerfile", "FROM scratch")
        .file("docker-compose.yml", "services: {}");
    let status = scan(&docker, WIN, &["docker"]);
    let p = project(&status, "");
    assert!(has(p, "docker") && has(p, "docker-compose"));
    assert_eq!(line(p, "compose.up"), "docker compose up");
    assert!(command(p, "compose.up").command.network);
    let only = work();
    only.file("Dockerfile", "FROM scratch");
    assert_eq!(
        line(&scan(&only, WIN, &[]).projects[0], "docker.build"),
        "docker build ."
    );

    let prisma = work();
    prisma
        .file("package.json", r#"{"dependencies":{"@prisma/client":"5"}}"#)
        .file("prisma/schema.prisma", "");
    let status = scan(&prisma, WIN, &["node", "npx"]);
    let p = project(&status, "");
    assert!(has(p, "prisma"));
    assert_eq!(line(p, "prisma.validate"), "npx prisma validate");
}

#[test]
fn jupyter_is_detected_only() {
    let w = work();
    w.file("analysis.ipynb", "{}");
    let status = scan(&w, WIN, &[]);
    let p = project(&status, "");
    assert!(has(p, "jupyter"));
    assert!(p.command_status.is_empty());
    assert!(p
        .project
        .notes
        .iter()
        .any(|n| n.contains("no notebook editor")));
}

// ---- layout ------------------------------------------------------------------------------------------------------

#[test]
fn monorepos_list_each_project_with_its_own_root_and_ignored_folders_are_skipped() {
    let w = work();
    w.file("apps/web/package.json", r#"{"dependencies":{"next":"15"}}"#)
        .file("apps/api/go.mod", "module api")
        .file("services/py/manage.py", "")
        .file("node_modules/pkg/package.json", "{}")
        .file("target/debug/Cargo.toml", "")
        .file("vendor/lib/composer.json", "{}")
        .file(".git/config", "");
    let status = scan(&w, WIN, &[]);
    let roots: Vec<&str> = status
        .projects
        .iter()
        .map(|p| p.project.root.as_str())
        .collect();
    assert_eq!(roots, ["apps/api", "apps/web", "services/py"]);
    assert_eq!(project(&status, "apps/web").project.name, "web");
    assert!(
        command(project(&status, "apps/api"), "go.build")
            .command
            .cwd
            == "apps/api"
    );
}

#[test]
fn projects_deeper_than_two_levels_are_not_scanned() {
    let w = work();
    w.file("a/b/c/go.mod", "module deep");
    assert!(scan(&w, WIN, &[]).projects.is_empty());
}

#[test]
fn links_are_never_followed() {
    let outside = tempfile::tempdir().expect("outside");
    fs::write(outside.path().join("go.mod"), "module x").expect("mod");
    let w = work();
    w.file("keep.txt", "x");
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_dir(outside.path(), w.root.join("link")).is_ok();
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(outside.path(), w.root.join("link")).is_ok();
    if !linked {
        return; // this machine can't make links; nothing to check
    }
    assert!(scan(&w, WIN, &[]).projects.is_empty());
}

#[test]
fn a_project_that_is_project_local_finds_its_own_tools_first() {
    let w = work();
    w.file("package.json", r#"{"scripts":{"lint":"eslint ."}}"#)
        .file("node_modules/.bin/eslint.cmd", "")
        .dir("node_modules");
    let (_bin, base) = env(WIN, &["node", "npm"]);
    let status = workspace_status(&w.root, &base);
    let p = project(&status, "");
    assert!(command(p, "node.script.lint").available);
    let tools: Vec<&str> = p.tool_status.iter().map(|t| t.id.as_str()).collect();
    assert!(tools.contains(&"node") && tools.contains(&"npm"));
}

#[test]
fn the_general_tool_list_always_covers_the_common_toolchains() {
    let w = work();
    let status = scan(&w, WIN, &["node", "python"]);
    let ids: Vec<&str> = status.tools.iter().map(|t| t.id.as_str()).collect();
    for expected in [
        "node",
        "npm",
        "pnpm",
        "yarn",
        "python",
        "php",
        "composer",
        "cargo",
        "go",
        "java",
        "dotnet",
        "flutter",
        "adb",
        "ruby",
        "docker",
        "powershell",
        "bash",
    ] {
        assert!(ids.contains(&expected), "{expected}");
    }
    assert!(status
        .tools
        .iter()
        .find(|t| t.id == "node")
        .expect("node")
        .found
        .is_some());
    assert!(status
        .tools
        .iter()
        .find(|t| t.id == "cargo")
        .expect("cargo")
        .found
        .is_none());
}

#[test]
fn scanning_changes_nothing_on_disk_and_never_touches_the_path_variable() {
    let before = std::env::var_os("PATH");
    let w = work();
    w.file("package.json", "{}").file("go.mod", "module x");
    let snapshot: Vec<_> = fs::read_dir(&w.root)
        .expect("dir")
        .map(|e| e.expect("entry").file_name())
        .collect();
    let _ = scan(&w, WIN, &["node"]);
    let after: Vec<_> = fs::read_dir(&w.root)
        .expect("dir")
        .map(|e| e.expect("entry").file_name())
        .collect();
    assert_eq!(snapshot.len(), after.len());
    assert_eq!(before, std::env::var_os("PATH"));
    let _ = Path::new("");
}
