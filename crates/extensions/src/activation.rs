//! Activation events: which extensions a trigger (a command being run, a language being opened, the app
//! finishing start-up, ...) should wake. Extensions are never activated at launch except for `*` and
//! `onStartupFinished`, and only when enabled.

use std::fs;
use std::path::Path;

use serde::Deserialize;

use crate::manifest::ActivationEvent;
use crate::store::InstalledExtension;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Trigger {
    /// The app finished starting: wakes `*` and `onStartupFinished`.
    Startup,
    Command {
        command: String,
    },
    Language {
        language: String,
    },
    View {
        view: String,
    },
    /// A folder was opened: wakes `workspaceContains:<glob>` when the folder has a match.
    Workspace {
        root: String,
    },
}

/// The ids of the enabled extensions with code that `trigger` wakes, in a stable order.
pub fn extensions_for(extensions: &[InstalledExtension], trigger: &Trigger) -> Vec<String> {
    let mut ids: Vec<String> = extensions
        .iter()
        .filter(|extension| extension.enabled && extension.manifest.has_code())
        .filter(|extension| {
            extension
                .manifest
                .effective_activation()
                .iter()
                .any(|event| event_matches(event, trigger))
        })
        .map(|extension| extension.id.clone())
        .collect();
    ids.sort();
    ids
}

/// Resolve extension dependencies in activation order. Dependencies run before their
/// dependants even if they have no matching activation event of their own.
/// Refuse missing/disabled dependencies and cycles rather than silently starting
/// a partially working extension.
pub fn activation_order(
    extensions: &[InstalledExtension],
    requested: &[String],
) -> Result<Vec<String>, String> {
    use std::collections::{HashMap, HashSet};

    fn visit(
        id: &str,
        by_id: &HashMap<&str, &InstalledExtension>,
        visiting: &mut HashSet<String>,
        visited: &mut HashSet<String>,
        ordered: &mut Vec<String>,
    ) -> Result<(), String> {
        if visited.contains(id) {
            return Ok(());
        }
        let extension = by_id
            .get(id)
            .ok_or_else(|| format!("Extension dependency {id} is not installed."))?;
        if !extension.enabled {
            return Err(format!("Extension dependency {id} is disabled."));
        }
        if !crate::manifest::engine_compatible(&extension.manifest) {
            return Err(format!(
                "{id} requires VS Code engine {}, but OpenMind Studio supports the {} API subset.",
                extension.manifest.engines_vscode.as_deref().unwrap_or("unknown"),
                crate::manifest::EXTENSION_API_VERSION
            ));
        }
        if !visiting.insert(id.to_string()) {
            return Err(format!("Circular extension dependency involving {id}."));
        }
        for dependency in &extension.manifest.extension_dependencies {
            visit(&dependency.to_lowercase(), by_id, visiting, visited, ordered)?;
        }
        visiting.remove(id);
        visited.insert(id.to_string());
        if extension.manifest.has_code() {
            ordered.push(id.to_string());
        }
        Ok(())
    }

    let by_id: HashMap<&str, &InstalledExtension> =
        extensions.iter().map(|extension| (extension.id.as_str(), extension)).collect();
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    let mut ordered = Vec::new();
    for id in requested {
        visit(&id.to_lowercase(), &by_id, &mut visiting, &mut visited, &mut ordered)?;
    }
    Ok(ordered)
}

fn event_matches(event: &ActivationEvent, trigger: &Trigger) -> bool {
    match (event, trigger) {
        (ActivationEvent::Star | ActivationEvent::OnStartupFinished, Trigger::Startup) => true,
        (ActivationEvent::OnCommand(wanted), Trigger::Command { command }) => wanted == command,
        (ActivationEvent::OnLanguage(wanted), Trigger::Language { language }) => wanted == language,
        (ActivationEvent::OnView(wanted), Trigger::View { view }) => wanted == view,
        (ActivationEvent::WorkspaceContains(pattern), Trigger::Workspace { root }) => {
            workspace_contains(Path::new(root), pattern)
        }
        _ => false,
    }
}

const SKIPPED_FOLDERS: [&str; 6] = ["node_modules", ".git", "target", "dist", "build", "vendor"];
const MAX_DEPTH: usize = 6;
const MAX_ENTRIES: usize = 5_000;

