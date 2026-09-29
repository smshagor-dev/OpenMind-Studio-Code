//! Python projects: their environments (`.venv` ...), what `requirements.txt` / `pyproject.toml` declare and what the
//! selected environment has installed — read from `pyvenv.cfg` and `*.dist-info` folder names. No interpreter runs.

use std::path::{Path, PathBuf};

use crate::files::{display_text, is_real_dir, is_real_file, names_in, read_small, MAX_ITEMS};
use crate::model::{Dep, Package, PythonEnv, PythonInfo};

/// Folder names a project-local environment is looked for in.
pub const ENV_FOLDERS: [&str; 4] = [".venv", "venv", "env", ".env"];

/// Files that make a folder a Python project for the Dependencies view.
pub const MANIFESTS: [&str; 4] = [
    "requirements.txt",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
];

/// PEP 503: `Foo_Bar.baz` and `foo-bar-baz` are the same package.
pub fn normalize(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut dash = false;
    for c in name.chars() {
        if matches!(c, '-' | '_' | '.') {
            dash = true;
        } else {
            if dash && !out.is_empty() {
                out.push('-');
            }
            dash = false;
            out.push(c.to_ascii_lowercase());
        }
    }
    out
}

/// The interpreter inside an environment folder.
pub fn env_interpreter(env: &Path) -> PathBuf {
    if cfg!(windows) {
        env.join("Scripts").join("python.exe")
    } else {
        env.join("bin").join("python")
    }
}

/// The project's environments: folders with a `pyvenv.cfg` and an interpreter (links are not followed).
pub fn environments(project: &Path) -> Vec<PythonEnv> {
    ENV_FOLDERS
        .iter()
        .filter_map(|name| {
            let folder = project.join(name);
            let cfg = read_small(&folder.join("pyvenv.cfg"))?;
            let interpreter = env_interpreter(&folder);
            if !is_real_dir(&folder) || !is_real_file(&interpreter) {
                return None;
            }
            let value = |key: &str| {
                cfg.lines().find_map(|line| {
                    let (k, v) = line.split_once('=')?;
                    (k.trim() == key).then(|| display_text(v.trim()))
                })
            };
            let home = value("home").unwrap_or_default().replace('/', "\\");
            Some(PythonEnv {
                name: (*name).to_string(),
                interpreter: interpreter.to_string_lossy().into_owned(),
                version: value("version").or_else(|| value("version_info")),
                from_openmind: home
                    .to_ascii_lowercase()
                    .contains("\\runtimes\\python\\versions\\"),
            })
        })
        .collect()
}

/// `site-packages` of an environment folder or of an interpreter's own folder.
pub fn site_packages(root: &Path) -> PathBuf {
    if cfg!(windows) {
        root.join("Lib").join("site-packages")
    } else {
        root.join("lib").join("site-packages")
    }
}

/// What is installed, from `name-version.dist-info` folder names (wheel names escape `-` in the name as `_`).
pub fn installed(site_packages: &Path) -> Vec<Package> {
    let mut packages: Vec<Package> = names_in(site_packages)
        .into_iter()
        .filter_map(|entry| {
            let stem = entry.strip_suffix(".dist-info")?;
            let (name, version) = stem.split_once('-')?;
            Some(Package {
                name: display_text(name),
                version: display_text(version),
            })
        })
        .take(MAX_ITEMS * 4)
        .collect();
    packages.sort_by_key(|package| normalize(&package.name));
    packages
}

