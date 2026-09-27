//! `vscode.workspace.findFiles` (Milestone 18): files in the open folder whose root-relative path matches an include
//! glob and no exclude glob, found with the index's crawl (so `.gitignore`, `.openmindignore`, the always-excluded
//! folders and "never follow links" all apply), with the app's own glob rules: a pattern without `/` matches at any
//! depth, a folder pattern matches everything inside it. Nothing outside `root` is ever returned.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use crate::error::SearchError;
use crate::index::crawl::crawl;
use crate::index::settings::IndexSettings;
use crate::query::build_globs;

/// Never more than this many results, whatever the caller asks for.
pub const MAX_FIND_RESULTS: usize = 10_000;

/// Files under `root` matching `include` and not `exclude`, sorted, at most `max` (capped at [`MAX_FIND_RESULTS`]).
pub fn find_files(
    root: &Path,
    include: &str,
    exclude: Option<&str>,
    max: Option<usize>,
    cancel: &AtomicBool,
) -> Result<Vec<PathBuf>, SearchError> {
    let include = build_globs(&[include.to_string()])?;
    let exclude = match exclude.filter(|e| !e.trim().is_empty()) {
        Some(pattern) => Some(build_globs(&[pattern.to_string()])?),
        None => None,
    };
    let limit = max.unwrap_or(MAX_FIND_RESULTS).min(MAX_FIND_RESULTS);
    let mut found: Vec<(String, PathBuf)> = Vec::new();
    crawl(root, &IndexSettings::default(), cancel, &mut |entry| {
        if include.is_match(&entry.rel) && !exclude.as_ref().is_some_and(|e| e.is_match(&entry.rel))
        {
            found.push((entry.rel, entry.abs));
        }
    })?;
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found.truncate(limit);
    Ok(found.into_iter().map(|(_, path)| path).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tmp");
        for file in [
            "a.ts",
            "src/b.ts",
            "src/deep/c.ts",
            "src/d.js",
            "node_modules/x/e.ts",
            "out/f.ts",
        ] {
            let path = dir.path().join(file);
            std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
            std::fs::write(path, "x").expect("write");
        }
        dir
    }

    fn names(root: &Path, list: &[PathBuf]) -> Vec<String> {
        list.iter()
            .map(|p| {
                p.strip_prefix(root)
                    .expect("inside")
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect()
    }

    #[test]
    fn include_exclude_and_limits_work_inside_the_root_only() {
        let dir = tree();
        let cancel = AtomicBool::new(false);
        let all = find_files(dir.path(), "*.ts", None, None, &cancel).expect("find");
        assert_eq!(
            names(dir.path(), &all),
            ["a.ts", "src/b.ts", "src/deep/c.ts"],
            "node_modules and build output (out) are never searched"
        );
        let some =
            find_files(dir.path(), "src/**/*.ts", Some("**/deep/**"), None, &cancel).expect("find");
        assert_eq!(names(dir.path(), &some), ["src/b.ts"]);
        let two = find_files(dir.path(), "**/*", Some("deep"), Some(2), &cancel).expect("find");
        assert_eq!(two.len(), 2);
        assert!(find_files(dir.path(), "[", None, None, &cancel).is_err());
    }
}