/// Whether some file under `root` matches the glob (`*`, `?`, `**`), looking at a bounded number of entries
/// and never into `node_modules`/`.git`/build folders.
pub fn workspace_contains(root: &Path, pattern: &str) -> bool {
    let pattern = pattern.trim_start_matches("./").replace('\\', "/");
    let mut stack = vec![(root.to_path_buf(), String::new(), 0usize)];
    let mut seen = 0usize;
    while let Some((dir, prefix, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            seen += 1;
            if seen > MAX_ENTRIES {
                return false;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let relative = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                if depth < MAX_DEPTH && !SKIPPED_FOLDERS.contains(&name.as_str()) {
                    stack.push((entry.path(), relative, depth + 1));
                }
            } else if glob_matches(&pattern, &relative) {
                return true;
            }
        }
    }
    false
}

/// `*` and `?` stay inside a path segment, `**` crosses segments (`**/x` also matches `x`).
pub fn glob_matches(pattern: &str, path: &str) -> bool {
    let pattern: Vec<&str> = pattern.split('/').collect();
    let path: Vec<&str> = path.split('/').collect();
    match_segments(&pattern, &path)
}

fn match_segments(pattern: &[&str], path: &[&str]) -> bool {
    match pattern.split_first() {
        None => path.is_empty(),
        Some((&"**", rest)) => (0..=path.len()).any(|skip| match_segments(rest, &path[skip..])),
        Some((first, rest)) => match path.split_first() {
            Some((segment, path_rest)) => {
                match_segment(first, segment) && match_segments(rest, path_rest)
            }
            None => false,
        },
    }
}

