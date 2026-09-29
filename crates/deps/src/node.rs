//! Node projects: which package manager (from lock files and `packageManager`, never guessed when they disagree),
//! declared and installed packages (`node_modules/<name>/package.json`), and `package.json` scripts.

use std::path::Path;

use serde_json::Value;

use crate::files::{display_text, is_real_dir, read_small, MAX_ITEMS};
use crate::model::{Dep, NodeInfo, Script};

/// Lock files and the package manager each belongs to.
pub const LOCKFILES: [(&str, &str); 5] = [
    ("package-lock.json", "npm"),
    ("npm-shrinkwrap.json", "npm"),
    ("pnpm-lock.yaml", "pnpm"),
    ("yarn.lock", "yarn"),
    ("bun.lockb", "bun"),
];

/// Package managers OpenMind can plan commands for.
pub const SUPPORTED: [&str; 3] = ["npm", "pnpm", "yarn"];

/// A script name that can be handed to `npm run` as one argument: no spaces, quotes or shell characters, not an
/// option. Scripts with other names are listed but not offered to run.
pub fn safe_script_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && !name.starts_with('-')
        && name.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-' | '.' | '/' | '@' | '+')
        })
}

/// The package manager, or why it can't be picked. `packageManager` (`pnpm@9.1.0`) wins when no lock file of
/// another manager contradicts it.
pub fn package_manager(
    declared: Option<&str>,
    lockfiles: &[String],
) -> (Option<String>, Option<String>) {
    let mut from_locks: Vec<&str> = LOCKFILES
        .iter()
        .filter(|(file, _)| lockfiles.iter().any(|l| l == file))
        .map(|(_, manager)| *manager)
        .collect();
    from_locks.dedup();
    let declared = declared.map(|text| text.split('@').next().unwrap_or(text).trim().to_string());
    if from_locks.len() > 1 {
        return (
            None,
            Some(format!(
                "Several lock files ({}) — choose the package manager this project uses.",
                lockfiles.join(", ")
            )),
        );
    }
    let manager = match (declared.as_deref(), from_locks.first()) {
        (Some(declared), Some(lock)) if declared != *lock => {
            return (
                None,
                Some(format!(
                    "package.json says {declared} but the lock file is {lock}'s — choose the package manager."
                )),
            );
        }
        (Some(declared), _) => declared.to_string(),
        (None, Some(lock)) => (*lock).to_string(),
        (None, None) => "npm".to_string(),
    };
    if SUPPORTED.contains(&manager.as_str()) {
        (Some(manager), None)
    } else {
        (
            None,
            Some(format!(
                "{} isn't supported by OpenMind's Dependencies view.",
                display_text(&manager)
            )),
        )
    }
}

fn installed_version(project: &Path, name: &str) -> Option<String> {
    // Only plain or scoped package names are looked up, so a name can't walk out of node_modules.
    if !openmind_network::packages::valid_npm_package(name)
        || name.contains('@') && !name.starts_with('@')
    {
        return None;
    }
    let manifest = name
        .split('/')
        .fold(project.join("node_modules"), |path, part| path.join(part))
        .join("package.json");
    let value: Value = serde_json::from_str(&read_small(&manifest)?).ok()?;
    value.get("version")?.as_str().map(display_text)
}

fn deps_of(project: &Path, package: &Value, section: &str) -> Vec<Dep> {
    package
        .get(section)
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .take(MAX_ITEMS)
        .map(|(name, spec)| Dep {
            name: display_text(name),
            spec: display_text(spec.as_str().unwrap_or("")),
            installed: installed_version(project, name),
        })
        .collect()
}

/// Reads a Node project (`package.json` must exist and be a JSON object).
pub fn read(project: &Path) -> Option<NodeInfo> {
    let text = read_small(&project.join("package.json"))?;
    let mut info = NodeInfo::default();
    let Ok(package) = serde_json::from_str::<Value>(&text) else {
        info.notes
            .push("package.json isn't valid JSON, so nothing in it was read.".into());
        return Some(info);
    };
    info.lockfiles = LOCKFILES
        .iter()
        .map(|(file, _)| (*file).to_string())
        .filter(|file| crate::files::is_real_file(&project.join(file)))
        .collect();
    let declared = package.get("packageManager").and_then(Value::as_str);
    (info.package_manager, info.conflict) = package_manager(declared, &info.lockfiles);
    info.dependencies = deps_of(project, &package, "dependencies");
    info.dev_dependencies = deps_of(project, &package, "devDependencies");
    info.scripts = package
        .get("scripts")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .take(MAX_ITEMS)
        .map(|(name, command)| Script {
            name: display_text(name),
            command: display_text(command.as_str().unwrap_or("")),
            runnable: safe_script_name(name),
        })
        .collect();
    info.node_modules = is_real_dir(&project.join("node_modules"));
    if info.package_manager.as_deref() == Some("yarn")
        && crate::files::is_real_file(&project.join(".yarnrc.yml"))
    {
        info.notes
            .push("Yarn 2+ (Berry): updates use `yarn up`.".into());
    }
    Some(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn locks(names: &[&str]) -> Vec<String> {
        names.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn the_package_manager_comes_from_lock_files_and_is_never_guessed_on_a_conflict() {
        assert_eq!(package_manager(None, &[]).0.as_deref(), Some("npm"));
        assert_eq!(
            package_manager(None, &locks(&["pnpm-lock.yaml"]))
                .0
                .as_deref(),
            Some("pnpm")
        );
        assert_eq!(
            package_manager(Some("yarn@4.1.0"), &[]).0.as_deref(),
            Some("yarn")
        );
        assert_eq!(
            package_manager(Some("pnpm@9"), &locks(&["pnpm-lock.yaml"]))
                .0
                .as_deref(),
            Some("pnpm")
        );
        let (manager, conflict) =
            package_manager(None, &locks(&["package-lock.json", "yarn.lock"]));
        assert!(manager.is_none() && conflict.expect("conflict").contains("Several lock files"));
        let (manager, conflict) = package_manager(Some("pnpm@9"), &locks(&["package-lock.json"]));
        assert!(manager.is_none() && conflict.expect("conflict").contains("says pnpm"));
        let (manager, conflict) = package_manager(None, &locks(&["bun.lockb"]));
        assert!(manager.is_none() && conflict.expect("reason").contains("isn't supported"));
    }

    #[test]
    fn only_plain_script_names_are_runnable() {
        for name in ["dev", "build:prod", "test-unit", "lint.fix", "@scope/x"] {
            assert!(safe_script_name(name), "{name}");
        }
        for name in [
            "", "-g", "a b", "x&calc", "x\"y", "%PATH%", "a|b", "a;b", "a\nb",
        ] {
            assert!(!safe_script_name(name), "{name:?}");
        }
    }
}