/// A requirement line/string split into a name and the rest, when it is a plain named requirement.
fn split_requirement(text: &str) -> Option<(String, String)> {
    let text = text.split('#').next().unwrap_or("").trim();
    let end = text
        .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')))
        .unwrap_or(text.len());
    let (name, rest) = text.split_at(end);
    if name.is_empty() || !name.starts_with(|c: char| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some((name.to_string(), rest.trim().to_string()))
}

/// `requirements.txt`: named requirements; options (`-r`, `-e`, `--index-url`), URLs and paths are skipped and listed.
pub fn parse_requirements_txt(text: &str, skipped: &mut Vec<String>) -> Vec<Dep> {
    let mut deps = Vec::new();
    for line in text.lines().take(MAX_ITEMS * 2) {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let plain = !line.starts_with('-') && !line.contains("://") && !line.contains(['/', '\\']);
        match split_requirement(line).filter(|_| plain) {
            Some((name, spec)) => deps.push(Dep {
                name: display_text(&name),
                spec: display_text(&spec),
                installed: None,
            }),
            None => skipped.push(display_text(line)),
        }
    }
    deps.truncate(MAX_ITEMS);
    deps
}

/// `pyproject.toml` `[project] dependencies` (PEP 621). Poetry's own table is noted, not read.
pub fn parse_pyproject(text: &str, skipped: &mut Vec<String>, notes: &mut Vec<String>) -> Vec<Dep> {
    let Ok(value) = text.parse::<toml::Table>() else {
        notes.push("pyproject.toml isn't valid TOML, so its dependencies weren't read.".into());
        return Vec::new();
    };
    if value
        .get("tool")
        .and_then(|tool| tool.get("poetry"))
        .is_some()
    {
        notes.push("This is a Poetry project: its [tool.poetry] dependencies are managed by Poetry, which OpenMind doesn't run.".into());
    }
    let list = value
        .get("project")
        .and_then(|project| project.get("dependencies"))
        .and_then(toml::Value::as_array);
    let mut deps = Vec::new();
    for item in list.into_iter().flatten().take(MAX_ITEMS) {
        let Some(text) = item.as_str() else {
            continue;
        };
        match split_requirement(text) {
            Some((name, spec)) if !spec.contains(['@', ';']) => deps.push(Dep {
                name: display_text(&name),
                spec: display_text(&spec),
                installed: None,
            }),
            _ => skipped.push(display_text(text)),
        }
    }
    deps
}

/// Reads a Python project. `fallback` is OpenMind's portable Python folder: its packages are shown when the project
/// has no environment of its own (that is where installs would go).
pub fn read(project: &Path, fallback: Option<&Path>) -> Option<PythonInfo> {
    let manifests: Vec<String> = MANIFESTS
        .iter()
        .filter(|name| is_real_file(&project.join(name)))
        .map(|name| (*name).to_string())
        .collect();
    let environments = environments(project);
    if manifests.is_empty() && environments.is_empty() {
        return None;
    }
    let mut info = PythonInfo {
        manifests,
        environments,
        ..PythonInfo::default()
    };
    if let Some(text) = read_small(&project.join("requirements.txt")) {
        info.requirements = parse_requirements_txt(&text, &mut info.skipped);
    }
    if let Some(text) = read_small(&project.join("pyproject.toml")) {
        let more = parse_pyproject(&text, &mut info.skipped, &mut info.notes);
        for dep in more {
            if !info
                .requirements
                .iter()
                .any(|d| normalize(&d.name) == normalize(&dep.name))
            {
                info.requirements.push(dep);
            }
        }
    }
    if info.manifests.iter().any(|m| m == "setup.py") {
        info.notes.push(
            "setup.py declares its dependencies in code, which isn't run to read them.".into(),
        );
    }
    let site = match info.environments.first() {
        Some(env) => Some(site_packages(&project.join(&env.name))),
        None => fallback.map(site_packages),
    };
    info.installed = site.map(|site| installed(&site)).unwrap_or_default();
    for dep in &mut info.requirements {
        let wanted = normalize(&dep.name);
        dep.installed = info
            .installed
            .iter()
            .find(|package| normalize(&package.name) == wanted)
            .map(|package| package.version.clone());
    }
    info.missing = info
        .requirements
        .iter()
        .filter(|dep| dep.installed.is_none())
        .map(|dep| dep.name.clone())
        .collect();
    info.skipped.truncate(50);
    Some(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_normalized_like_pip() {
        assert_eq!(normalize("Foo_Bar.baz"), "foo-bar-baz");
        assert_eq!(normalize("requests"), "requests");
        assert_eq!(normalize("typing_extensions"), "typing-extensions");
    }

    #[test]
    fn requirements_keep_named_lines_and_list_the_rest() {
        let mut skipped = Vec::new();
        let deps = parse_requirements_txt(
            "# web\nrequests>=2.31  # http\nnumpy\n-r base.txt\n--index-url https://x\ngit+https://github.com/a/b\n./local\nDjango[bcrypt]==5.0\n",
            &mut skipped,
        );
        let names: Vec<&str> = deps.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, ["requests", "numpy", "Django"]);
        assert_eq!(deps[0].spec, ">=2.31");
        assert_eq!(deps[2].spec, "[bcrypt]==5.0");
        assert_eq!(
            skipped,
            [
                "-r base.txt",
                "--index-url https://x",
                "git+https://github.com/a/b",
                "./local"
            ]
        );
    }

    #[test]
    fn pyproject_reads_pep_621_and_leaves_markers_and_urls_alone() {
        let (mut skipped, mut notes) = (Vec::new(), Vec::new());
        let deps = parse_pyproject(
            "[project]\nname = \"app\"\ndependencies = [\"httpx>=0.27\", \"rich\", \"pywin32; sys_platform == 'win32'\", \"pkg @ https://x/y.whl\"]\n[tool.poetry]\nname = \"x\"\n",
            &mut skipped,
            &mut notes,
        );
        assert_eq!(
            deps.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(),
            ["httpx", "rich"]
        );
        assert_eq!(skipped.len(), 2);
        assert!(notes[0].contains("Poetry"));
        let mut notes = Vec::new();
        assert!(parse_pyproject("[project\n", &mut Vec::new(), &mut notes).is_empty());
        assert!(notes[0].contains("isn't valid TOML"));
    }
}