fn match_segment(pattern: &str, text: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let text: Vec<char> = text.chars().collect();
    let mut table = vec![vec![false; text.len() + 1]; pattern.len() + 1];
    table[0][0] = true;
    for (i, &symbol) in pattern.iter().enumerate() {
        for j in 0..=text.len() {
            table[i + 1][j] = match symbol {
                '*' => table[i][j] || (j > 0 && table[i + 1][j - 1]),
                '?' => j > 0 && table[i][j - 1],
                other => j > 0 && table[i][j - 1] && text[j - 1] == other,
            };
        }
    }
    table[pattern.len()][text.len()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::Manifest;
    use crate::store::describe_for_tests;

    fn extension(json: &str, enabled: bool) -> InstalledExtension {
        let manifest = Manifest::parse(json).expect("valid");
        describe_for_tests(manifest, enabled)
    }

    #[test]
    fn dependencies_activate_before_their_dependants() {
        let parent = extension(
            r#"{"name":"parent","publisher":"acme","version":"1.0.0","main":"./p.js","extensionDependencies":["acme.middle"]}"#,
            true,
        );
        let middle = extension(
            r#"{"name":"middle","publisher":"acme","version":"1.0.0","main":"./m.js","extensionDependencies":["acme.base"]}"#,
            true,
        );
        let base = extension(
            r#"{"name":"base","publisher":"acme","version":"1.0.0","main":"./b.js"}"#,
            true,
        );
        let order = activation_order(&[parent, middle, base], &["acme.parent".into()]).unwrap();
        assert_eq!(order, ["acme.base", "acme.middle", "acme.parent"]);
    }

    #[test]
    fn missing_disabled_and_cyclic_dependencies_are_refused() {
        let needs = extension(
            r#"{"name":"needs","publisher":"acme","version":"1.0.0","main":"./n.js","extensionDependencies":["acme.base"]}"#,
            true,
        );
        let base = extension(
            r#"{"name":"base","publisher":"acme","version":"1.0.0","main":"./b.js"}"#,
            false,
        );
        assert!(activation_order(&[needs.clone()], &["acme.needs".into()])
            .unwrap_err().contains("not installed"));
        assert!(activation_order(&[needs.clone(), base], &["acme.needs".into()])
            .unwrap_err().contains("disabled"));
        let cycle = extension(
            r#"{"name":"base","publisher":"acme","version":"1.0.0","main":"./b.js","extensionDependencies":["acme.needs"]}"#,
            true,
        );
        assert!(activation_order(&[needs, cycle], &["acme.needs".into()])
            .unwrap_err().contains("Circular"));
    }

    #[test]
    fn incompatible_engine_is_not_activated() {
        let new_api = extension(
            r#"{"name":"newer","publisher":"acme","version":"1.0.0","main":"./main.js","engines":{"vscode":"^1.100.0"}}"#,
            true,
        );
        assert!(activation_order(&[new_api], &["acme.newer".into()])
            .unwrap_err().contains("requires VS Code engine"));
        let supported = extension(
            r#"{"name":"supported","publisher":"acme","version":"1.0.0","main":"./main.js","engines":{"vscode":"^1.85.0"}}"#,
            true,
        );
        assert_eq!(
            activation_order(&[supported], &["acme.supported".into()]).unwrap(),
            ["acme.supported"]
        );
    }

    #[test]
    fn repeated_dependencies_activate_once() {
        let a = extension(
            r#"{"name":"a","publisher":"acme","version":"1.0.0","main":"./a.js","extensionDependencies":["acme.base"]}"#,
            true,
        );
        let b = extension(
            r#"{"name":"b","publisher":"acme","version":"1.0.0","main":"./b.js","extensionDependencies":["acme.base"]}"#,
            true,
        );
        let base = extension(
            r#"{"name":"base","publisher":"acme","version":"1.0.0","main":"./base.js"}"#,
            true,
        );
        assert_eq!(
            activation_order(&[a, b, base], &["acme.a".into(), "acme.b".into()]).unwrap(),
            ["acme.base", "acme.a", "acme.b"]
        );
    }

    #[test]
    fn globs_match_like_vs_code_patterns() {
        assert!(glob_matches("package.json", "package.json"));
        assert!(!glob_matches("package.json", "sub/package.json"));
        assert!(glob_matches("**/package.json", "package.json"));
        assert!(glob_matches("**/package.json", "a/b/package.json"));
        assert!(glob_matches("*.php", "index.php"));
        assert!(!glob_matches("*.php", "a/index.php"));
        assert!(glob_matches("src/**/*.ts", "src/a/b/c.ts"));
        assert!(glob_matches("file?.txt", "file1.txt"));
        assert!(!glob_matches("file?.txt", "file12.txt"));
    }

    #[test]
    fn workspace_contains_finds_files_and_skips_node_modules() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("My Site");
        fs::create_dir_all(root.join("src/deep")).expect("mkdir");
        fs::create_dir_all(root.join("node_modules/pkg")).expect("mkdir");
        fs::write(root.join("src/deep/composer.json"), "{}").expect("write");
        fs::write(root.join("node_modules/pkg/hidden.lock"), "").expect("write");
        assert!(workspace_contains(&root, "**/composer.json"));
        assert!(!workspace_contains(&root, "**/hidden.lock"));
        assert!(!workspace_contains(&root, "**/missing.json"));
        assert!(!workspace_contains(
            &root.join("nowhere"),
            "**/composer.json"
        ));
    }

    #[test]
    fn a_trigger_wakes_only_enabled_extensions_with_a_matching_event_and_code() {
        let by_command = extension(
            r#"{"name":"cmd","version":"1.0.0","publisher":"acme","main":"./x.js","contributes":{"commands":[{"command":"cmd.hello","title":"Hello"}]}}"#,
            true,
        );
        let star = extension(
            r#"{"name":"star","version":"1.0.0","publisher":"acme","main":"./x.js","activationEvents":["*"]}"#,
            true,
        );
        let finished = extension(
            r#"{"name":"fin","version":"1.0.0","publisher":"acme","main":"./x.js","activationEvents":["onStartupFinished"]}"#,
            true,
        );
        let disabled = extension(
            r#"{"name":"off","version":"1.0.0","publisher":"acme","main":"./x.js","activationEvents":["onStartupFinished"]}"#,
            false,
        );
        let no_code = extension(
            r#"{"name":"data","version":"1.0.0","publisher":"acme","contributes":{"languages":[{"id":"foo"}]}}"#,
            true,
        );
        let by_language = extension(
            r#"{"name":"lang","version":"1.0.0","publisher":"acme","main":"./x.js","activationEvents":["onLanguage:foo"]}"#,
            true,
        );
        let all = [by_command, star, finished, disabled, no_code, by_language];

        assert_eq!(
            extensions_for(&all, &Trigger::Startup),
            vec!["acme.fin".to_string(), "acme.star".to_string()]
        );
        assert_eq!(
            extensions_for(
                &all,
                &Trigger::Command {
                    command: "cmd.hello".into()
                }
            ),
            vec!["acme.cmd".to_string()]
        );
        assert!(extensions_for(
            &all,
            &Trigger::Command {
                command: "other".into()
            }
        )
        .is_empty());
        assert_eq!(
            extensions_for(
                &all,
                &Trigger::Language {
                    language: "foo".into()
                }
            ),
            vec!["acme.lang".to_string()]
        );
        assert!(extensions_for(&all, &Trigger::View { view: "x".into() }).is_empty());
    }
}

