//! Turning a request's address into a file inside the served folder, or refusing it.

use std::path::{Path, PathBuf};

use crate::bridge::{BRIDGE_PATH, RUN_SCRIPT_PATH};
use crate::PreviewError;

/// What an address names.
#[derive(Debug, PartialEq, Eq)]
pub enum Resolved {
    /// A regular file inside the folder.
    File(PathBuf),
    /// A missing `name.css` whose `name.scss`/`name.sass` exists: served compiled.
    Sass(PathBuf),
    /// A folder inside the folder; `slash` says whether the address ended with `/` (relative links need it).
    Directory { path: PathBuf, slash: bool },
    /// Nothing there.
    Missing,
    /// The console bridge script.
    Bridge,
    /// A page that runs one script of the folder (`src` = its address, e.g. `/js/app.js`).
    RunScript { src: String, module: bool },
}

/// Resolves `target` (a request target such as `/css/site.css?v=2`) against the canonical folder `root`.
/// `..`, drive letters, back slashes, NUL and paths that lead out of the folder through a link are refused.
pub fn resolve_path(root: &Path, target: &str) -> Result<Resolved, PreviewError> {
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (target.split('#').next().unwrap_or(""), None),
    };
    let decoded = percent_decode(path).ok_or(PreviewError::Outside)?;
    if decoded == BRIDGE_PATH {
        return Ok(Resolved::Bridge);
    }
    if decoded == RUN_SCRIPT_PATH {
        return run_script(root, query.unwrap_or(""));
    }
    let slash = decoded.ends_with('/');
    let mut file = root.to_path_buf();
    for segment in decoded.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." || segment.contains(['\\', ':', '\0']) {
            return Err(PreviewError::Outside);
        }
        file.push(segment);
    }
    let Ok(canonical) = std::fs::canonicalize(&file) else {
        return Ok(
            match crate::sass::source_for_css(&file)
                .and_then(|source| std::fs::canonicalize(source).ok())
            {
                Some(source) if source.starts_with(root) => Resolved::Sass(source),
                _ => Resolved::Missing,
            },
        );
    };
    if !canonical.starts_with(root) {
        return Err(PreviewError::Outside);
    }
    if canonical.is_dir() {
        return Ok(Resolved::Directory {
            path: canonical,
            slash,
        });
    }
    if canonical.is_file() {
        return Ok(Resolved::File(canonical));
    }
    Ok(Resolved::Missing)
}

/// `/__openmind__/run?src=/app.js&module=1`: the script must be a `.js`/`.mjs` file inside the folder.
fn run_script(root: &Path, query: &str) -> Result<Resolved, PreviewError> {
    let mut src = None;
    let mut module = false;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        match key {
            "src" => src = percent_decode(&value.replace('+', " ")),
            "module" => module = value == "1",
            _ => {}
        }
    }
    let src = src.ok_or(PreviewError::Outside)?;
    if !src.starts_with('/') {
        return Err(PreviewError::Outside);
    }
    match resolve_path(root, &src)? {
        Resolved::File(path) if is_script(&path) => Ok(Resolved::RunScript { src, module }),
        Resolved::File(_) => Err(PreviewError::Outside),
        _ => Ok(Resolved::Missing),
    }
}

fn is_script(path: &Path) -> bool {
    path.extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
        .is_some_and(|ext| ext == "js" || ext == "mjs")
}

/// `%XX` decoding into UTF-8; `None` for a malformed escape or invalid UTF-8.
pub(crate) fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = text.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The address of `file` inside `root` (`/sub dir/index.html`, percent-encoded).
pub fn address_of(root: &Path, file: &Path) -> Result<String, PreviewError> {
    let relative = file.strip_prefix(root).map_err(|_| PreviewError::Outside)?;
    let mut address = String::new();
    for part in relative.components() {
        address.push('/');
        address.push_str(&percent_encode(&part.as_os_str().to_string_lossy()));
    }
    if address.is_empty() {
        address.push('/');
    }
    Ok(address)
}

pub(crate) fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~!$'()*,;=@".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("my site");
        std::fs::create_dir_all(root.join("css")).unwrap();
        std::fs::write(root.join("index.html"), "<p>hi</p>").unwrap();
        std::fs::write(root.join("css/site.css"), "p{}").unwrap();
        std::fs::write(root.join("app.js"), "console.log(1)").unwrap();
        std::fs::write(dir.path().join("secret.txt"), "no").unwrap();
        std::fs::create_dir_all(dir.path().join("my site-2")).unwrap();
        std::fs::write(dir.path().join("my site-2/x.txt"), "no").unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        (dir, root)
    }

    #[test]
    fn files_and_folders_inside_resolve_and_query_strings_are_ignored() {
        let (_dir, root) = folder();
        assert_eq!(
            resolve_path(&root, "/css/site.css?v=2").unwrap(),
            Resolved::File(root.join("css").join("site.css"))
        );
        assert_eq!(
            resolve_path(&root, "/css").unwrap(),
            Resolved::Directory {
                path: root.join("css"),
                slash: false
            }
        );
        assert_eq!(
            resolve_path(&root, "/").unwrap(),
            Resolved::Directory {
                path: root.clone(),
                slash: true
            }
        );
        assert_eq!(resolve_path(&root, "/nope.png").unwrap(), Resolved::Missing);
    }

    #[test]
    fn every_way_out_of_the_folder_is_refused() {
        let (_dir, root) = folder();
        for target in [
            "/../secret.txt",
            "/css/../../secret.txt",
            "/%2e%2e/secret.txt",
            "/..%5csecret.txt",
            "/C:/Windows/win.ini",
            "/a%00b",
            "/%zz",
        ] {
            assert!(
                resolve_path(&root, target).is_err(),
                "{target} must be refused"
            );
        }
        // A sibling folder that shares the name's beginning is not inside.
        assert!(resolve_path(&root, "/../my site-2/x.txt").is_err());
    }

    #[test]
    fn the_bridge_and_script_pages_have_their_own_addresses() {
        let (_dir, root) = folder();
        assert_eq!(resolve_path(&root, BRIDGE_PATH).unwrap(), Resolved::Bridge);
        assert_eq!(
            resolve_path(&root, &format!("{RUN_SCRIPT_PATH}?src=%2Fapp.js&module=1")).unwrap(),
            Resolved::RunScript {
                src: "/app.js".into(),
                module: true
            }
        );
        assert!(resolve_path(&root, &format!("{RUN_SCRIPT_PATH}?src=%2Findex.html")).is_err());
        assert!(resolve_path(&root, &format!("{RUN_SCRIPT_PATH}?src=%2F..%2Fsecret.txt")).is_err());
        assert!(resolve_path(&root, RUN_SCRIPT_PATH).is_err());
    }

    #[test]
    fn addresses_are_encoded_and_relative_to_the_folder() {
        let (_dir, root) = folder();
        assert_eq!(
            address_of(&root, &root.join("sub dir").join("a#b.html")).unwrap(),
            "/sub%20dir/a%23b.html"
        );
        assert_eq!(address_of(&root, &root).unwrap(), "/");
        assert!(address_of(&root, Path::new("C:/elsewhere/x.html")).is_err());
        assert_eq!(
            percent_decode("/sub%20dir/a%23b.html").unwrap(),
            "/sub dir/a#b.html"
        );
    }
}
