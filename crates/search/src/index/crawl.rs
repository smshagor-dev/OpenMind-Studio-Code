//! Walking the workspace for the index: gitignore-aware, never following links, skipping heavy folders.

use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::UNIX_EPOCH;

use ignore::WalkBuilder;

use crate::error::SearchError;
use crate::index::settings::{IndexSettings, INDEX_EXCLUDED_DIRS};
use crate::query::build_globs;

/// A file the crawl found.
#[derive(Debug, Clone)]
pub struct CrawlEntry {
    /// Relative to the workspace root, forward slashes.
    pub rel: String,
    pub abs: PathBuf,
    pub size: u64,
    pub mtime_ms: i64,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct CrawlSummary {
    /// Folders or files that couldn't be read (logged, skipped).
    pub unreadable: usize,
}

pub fn is_excluded_dir_name(name: &str) -> bool {
    INDEX_EXCLUDED_DIRS
        .iter()
        .any(|excluded| name.eq_ignore_ascii_case(excluded))
}

pub fn slash_relative(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let text = relative.to_string_lossy().replace('\\', "/");
    (!text.is_empty()).then_some(text)
}

pub fn mtime_ms(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        })
}

/// Calls `on_entry` for every indexable file under `root`. Honours `.gitignore` (if enabled) and `.openmindignore`
/// files, the always-excluded folders and the user's exclude globs; never follows symbolic links or junctions
/// (nothing outside the workspace is reached, and a link loop can't recurse); a folder it can't read is logged
/// and skipped.
pub fn crawl(
    root: &Path,
    settings: &IndexSettings,
    cancel: &AtomicBool,
    on_entry: &mut dyn FnMut(CrawlEntry),
) -> Result<CrawlSummary, SearchError> {
    if !root.is_dir() {
        return Err(SearchError::InvalidRoot(root.to_path_buf()));
    }
    let excludes = build_globs(&settings.exclude)?;
    let filter_root = root.to_path_buf();
    let mut builder = WalkBuilder::new(root);
    builder
        .standard_filters(false)
        .hidden(!settings.index_hidden)
        .git_ignore(settings.use_gitignore)
        .git_global(false)
        .git_exclude(false)
        .require_git(false)
        .parents(false)
        .ignore(false)
        .follow_links(false)
        .add_custom_ignore_filename(".openmindignore")
        .filter_entry(move |entry| {
            let is_dir = entry.file_type().is_some_and(|kind| kind.is_dir());
            if is_dir && is_excluded_dir_name(&entry.file_name().to_string_lossy()) {
                return false;
            }
            match slash_relative(&filter_root, entry.path()) {
                Some(relative) => !excludes.is_match(&relative),
                None => true,
            }
        });
    let mut summary = CrawlSummary::default();
    for result in builder.build() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let entry = match result {
            Ok(entry) => entry,
            Err(err) => {
                tracing::debug!(%err, "skipping an unreadable path while indexing");
                summary.unreadable += 1;
                continue;
            }
        };
        let Some(kind) = entry.file_type() else {
            continue;
        };
        // Symlinks and junctions are neither: `follow_links(false)` reports them as links, which are skipped.
        if !kind.is_file() {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            summary.unreadable += 1;
            continue;
        };
        let Some(rel) = slash_relative(root, entry.path()) else {
            continue;
        };
        on_entry(CrawlEntry {
            rel,
            abs: entry.path().to_path_buf(),
            size: metadata.len(),
            mtime_ms: mtime_ms(&metadata),
        });
    }
    Ok(summary)
}

