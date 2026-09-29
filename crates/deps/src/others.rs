//! Composer, Cargo, Maven/Gradle and CMake projects — read from their manifests only.

use std::path::Path;

use serde_json::Value;

use crate::files::{display_text, is_real_dir, is_real_file, read_small, MAX_ITEMS};
use crate::model::{CmakeInfo, Dep, JavaInfo, PhpInfo, RustInfo};

/// Composer's `vendor/package` names (lower case, `-_.` inside the parts).
pub fn valid_composer_package(name: &str) -> bool {
    let part = |p: &str| {
        !p.is_empty()
            && p.len() <= 100
            && p.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
            && p.chars().all(|c| {
                c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.')
            })
    };
    matches!(name.split_once('/'), Some((vendor, package)) if part(vendor) && part(package))
}

/// `php` and `ext-*` / `lib-*` requirements are provided by PHP, not installed by Composer.
fn is_platform(name: &str) -> bool {
    name == "php"
        || name.starts_with("ext-")
        || name.starts_with("lib-")
        || name == "composer-plugin-api"
}

fn composer_installed(project: &Path) -> Vec<(String, String)> {
    let Some(text) = read_small(
        &project
            .join("vendor")
            .join("composer")
            .join("installed.json"),
    ) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    // Composer 2 wraps the list in {"packages": [...]}; Composer 1 wrote the list itself.
    let list = value.get("packages").unwrap_or(&value);
    list.as_array()
        .into_iter()
        .flatten()
        .take(MAX_ITEMS * 4)
        .filter_map(|package| {
            Some((
                package.get("name")?.as_str()?.to_string(),
                package.get("version")?.as_str()?.to_string(),
            ))
        })
        .collect()
}

pub fn read_php(project: &Path) -> Option<PhpInfo> {
    let text = read_small(&project.join("composer.json"))?;
    let mut info = PhpInfo {
        lock: is_real_file(&project.join("composer.lock")),
        vendor: is_real_dir(&project.join("vendor")),
        ..PhpInfo::default()
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return Some(info);
    };
    let installed = composer_installed(project);
    for (section, dev) in [("require", false), ("require-dev", true)] {
        for (name, spec) in value
            .get(section)
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .take(MAX_ITEMS)
        {
            let dep = Dep {
                name: display_text(name),
                spec: display_text(spec.as_str().unwrap_or("")),
                installed: installed
                    .iter()
                    .find(|(installed, _)| installed.eq_ignore_ascii_case(name))
                    .map(|(_, version)| display_text(version)),
            };
            if is_platform(name) {
                info.platform.push(dep);
            } else if dev {
                info.require_dev.push(dep);
            } else {
                info.require.push(dep);
            }
        }
    }
    Some(info)
}

fn toml_deps(table: Option<&toml::Value>) -> Vec<Dep> {
    table
        .and_then(toml::Value::as_table)
        .into_iter()
        .flatten()
        .take(MAX_ITEMS)
        .map(|(name, spec)| Dep {
            name: display_text(name),
            spec: display_text(match spec {
                toml::Value::String(version) => version,
                toml::Value::Table(table) => table
                    .get("version")
                    .and_then(toml::Value::as_str)
                    .or_else(|| table.get("path").map(|_| "path"))
                    .or_else(|| table.get("git").map(|_| "git"))
                    .or_else(|| table.get("workspace").map(|_| "workspace"))
                    .unwrap_or(""),
                _ => "",
            }),
            installed: None,
        })
        .collect()
}

pub fn read_rust(project: &Path) -> Option<RustInfo> {
    let text = read_small(&project.join("Cargo.toml"))?;
    let mut info = RustInfo {
        lock: is_real_file(&project.join("Cargo.lock")),
        ..RustInfo::default()
    };
    let Ok(table) = text.parse::<toml::Table>() else {
        return Some(info);
    };
    let package = table.get("package");
    let field = |key: &str| {
        package
            .and_then(|p| p.get(key))
            .and_then(toml::Value::as_str)
            .map(display_text)
    };
    info.name = field("name");
    info.version = field("version");
    info.edition = field("edition");
    info.workspace_only = package.is_none() && table.contains_key("workspace");
    info.dependencies = toml_deps(table.get("dependencies"));
    info.dev_dependencies = toml_deps(table.get("dev-dependencies"));
    info.features = table
        .get("features")
        .and_then(toml::Value::as_table)
        .into_iter()
        .flatten()
        .take(MAX_ITEMS)
        .map(|(name, _)| display_text(name))
        .collect();
    Some(info)
}

