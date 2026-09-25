//! The PHP server's default web root, XAMPP's `htdocs` for OpenMind: one folder
//! inside the portable app folder whose sub-folders are each served as a site
//! at `http://127.0.0.1:<port>/<folder>/`. The server is not tied to a project.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The web root's folder name, next to `data/` and `runtimes/`.
pub const WEB_ROOT_DIR: &str = "htdocs";

/// The start page written into a fresh web root: lists the folders (each one a
/// site) and the PHP version. Plain PHP, every name escaped, nothing loaded
/// from outside. Written only when the web root has no start page of its own.
pub const DASHBOARD_INDEX: &str = r#"<?php
// OpenMind Studio web root. Every folder here is served at /<folder>/.
// OpenMind wrote this page because the folder had none; edit or delete it freely.
$h = fn (string $text): string => htmlspecialchars($text, ENT_QUOTES, 'UTF-8');
$sites = [];
foreach (scandir(__DIR__) ?: [] as $name) {
    if ($name[0] !== '.' && is_dir(__DIR__ . DIRECTORY_SEPARATOR . $name)) {
        $sites[] = $name;
    }
}
?><!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>OpenMind Studio — Web Root</title>
<style>
body { font: 14px/1.5 "Segoe UI", system-ui, sans-serif; margin: 40px auto; max-width: 720px; padding: 0 16px; color: #222; }
h1 { font-weight: 400; margin-bottom: 4px; }
.muted { color: #666; }
ul { padding-left: 20px; }
li { margin: 4px 0; }
code { background: #f2f2f2; padding: 1px 4px; border-radius: 3px; }
</style>
</head>
<body>
<h1>OpenMind Studio web root</h1>
<p class="muted">PHP <?= $h(PHP_VERSION) ?> · <code><?= $h(__DIR__) ?></code></p>
<h2>Sites</h2>
<?php if ($sites === []): ?>
<p>No sites yet. Put a project folder in <code><?= $h(__DIR__) ?></code> and it opens at <code>/folder-name/</code>.</p>
<?php else: ?>
<ul>
<?php foreach ($sites as $site): ?>
<li><a href="/<?= $h(rawurlencode($site)) ?>/"><?= $h($site) ?></a></li>
<?php endforeach; ?>
</ul>
<?php endif; ?>
</body>
</html>
"#;

/// Creates `<app_root>/htdocs` if needed and gives it the start page when it has
/// no `index.php`/`index.html` yet. An existing start page is never touched.
pub fn ensure_web_root(app_root: &Path) -> io::Result<PathBuf> {
    let root = app_root.join(WEB_ROOT_DIR);
    fs::create_dir_all(&root)?;
    let has_index = ["index.php", "index.html"]
        .iter()
        .any(|name| root.join(name).exists());
    if !has_index {
        fs::write(root.join("index.php"), DASHBOARD_INDEX)?;
    }
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_the_folder_and_its_start_page() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = dir.path().join("OpenMind Studio");
        let root = ensure_web_root(&app).expect("web root");
        assert_eq!(root, app.join("htdocs"));
        let index = fs::read_to_string(root.join("index.php")).expect("index");
        assert!(index.contains("htmlspecialchars"));
    }

    #[test]
    fn never_overwrites_an_existing_start_page() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("htdocs");
        fs::create_dir_all(&root).expect("mkdir");
        fs::write(root.join("index.php"), "<?php echo 'mine';").expect("write");
        ensure_web_root(dir.path()).expect("web root");
        assert_eq!(
            fs::read_to_string(root.join("index.php")).expect("read"),
            "<?php echo 'mine';"
        );
    }

    #[test]
    fn an_index_html_counts_as_a_start_page() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("htdocs");
        fs::create_dir_all(&root).expect("mkdir");
        fs::write(root.join("index.html"), "<p>mine</p>").expect("write");
        ensure_web_root(dir.path()).expect("web root");
        assert!(!root.join("index.php").exists());
    }
}