/// A path the UI or the file watcher named, checked to be inside `root` (lexically: no `..`, no other root) and
/// returned as a relative forward-slash path. The path need not exist (a deleted file is still a valid change).
pub fn relative_inside(root: &Path, path: &Path) -> Result<String, SearchError> {
    if path
        .components()
        .any(|part| matches!(part, Component::ParentDir))
        || path.to_string_lossy().contains('\0')
    {
        return Err(SearchError::OutsideWorkspace);
    }
    slash_relative(root, path).ok_or(SearchError::OutsideWorkspace)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn write(root: &Path, rel: &str, text: &str) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("mkdir");
        }
        fs::write(path, text).expect("write");
    }

    fn found(root: &Path, settings: &IndexSettings) -> Vec<String> {
        let mut out = Vec::new();
        crawl(root, settings, &AtomicBool::new(false), &mut |e| {
            out.push(e.rel)
        })
        .expect("crawl");
        out.sort();
        out
    }

    #[test]
    fn heavy_folders_hidden_files_and_ignore_files_are_skipped() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("My Project");
        for rel in [
            "src/app.ts",
            "src/deep/routes.php",
            "node_modules/pkg/index.js",
            ".git/config",
            "target/debug/x.rs",
            "dist/out.js",
            "build/out.js",
            ".venv/lib/a.py",
            "__pycache__/a.pyc",
            ".hidden/secret.txt",
            "ignored_by_git/a.txt",
            "mine/private.txt",
            "keep.md",
        ] {
            write(&root, rel, "x");
        }
        write(&root, ".gitignore", "ignored_by_git/\n*.log\n");
        write(&root, "debug.log", "x");
        write(&root, ".openmindignore", "mine/\n");
        let files = found(&root, &IndexSettings::default());
        assert_eq!(files, vec!["keep.md", "src/app.ts", "src/deep/routes.php"]);
        // Without .gitignore support the git-ignored files come back, .openmindignore still applies.
        let no_git = IndexSettings {
            use_gitignore: false,
            ..IndexSettings::default()
        };
        let files = found(&root, &no_git);
        assert!(files.contains(&"ignored_by_git/a.txt".to_string()));
        assert!(files.contains(&"debug.log".to_string()));
        assert!(!files.contains(&"mine/private.txt".to_string()));
        // Hidden files only when asked (the always-excluded folders stay out).
        let hidden = IndexSettings {
            index_hidden: true,
            ..IndexSettings::default()
        };
        let files = found(&root, &hidden);
        assert!(files.contains(&".hidden/secret.txt".to_string()));
        assert!(!files
            .iter()
            .any(|f| f.starts_with(".git/") || f.starts_with("node_modules/")));
    }

    #[test]
    fn user_exclude_globs_apply() {
        let dir = tempfile::tempdir().expect("tempdir");
        for rel in ["a.ts", "gen/b.ts", "c.min.js", "src/d.ts"] {
            write(dir.path(), rel, "x");
        }
        let settings = IndexSettings {
            exclude: vec!["gen".into(), "*.min.js".into()],
            ..IndexSettings::default()
        };
        assert_eq!(found(dir.path(), &settings), vec!["a.ts", "src/d.ts"]);
    }

    #[test]
    fn a_cancelled_crawl_stops_and_a_missing_root_is_an_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path(), "a.ts", "x");
        let mut seen = 0;
        crawl(
            dir.path(),
            &IndexSettings::default(),
            &AtomicBool::new(true),
            &mut |_| seen += 1,
        )
        .expect("crawl");
        assert_eq!(seen, 0);
        assert!(crawl(
            &dir.path().join("missing"),
            &IndexSettings::default(),
            &AtomicBool::new(false),
            &mut |_| ()
        )
        .is_err());
    }

    #[test]
    fn links_are_never_followed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("ws");
        let outside = dir.path().join("outside");
        write(&root, "in.txt", "x");
        write(&outside, "secret.txt", "x");
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(&outside, root.join("link")).is_ok();
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&outside, root.join("link")).is_ok();
        if !made {
            return; // this machine can't create links: nothing to check
        }
        assert_eq!(found(&root, &IndexSettings::default()), vec!["in.txt"]);
    }

    #[test]
    fn paths_outside_the_workspace_or_with_dotdot_are_refused() {
        let root = Path::new("C:/My Project");
        assert_eq!(
            relative_inside(root, Path::new("C:/My Project/src/a.ts")).expect("ok"),
            "src/a.ts"
        );
        assert!(relative_inside(root, Path::new("C:/Other/a.ts")).is_err());
        assert!(relative_inside(root, Path::new("C:/My Project/../Other/a.ts")).is_err());
        assert!(relative_inside(root, Path::new("C:/My Project")).is_err());
    }
}
