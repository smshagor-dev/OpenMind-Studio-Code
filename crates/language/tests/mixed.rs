//! A workspace holding many stacks side by side (the way a real monorepo or a scratch folder looks): projects must be
//! found without duplicates, and each one's commands, tools and files must stay its own.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use openmind_language::{
    file_status, workspace_status, Os, ProjectStatus, ToolEnv, WorkspaceStatus,
};

struct Work {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

impl Work {
    fn file(&self, relative: &str, text: &str) {
        let path = self.root.join(relative);
        fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
        fs::write(path, text).expect("file");
    }
}

const PKG_VITE: &str = r#"{"scripts":{"dev":"vite","build":"vite build","test":"vitest"},"dependencies":{"react":"19.0.0"},"devDependencies":{"vite":"6.0.0"}}"#;

fn workspace() -> Work {
    let dir = tempfile::tempdir().expect("tmp");
    let root = dir.path().join("multi language workspace");
    fs::create_dir_all(&root).expect("root");
    let w = Work { _dir: dir, root };
    w.file("plain-web/index.html", "<!doctype html>");
    w.file("plain-web/styles.css", "a{}");
    w.file("plain-web/app.js", "1");
    w.file("plain-web/data.json", "{}");
    w.file("react-vite-app/package.json", PKG_VITE);
    w.file("react-vite-app/vite.config.ts", "export default {}");
    w.file("react-vite-app/src/App.tsx", "export {}");
    w.file("react-vite-app/src/App.css", "a{}");
    w.file("python-json-app/main.py", "print(1)");
    w.file("python-json-app/config.json", "{}");
    w.file("python-json-app/requirements.txt", "requests\n");
    w.file("python-cpp-bridge/main.py", "print(1)");
    w.file("python-cpp-bridge/native.cpp", "int f(){return 1;}");
    w.file("python-cpp-bridge/CMakeLists.txt", "project(n)\n");
    w.file(
        "tauri-mixed/package.json",
        r#"{"scripts":{"tauri":"tauri"},"devDependencies":{"@tauri-apps/cli":"2.0.0"}}"#,
    );
    w.file(
        "tauri-mixed/src-tauri/Cargo.toml",
        "[package]\nname=\"t\"\n",
    );
    w.file("tauri-mixed/src-tauri/tauri.conf.json", "{}");
    w.file("tauri-mixed/src-tauri/src/main.rs", "fn main(){}");
    w.file("tauri-mixed/src/main.ts", "1");
    w.file(
        "laravel-mixed/composer.json",
        r#"{"require":{"laravel/framework":"^11"}}"#,
    );
    w.file("laravel-mixed/artisan", "<?php");
    w.file("laravel-mixed/routes/web.php", "<?php");
    w.file(
        "laravel-mixed/package.json",
        r#"{"scripts":{"dev":"vite","build":"vite build"}}"#,
    );
    w.file("rust-json-sql/Cargo.toml", "[package]\nname=\"r\"\n");
    w.file("rust-json-sql/src/main.rs", "fn main(){}");
    w.file("rust-json-sql/schema.sql", "select 1;");
    w.file("docker-backend/Dockerfile", "FROM scratch");
    w.file("docker-backend/docker-compose.yml", "services: {}");
    w.file("docker-backend/go.mod", "module d\n");
    w.file("docker-backend/Dockerfile", "FROM scratch");
    w.file(
        "mobile-mixed/pubspec.yaml",
        "name: m\ndependencies:\n  flutter:\n    sdk: flutter\n",
    );
    w.file("mobile-mixed/lib/main.dart", "void main(){}");
    w.file("mobile-mixed/android/build.gradle", "");
    w.file("mobile-mixed/android/settings.gradle", "include ':app'");
    w.file(
        "mobile-mixed/android/app/build.gradle",
        "plugins { id 'com.android.application' }",
    );
    w.file("mobile-mixed/ios/Podfile", "");
    w
}

fn env(tools: &[&str]) -> (tempfile::TempDir, ToolEnv) {
    let bin = tempfile::tempdir().expect("bin");
    for t in tools {
        fs::write(bin.path().join(format!("{t}.exe")), "").expect("tool");
    }
    let env = ToolEnv {
        os: Os::Windows,
        project_dirs: vec![],
        bundled_dirs: vec![],
        portable_dirs: vec![],
        system_dirs: vec![bin.path().to_path_buf()],
        pathext: vec![".exe".into()],
        vars: HashMap::new(),
    };
    (bin, env)
}

fn scan(w: &Work, tools: &[&str]) -> (tempfile::TempDir, ToolEnv, WorkspaceStatus) {
    let (bin, env) = env(tools);
    let status = workspace_status(&w.root, &env);
    (bin, env, status)
}

fn roots(s: &WorkspaceStatus) -> Vec<&str> {
    s.projects.iter().map(|p| p.project.root.as_str()).collect()
}

fn at<'a>(s: &'a WorkspaceStatus, root: &str) -> &'a ProjectStatus {
    s.projects
        .iter()
        .find(|p| p.project.root == root)
        .unwrap_or_else(|| panic!("no project at {root}: {:?}", roots(s)))
}

fn snapshot(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in fs::read_dir(&d).expect("ls").flatten() {
            let p = e.path();
            out.push(p.to_string_lossy().to_string());
            if p.is_dir() {
                stack.push(p);
            }
        }
    }
    out.sort();
    out
}

fn lines(p: &ProjectStatus) -> Vec<String> {
    p.command_status
        .iter()
        .map(|c| c.command.argv.join(" "))
        .collect()
}