pub fn read_java(project: &Path) -> Option<JavaInfo> {
    let has = |name: &str| is_real_file(&project.join(name));
    let info = JavaInfo {
        maven: has("pom.xml"),
        gradle: has("build.gradle") || has("build.gradle.kts"),
        kotlin_dsl: has("build.gradle.kts"),
        gradle_wrapper: has(if cfg!(windows) {
            "gradlew.bat"
        } else {
            "gradlew"
        }),
    };
    (info.maven || info.gradle).then_some(info)
}

/// A preset name that can be passed to `cmake --preset` as one argument.
pub fn safe_preset(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && !name.starts_with('-')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

pub fn read_cmake(project: &Path) -> Option<CmakeInfo> {
    if !is_real_file(&project.join("CMakeLists.txt")) {
        return None;
    }
    let presets = read_small(&project.join("CMakePresets.json"))
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.get("configurePresets").cloned())
        .and_then(|list| list.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter(|preset| preset.get("hidden").and_then(Value::as_bool) != Some(true))
        .filter_map(|preset| preset.get("name")?.as_str().map(str::to_string))
        .filter(|name| safe_preset(name))
        .take(50)
        .collect();
    Some(CmakeInfo {
        presets,
        configured: is_real_file(&project.join("build").join("CMakeCache.txt")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn composer_names_are_vendor_slash_package() {
        for name in [
            "monolog/monolog",
            "laravel/framework",
            "psr/log",
            "symfony/http-kernel",
        ] {
            assert!(valid_composer_package(name), "{name}");
        }
        for name in [
            "monolog",
            "Monolog/Monolog",
            "a/b/c",
            "a/",
            "/b",
            "a/b;calc",
            "-x/y",
            "a/b c",
            "../x",
        ] {
            assert!(!valid_composer_package(name), "{name}");
        }
    }

    #[test]
    fn manifests_are_read_without_trusting_them() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path();
        fs::write(p.join("composer.json"), r#"{"require":{"php":">=8.2","ext-mbstring":"*","monolog/monolog":"^3.0"},"require-dev":{"phpunit/phpunit":"^11"}}"#).expect("w");
        fs::create_dir_all(p.join("vendor/composer")).expect("d");
        fs::write(
            p.join("vendor/composer/installed.json"),
            r#"{"packages":[{"name":"monolog/monolog","version":"3.7.0"}]}"#,
        )
        .expect("w");
        let php = read_php(p).expect("php");
        assert_eq!(php.platform.len(), 2);
        assert_eq!(php.require[0].installed.as_deref(), Some("3.7.0"));
        assert_eq!(php.require_dev[0].installed, None);

        fs::write(p.join("Cargo.toml"), "[package]\nname = \"demo\"\nversion = \"0.1.0\"\nedition = \"2021\"\n[dependencies]\nserde = { version = \"1\", features = [\"derive\"] }\nrand = \"0.9\"\nlocal = { path = \"../local\" }\n[dev-dependencies]\ntempfile = \"3\"\n[features]\nfast = []\n").expect("w");
        let rust = read_rust(p).expect("rust");
        assert_eq!(rust.name.as_deref(), Some("demo"));
        assert_eq!(
            rust.dependencies
                .iter()
                .map(|d| d.spec.as_str())
                .collect::<Vec<_>>(),
            ["path", "0.9", "1"]
        );
        assert_eq!(rust.features, ["fast"]);
        fs::write(p.join("Cargo.toml"), "[workspace\n").expect("w");
        assert!(read_rust(p)
            .expect("still a Cargo project")
            .dependencies
            .is_empty());

        fs::write(p.join("CMakeLists.txt"), "project(x)").expect("w");
        fs::write(p.join("CMakePresets.json"), r#"{"configurePresets":[{"name":"debug"},{"name":"base","hidden":true},{"name":"x & calc"}]}"#).expect("w");
        assert_eq!(read_cmake(p).expect("cmake").presets, ["debug"]);

        assert!(read_java(p).is_none());
        fs::write(p.join("build.gradle.kts"), "").expect("w");
        fs::write(
            p.join(if cfg!(windows) {
                "gradlew.bat"
            } else {
                "gradlew"
            }),
            "",
        )
        .expect("w");
        let java = read_java(p).expect("java");
        assert!(java.gradle && java.kotlin_dsl && java.gradle_wrapper && !java.maven);
    }
}
