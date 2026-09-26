//! Node.js, front-end frameworks and the desktop/mobile shells that are built on them.

use serde_json::Value;

use crate::project::{
    det,
    Confidence::{High, Low, Medium},
    Detection, Dir,
    StackGroup::{Backend, Desktop, Mobile, Web},
};

/// A dependency-or-config rule: a config file is definitive, a dependency is likely.
fn framework(
    out: &mut Vec<Detection>,
    dir: &Dir,
    id: &str,
    name: &str,
    group: crate::project::StackGroup,
    config: Option<&str>,
    dep: &str,
) {
    if let Some(file) = config.and_then(|stem| dir.config(stem)) {
        out.push(det(id, name, group, High, format!("{file} exists")));
    } else if dir.dep(dep) {
        out.push(det(
            id,
            name,
            group,
            Medium,
            format!("package.json depends on {dep}"),
        ));
    }
}

pub fn detect(dir: &Dir) -> Vec<Detection> {
    let mut out = Vec::new();
    if dir.has("package.json") {
        out.push(det("node", "Node.js", Backend, High, "package.json"));
        node_frameworks(&mut out, dir);
        shells(&mut out, dir);
    } else if dir.has("index.html") {
        out.push(det("web-static", "Static web page", Web, Low, "index.html"));
    }
    out
}

fn node_frameworks(out: &mut Vec<Detection>, dir: &Dir) {
    framework(out, dir, "react", "React", Web, None, "react");
    framework(
        out,
        dir,
        "next",
        "Next.js",
        Web,
        Some("next.config"),
        "next",
    );
    framework(out, dir, "vite", "Vite", Web, Some("vite.config"), "vite");
    if dir.config("vue.config").is_some() || dir.dep("vue") {
        out.push(det(
            "vue",
            "Vue",
            Web,
            if dir.config("vue.config").is_some() {
                High
            } else {
                Medium
            },
            "vue config or dependency",
        ));
    }
    framework(
        out,
        dir,
        "svelte",
        "Svelte",
        Web,
        Some("svelte.config"),
        "svelte",
    );
    framework(
        out,
        dir,
        "astro",
        "Astro",
        Web,
        Some("astro.config"),
        "astro",
    );
    framework(
        out,
        dir,
        "tailwind",
        "Tailwind CSS",
        Web,
        Some("tailwind.config"),
        "tailwindcss",
    );
    if dir.dep("express") {
        out.push(det(
            "express",
            "Express",
            Backend,
            Medium,
            "package.json depends on express",
        ));
    }
    if dir.has("nest-cli.json") {
        out.push(det("nestjs", "NestJS", Backend, High, "nest-cli.json"));
    } else if dir.dep("@nestjs/core") {
        out.push(det(
            "nestjs",
            "NestJS",
            Backend,
            Medium,
            "package.json depends on @nestjs/core",
        ));
    }
}

/// Electron, Neutralino and the mobile shells.
fn shells(out: &mut Vec<Detection>, dir: &Dir) {
    if dir.dep("electron") {
        let main = dir.package_field("main").and_then(Value::as_str);
        let (confidence, evidence) = match main {
            Some(main) => (High, format!("depends on electron, main is {main}")),
            None => (Medium, "package.json depends on electron".to_string()),
        };
        out.push(det("electron", "Electron", Desktop, confidence, evidence));
    }
    if dir.has("neutralino.config.json") {
        out.push(det(
            "neutralino",
            "Neutralino",
            Desktop,
            High,
            "neutralino.config.json",
        ));
    }
    if dir.dep("react-native") {
        out.push(det(
            "react-native",
            "React Native",
            Mobile,
            High,
            "package.json depends on react-native",
        ));
    }
    let expo_config = dir
        .read("app.json")
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .is_some_and(|json| json.get("expo").is_some());
    if expo_config {
        out.push(det(
            "expo",
            "Expo",
            Mobile,
            High,
            "app.json has an expo section",
        ));
    } else if dir.dep("expo") {
        out.push(det(
            "expo",
            "Expo",
            Mobile,
            Medium,
            "package.json depends on expo",
        ));
    }
    if dir.has("ionic.config.json") {
        out.push(det("ionic", "Ionic", Mobile, High, "ionic.config.json"));
    }
    if let Some(file) = dir.config("capacitor.config") {
        out.push(det(
            "capacitor",
            "Capacitor",
            Mobile,
            High,
            format!("{file} exists"),
        ));
    } else if dir.dep("@capacitor/core") {
        out.push(det(
            "capacitor",
            "Capacitor",
            Mobile,
            Medium,
            "package.json depends on @capacitor/core",
        ));
    }
}