#[test]
fn every_stack_is_found_once_and_nothing_is_invented() {
    let w = workspace();
    let before = snapshot(&w.root);
    let (_bin, _env, s) = scan(
        &w,
        &["node", "npm", "python", "cmake", "cargo", "go", "php"],
    );
    assert_eq!(snapshot(&w.root), before, "a scan writes nothing");
    let mut found = roots(&s);
    found.sort_unstable();
    assert_eq!(
        found,
        [
            "docker-backend",
            "laravel-mixed",
            "mobile-mixed",
            "plain-web",
            "python-cpp-bridge",
            "python-json-app",
            "react-vite-app",
            "rust-json-sql",
            "tauri-mixed",
        ],
        "the Android module and src-tauri are not separate projects"
    );
}

#[test]
fn detections_and_commands_stay_with_their_own_project() {
    let w = workspace();
    let tools = [
        "node", "npm", "python", "cmake", "cargo", "go", "php", "docker",
    ];
    let (_bin, _env, s) = scan(&w, &tools);

    let vite = at(&s, "react-vite-app");
    assert!(vite.project.has("vite") && vite.project.has("react"));
    assert!(!vite.project.has("tauri") && !vite.project.has("laravel"));
    assert!(lines(vite).contains(&"npm run dev".to_string()));

    let tauri = at(&s, "tauri-mixed");
    assert!(tauri.project.has("tauri"));
    assert!(lines(tauri).contains(&"npm run tauri dev".to_string()));
    assert!(!lines(tauri).iter().any(|l| l == "npm tauri dev"));

    let py = at(&s, "python-cpp-bridge");
    assert!(py.project.has("cmake"), "{:?}", py.project.detections);
    assert!(lines(py).iter().any(|l| l.starts_with("cmake")));
    // A script folder with no manifest is still Python, and its run command sits beside the CMake ones.
    assert!(py.project.has("python"), "{:?}", py.project.detections);
    assert!(lines(py).contains(&"python main.py".to_string()));
    assert!(lines(py).iter().any(|l| l.starts_with("cmake --build")));
    let json_only = at(&s, "python-json-app");
    assert!(!json_only.project.has("cmake"));
    assert!(!lines(json_only).iter().any(|l| l.starts_with("cmake")));

    let docker = at(&s, "docker-backend");
    assert!(docker.project.has("go") && docker.project.has("docker"));
    assert!(lines(docker).iter().any(|l| l.starts_with("go ")));
    assert!(lines(docker)
        .iter()
        .any(|l| l.starts_with("docker compose")));

    let laravel = at(&s, "laravel-mixed");
    assert!(laravel.project.has("laravel"));
    assert!(lines(laravel).contains(&"npm run dev".to_string()));
    assert!(lines(laravel).contains(&"php artisan serve".to_string()));

    assert!(at(&s, "mobile-mixed").project.has("flutter"));
    assert!(!roots(&s).iter().any(|r| r.ends_with("/android")));
}

#[test]
fn a_missing_tool_disables_only_the_projects_that_need_it() {
    let w = workspace();
    // No Docker, no cmake, no Go; Node, Python and Cargo exist.
    let (_bin, _env, s) = scan(&w, &["node", "npm", "python", "cargo"]);
    let docker = at(&s, "docker-backend");
    let compose = docker
        .command_status
        .iter()
        .find(|c| c.command.argv.first().is_some_and(|a| a == "docker"))
        .expect("compose command");
    assert!(!compose.available);
    assert!(compose
        .reason
        .as_deref()
        .unwrap_or("")
        .contains("not found"));
    let rust = at(&s, "rust-json-sql");
    for id in ["cargo run", "cargo build", "cargo test"] {
        assert!(
            rust.command_status
                .iter()
                .any(|c| c.command.argv.join(" ") == id && c.available),
            "{id}"
        );
    }
    assert!(at(&s, "react-vite-app")
        .command_status
        .iter()
        .any(|c| c.available));
}

#[test]
fn a_file_belongs_to_the_nearest_project_and_keeps_its_own_language() {
    let w = workspace();
    let (_bin, env, s) = scan(&w, &["node", "npm", "python", "cargo"]);
    let check = |rel: &str, lang: &str, root: Option<&str>| {
        let f = file_status(&w.root, &w.root.join(rel), &env, &s);
        assert_eq!(f.language.map(|l| l.id), Some(lang), "{rel}");
        assert_eq!(f.project_root.as_deref(), root, "{rel}");
    };
    check(
        "python-json-app/config.json",
        "json",
        Some("python-json-app"),
    );
    check("python-json-app/main.py", "python", Some("python-json-app"));
    check(
        "python-cpp-bridge/native.cpp",
        "cpp",
        Some("python-cpp-bridge"),
    );
    check(
        "react-vite-app/src/App.tsx",
        "typescriptreact",
        Some("react-vite-app"),
    );
    check("react-vite-app/src/App.css", "css", Some("react-vite-app"));
    check(
        "tauri-mixed/src-tauri/src/main.rs",
        "rust",
        Some("tauri-mixed"),
    );
    check("tauri-mixed/src/main.ts", "typescript", Some("tauri-mixed"));
    check("laravel-mixed/routes/web.php", "php", Some("laravel-mixed"));
    check("rust-json-sql/schema.sql", "sql", Some("rust-json-sql"));
    check(
        "docker-backend/Dockerfile",
        "dockerfile",
        Some("docker-backend"),
    );
    check(
        "docker-backend/docker-compose.yml",
        "dockercompose",
        Some("docker-backend"),
    );
    check("mobile-mixed/lib/main.dart", "dart", Some("mobile-mixed"));
    check("plain-web/index.html", "html", Some("plain-web"));
    check("plain-web/app.js", "javascript", Some("plain-web"));
    let web = at(&s, "plain-web");
    assert!(!web.project.has("node") && web.project.package_manager.is_none());
}
