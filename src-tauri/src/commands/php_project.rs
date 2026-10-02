//! What the PHP configuration page may say about a project folder: Composer, Laravel, `vendor/`, `.env`, the npm
//! scripts the Laravel helper offers. It only looks; nothing is written.

use std::path::Path;

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub is_dir: bool,
    pub has_composer_json: bool,
    /// `composer.json` requires `laravel/framework` and there is an `artisan` file.
    pub is_laravel: bool,
    /// The project's packages are installed (`vendor/` exists).
    pub has_vendor: bool,
    /// A `.env` file exists (nothing here ever writes it).
    pub has_env: bool,
    /// `package.json` scripts that the Laravel helper offers: `dev` and `build` when they exist.
    pub npm_scripts: Vec<String>,
}

#[tauri::command]
pub fn php_project_info(root: String) -> ProjectInfo {
    project_info(Path::new(&root))
}

/// What the PHP configuration page may say about a project folder (it only looks; nothing is written).
fn project_info(path: &Path) -> ProjectInfo {
    let is_dir = path.is_absolute() && path.is_dir();
    let composer = std::fs::read_to_string(path.join("composer.json")).ok();
    let is_laravel = is_dir
        && path.join("artisan").is_file()
        && composer
            .as_deref()
            .is_some_and(|text| text.contains("\"laravel/framework\""));
    let npm_scripts = std::fs::read_to_string(path.join("package.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|json| json.get("scripts").cloned())
        .map(|scripts| {
            ["dev", "build"]
                .into_iter()
                .filter(|name| scripts.get(name).is_some_and(serde_json::Value::is_string))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    ProjectInfo {
        is_dir,
        has_composer_json: path.join("composer.json").is_file(),
        is_laravel,
        has_vendor: path.join("vendor").is_dir(),
        has_env: path.join(".env").is_file(),
        npm_scripts,
    }
}

#[cfg(test)]
mod project_info_tests {
    use super::*;

    fn write(dir: &Path, name: &str, text: &str) {
        std::fs::write(dir.join(name), text).expect("file");
    }

    #[test]
    fn a_laravel_project_is_recognised_by_its_manifest_and_artisan() {
        let dir = tempfile::tempdir().expect("tmp");
        let root = dir.path().join("My Laravel Site");
        std::fs::create_dir_all(root.join("vendor")).expect("vendor");
        write(
            &root,
            "composer.json",
            r#"{"require":{"laravel/framework":"^11"}}"#,
        );
        write(&root, "artisan", "<?php");
        write(
            &root,
            "package.json",
            r#"{"scripts":{"dev":"vite","build":"vite build","lint":"x"}}"#,
        );
        let info = project_info(&root);
        assert!(info.is_dir && info.has_composer_json && info.is_laravel && info.has_vendor);
        assert!(!info.has_env, "no .env, and nothing creates one");
        assert_eq!(info.npm_scripts, ["dev", "build"]);
    }

    #[test]
    fn a_plain_composer_project_or_a_missing_folder_is_not_laravel() {
        let dir = tempfile::tempdir().expect("tmp");
        write(
            dir.path(),
            "composer.json",
            r#"{"require":{"monolog/monolog":"^3"}}"#,
        );
        write(dir.path(), "artisan", "<?php");
        assert!(!project_info(dir.path()).is_laravel);
        let missing = project_info(&dir.path().join("nope"));
        assert!(!missing.is_dir && !missing.is_laravel && missing.npm_scripts.is_empty());
        assert!(!project_info(Path::new("relative/path")).is_dir);
    }
}
