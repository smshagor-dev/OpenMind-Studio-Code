use std::path::{Component, Path};

/// Folders whose contents are never reported: huge, generated or Git's own.
pub const IGNORED_FOLDERS: &[&str] = &["node_modules", ".git", "target", "dist", "build", "vendor"];

/// Whether `path` is inside an ignored folder *below* `root` (the root itself
/// may live in a folder called `build`; only what is under it counts).
pub fn is_ignored(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    relative.components().any(|component| match component {
        Component::Normal(name) => {
            let name = name.to_string_lossy();
            IGNORED_FOLDERS
                .iter()
                .any(|ignored| name.eq_ignore_ascii_case(ignored))
        }
        _ => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_below_ignored_folders_are_ignored_at_any_depth() {
        let root = Path::new("C:/My Projects/site");
        for ignored in [
            "C:/My Projects/site/node_modules/pkg/index.js",
            "C:/My Projects/site/.git/index",
            "C:/My Projects/site/src/target/debug/x",
            "C:/My Projects/site/vendor/autoload.php",
            "C:/My Projects/site/DIST/app.js",
            "C:/My Projects/site/build",
        ] {
            assert!(is_ignored(root, Path::new(ignored)), "{ignored}");
        }
    }

    #[test]
    fn ordinary_paths_and_look_alikes_are_kept() {
        let root = Path::new("C:/My Projects/site");
        for kept in [
            "C:/My Projects/site/src/app.php",
            "C:/My Projects/site/builder/x.txt",
            "C:/My Projects/site/my build notes.txt",
            "C:/My Projects/site/.gitignore",
            "C:/My Projects/site/targets/a",
        ] {
            assert!(!is_ignored(root, Path::new(kept)), "{kept}");
        }
    }

    #[test]
    fn a_root_that_is_itself_called_build_is_still_watched() {
        let root = Path::new("C:/work/build");
        assert!(!is_ignored(root, Path::new("C:/work/build/src/a.txt")));
        assert!(is_ignored(root, Path::new("C:/work/build/dist/a.txt")));
    }
}
