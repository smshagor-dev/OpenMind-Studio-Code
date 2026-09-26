//! Desktop shells with their own config (Tauri), Flutter, Android, iOS, C/C++, containers, databases.

use crate::project::{
    det,
    Confidence::{High, Low, Medium},
    Detection, Dir,
    StackGroup::{Data, Desktop, Devops, Mobile, Systems},
};

pub fn detect(dir: &Dir) -> Vec<Detection> {
    let mut out = Vec::new();
    tauri(&mut out, dir);
    flutter(&mut out, dir);
    android(&mut out, dir);
    ios(&mut out, dir);
    systems(&mut out, dir);
    devops(&mut out, dir);
    out
}

fn tauri(out: &mut Vec<Detection>, dir: &Dir) {
    let child = dir.path.join("src-tauri").join("tauri.conf.json").is_file()
        || dir
            .path
            .join("src-tauri")
            .join("tauri.conf.json5")
            .is_file();
    if child {
        out.push(det(
            "tauri",
            "Tauri",
            Desktop,
            High,
            "src-tauri/tauri.conf.json",
        ));
    } else if dir.has("tauri.conf.json") {
        out.push(det("tauri", "Tauri", Desktop, High, "tauri.conf.json"));
    } else if dir.dep("@tauri-apps/cli") || dir.dep("@tauri-apps/api") {
        out.push(det(
            "tauri",
            "Tauri",
            Desktop,
            Medium,
            "package.json depends on @tauri-apps",
        ));
    }
}

fn flutter(out: &mut Vec<Detection>, dir: &Dir) {
    let Some(pubspec) = dir.read("pubspec.yaml") else {
        return;
    };
    if Dir::mentions(&pubspec, "flutter") {
        out.push(det(
            "flutter",
            "Flutter",
            Mobile,
            High,
            "pubspec.yaml depends on flutter",
        ));
        let targets: Vec<&str> = ["windows", "linux", "macos"]
            .into_iter()
            .filter(|t| dir.is_dir(t))
            .collect();
        if !targets.is_empty() {
            out.push(det(
                "flutter-desktop",
                "Flutter desktop",
                Desktop,
                Medium,
                format!("desktop folders: {}", targets.join(", ")),
            ));
        }
    } else {
        out.push(det("dart", "Dart", Systems, High, "pubspec.yaml"));
    }
}

fn android(out: &mut Vec<Detection>, dir: &Dir) {
    let settings = dir.has("settings.gradle") || dir.has("settings.gradle.kts");
    let manifest = dir
        .path
        .join("app")
        .join("src")
        .join("main")
        .join("AndroidManifest.xml")
        .is_file()
        || dir
            .path
            .join("src")
            .join("main")
            .join("AndroidManifest.xml")
            .is_file();
    let plugin = ["build.gradle", "build.gradle.kts"]
        .iter()
        .filter_map(|name| dir.read(name))
        .any(|text| Dir::mentions(&text, "com.android."));
    if (settings && manifest) || (settings && plugin) {
        out.push(det(
            "android",
            "Android (Gradle)",
            Mobile,
            High,
            "settings.gradle and an Android manifest or plugin",
        ));
    } else if manifest || plugin {
        out.push(det(
            "android",
            "Android (Gradle)",
            Mobile,
            Medium,
            "an Android manifest or plugin",
        ));
    }
}

fn ios(out: &mut Vec<Detection>, dir: &Dir) {
    if dir.has("Podfile") {
        out.push(det("ios", "iOS (CocoaPods)", Mobile, Medium, "Podfile"));
    } else if let Some(project) = dir
        .find("", ".xcodeproj")
        .or_else(|| dir.find("", ".xcworkspace"))
    {
        out.push(det(
            "ios",
            "iOS / macOS (Xcode)",
            Mobile,
            Medium,
            project.to_string(),
        ));
    }
    if dir.has("Package.swift") {
        out.push(det(
            "swift-package",
            "Swift package",
            Mobile,
            High,
            "Package.swift",
        ));
    }
}

fn systems(out: &mut Vec<Detection>, dir: &Dir) {
    if dir.has("CMakeLists.txt") {
        out.push(det(
            "cmake",
            "CMake (C/C++)",
            Systems,
            High,
            "CMakeLists.txt",
        ));
    } else if dir.has_any(&["Makefile", "GNUmakefile"]) {
        out.push(det("make", "Make", Systems, Medium, "Makefile"));
    }
}

fn devops(out: &mut Vec<Detection>, dir: &Dir) {
    let compose = [
        "docker-compose.yml",
        "docker-compose.yaml",
        "compose.yml",
        "compose.yaml",
    ];
    if let Some(file) = compose.iter().find(|name| dir.has(name)) {
        out.push(det("docker-compose", "Docker Compose", Devops, High, *file));
    }
    if dir.has_any(&["Dockerfile", "Containerfile"]) {
        out.push(det("docker", "Docker", Devops, High, "Dockerfile"));
    }
    let prisma =
        dir.path.join("prisma").join("schema.prisma").is_file() || dir.has("schema.prisma");
    if prisma {
        out.push(det("prisma", "Prisma", Data, High, "schema.prisma"));
    }
    if let Some(notebook) = dir.find("", ".ipynb") {
        out.push(det(
            "jupyter",
            "Jupyter notebooks",
            Data,
            Low,
            format!("{notebook} (detected only; there is no notebook editor)"),
        ));
    }
}
