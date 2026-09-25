//! Local resources for extension webviews. A webview never touches the disk: when its HTML mentions a file
//! (`asWebviewUri`), the application asks for it here and inlines the bytes. Everything is checked on this side
//! too, whatever the host says: the file must be a regular file inside one of the webview's `localResourceRoots`,
//! every root must be allowed for the extension (its own folder is always fine; the open folder needs
//! `workspaceRead`; anything else needs `filesystemOutsideWorkspace`), the file type must be on a short list
//! (no HTML, no executables, no unknown types) and the size is capped. Paths are canonicalized, so `..` and
//! links can't lead out of a root; a directory is never listed.

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::ExtensionError;
use crate::permissions::Permission;

/// The largest file a webview may load.
pub const MAX_RESOURCE_BYTES: u64 = 5 * 1024 * 1024;

/// A file ready to be inlined into a webview.
#[derive(Debug, PartialEq, Eq)]
pub struct Resource {
    pub content_type: &'static str,
    pub bytes: Vec<u8>,
}

/// The content type of a file a webview may load, by extension; `None` for everything else.
pub fn content_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "json" => "application/json",
        "txt" => "text/plain",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => return None,
    })
}

/// Who is asking, for the root checks.
pub struct RootPolicy<'a> {
    /// The extension's own install folder.
    pub extension_dir: &'a Path,
    /// The open folder of the window, if any.
    pub workspace: Option<&'a Path>,
    /// What the user accepted for this extension.
    pub accepted: &'a [Permission],
}

fn missing_permission(permission: Permission) -> ExtensionError {
    ExtensionError::Refused(format!(
        "Permission '{}' is required for this webview resource.",
        permission.name()
    ))
}

/// The canonical form of every root, after checking each one is allowed for the extension.
pub fn allowed_roots(
    policy: &RootPolicy<'_>,
    roots: &[PathBuf],
) -> Result<Vec<PathBuf>, ExtensionError> {
    let own = policy
        .extension_dir
        .canonicalize()
        .map_err(|err| ExtensionError::io("The extension folder isn't there", err))?;
    let workspace = policy.workspace.and_then(|dir| dir.canonicalize().ok());
    let mut allowed = Vec::new();
    for root in roots {
        let canonical = root.canonicalize().map_err(|_| ExtensionError::Path {
            path: root.clone(),
            reason: "this local resource root doesn't exist".into(),
        })?;
        let inside = |base: &Path| canonical.starts_with(base);
        if inside(&own) {
            // free
        } else if workspace.as_deref().is_some_and(inside) {
            if !policy.accepted.contains(&Permission::WorkspaceRead)
                && !policy
                    .accepted
                    .contains(&Permission::FilesystemOutsideWorkspace)
            {
                return Err(missing_permission(Permission::WorkspaceRead));
            }
        } else if !policy
            .accepted
            .contains(&Permission::FilesystemOutsideWorkspace)
        {
            return Err(missing_permission(Permission::FilesystemOutsideWorkspace));
        }
        allowed.push(canonical);
    }
    Ok(allowed)
}

/// Reads `path` if it is a regular file of an allowed type, of at most `MAX_RESOURCE_BYTES`, inside one of
/// `roots` (already canonical, see `allowed_roots`).
pub fn read_resource(roots: &[PathBuf], path: &Path) -> Result<Resource, ExtensionError> {
    let refuse = |reason: &str| ExtensionError::Path {
        path: path.to_path_buf(),
        reason: reason.to_string(),
    };
    let canonical = path
        .canonicalize()
        .map_err(|_| refuse("the file doesn't exist"))?;
    if !roots.iter().any(|root| canonical.starts_with(root)) {
        return Err(refuse("it is outside this webview's local resource roots"));
    }
    let metadata = fs::metadata(&canonical).map_err(|_| refuse("the file can't be read"))?;
    if !metadata.is_file() {
        return Err(refuse("it isn't a file"));
    }
    let Some(content_type) = content_type(&canonical) else {
        return Err(refuse("this file type can't be loaded into a webview"));
    };
    if metadata.len() > MAX_RESOURCE_BYTES {
        return Err(refuse("the file is larger than 5 MB"));
    }
    let bytes =
        fs::read(&canonical).map_err(|err| ExtensionError::io("Couldn't read the file", err))?;
    Ok(Resource {
        content_type,
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Rig {
        _dir: tempfile::TempDir,
        root: PathBuf,
    }

    fn rig() -> Rig {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("Open Mind").to_path_buf();
        fs::create_dir_all(root.join("ext").join("media")).expect("mkdir");
        fs::create_dir_all(root.join("work")).expect("mkdir");
        fs::create_dir_all(root.join("elsewhere")).expect("mkdir");
        fs::write(root.join("ext").join("media").join("logo.png"), b"png").expect("write");
        fs::write(root.join("ext").join("secret.txt"), b"secret").expect("write");
        fs::write(root.join("ext").join("page.html"), b"<p>").expect("write");
        fs::write(root.join("work").join("data.json"), b"{}").expect("write");
        fs::write(root.join("elsewhere").join("x.png"), b"x").expect("write");
        Rig { _dir: dir, root }
    }

    fn policy<'a>(
        ext: &'a Path,
        workspace: &'a Path,
        accepted: &'a [Permission],
    ) -> RootPolicy<'a> {
        RootPolicy {
            extension_dir: ext,
            workspace: Some(workspace),
            accepted,
        }
    }

    #[test]
    fn content_types_are_a_short_list() {
        assert_eq!(content_type(Path::new("a.PNG")), Some("image/png"));
        assert_eq!(content_type(Path::new("a.css")), Some("text/css"));
        assert_eq!(content_type(Path::new("a.woff2")), Some("font/woff2"));
        assert_eq!(content_type(Path::new("a.html")), None);
        assert_eq!(content_type(Path::new("a.exe")), None);
        assert_eq!(content_type(Path::new("noextension")), None);
    }

    #[test]
    fn the_extension_folder_is_a_free_root_and_files_are_read_with_their_type() {
        let r = rig();
        let work = r.root.join("work");
        let ext = r.root.join("ext");
        let p = policy(&ext, &work, &[]);
        let roots = allowed_roots(&p, &[r.root.join("ext").join("media")]).expect("allowed");
        let logo = read_resource(&roots, &r.root.join("ext").join("media").join("logo.png"))
            .expect("read");
        assert_eq!(logo.content_type, "image/png");
        assert_eq!(logo.bytes, b"png");
    }

    #[test]
    fn traversal_outside_the_roots_directories_unknown_types_and_missing_files_are_refused() {
        let r = rig();
        let work = r.root.join("work");
        let ext = r.root.join("ext");
        let p = policy(&ext, &work, &[]);
        let roots = allowed_roots(&p, &[r.root.join("ext").join("media")]).expect("allowed");
        // `..` out of the root, to a real file.
        let traversal = r
            .root
            .join("ext")
            .join("media")
            .join("..")
            .join("secret.txt");
        let err = read_resource(&roots, &traversal).expect_err("outside");
        assert!(err
            .to_string()
            .contains("outside this webview's local resource roots"));
        // A directory, a type that isn't allowed and a missing file.
        assert!(read_resource(&roots, &r.root.join("ext").join("media")).is_err());
        let wide = allowed_roots(&p, &[r.root.join("ext")]).expect("allowed");
        let html = read_resource(&wide, &r.root.join("ext").join("page.html")).expect_err("html");
        assert!(html.to_string().contains("file type can't be loaded"));
        assert!(read_resource(&wide, &r.root.join("ext").join("nope.png"))
            .expect_err("missing")
            .to_string()
            .contains("doesn't exist"));
    }

    #[test]
    fn roots_outside_the_extension_need_their_permission_with_the_documented_message() {
        let r = rig();
        let work = r.root.join("work");
        let ext = r.root.join("ext");
        let none = policy(&ext, &work, &[]);
        let workspace_root = r.root.join("work");
        let elsewhere = r.root.join("elsewhere");
        assert_eq!(
            allowed_roots(&none, std::slice::from_ref(&workspace_root))
                .expect_err("needs workspaceRead")
                .to_string(),
            "Permission 'workspaceRead' is required for this webview resource."
        );
        assert_eq!(
            allowed_roots(&none, std::slice::from_ref(&elsewhere))
                .expect_err("needs outside")
                .to_string(),
            "Permission 'filesystemOutsideWorkspace' is required for this webview resource."
        );
        let read = [Permission::WorkspaceRead];
        let with_read = policy(&ext, &work, &read);
        assert!(allowed_roots(&with_read, &[workspace_root]).is_ok());
        assert!(allowed_roots(&with_read, std::slice::from_ref(&elsewhere)).is_err());
        let outside = [Permission::FilesystemOutsideWorkspace];
        let with_outside = policy(&ext, &work, &outside);
        assert!(allowed_roots(&with_outside, &[elsewhere]).is_ok());
        assert!(allowed_roots(&none, &[r.root.join("missing")]).is_err());
    }

    #[test]
    fn a_file_over_the_size_limit_is_refused() {
        let r = rig();
        let big = r.root.join("ext").join("big.png");
        let file = fs::File::create(&big).expect("create");
        file.set_len(MAX_RESOURCE_BYTES + 1).expect("len");
        let work = r.root.join("work");
        let ext = r.root.join("ext");
        let p = policy(&ext, &work, &[]);
        let roots = allowed_roots(&p, &[r.root.join("ext")]).expect("allowed");
        let err = read_resource(&roots, &big).expect_err("too big");
        assert!(err.to_string().contains("larger than 5 MB"));
    }

    fn roots_for(r: &Rig, sub: &str) -> Vec<PathBuf> {
        let work = r.root.join("work");
        let ext = r.root.join("ext");
        let p = policy(&ext, &work, &[]);
        allowed_roots(&p, &[r.root.join(sub)]).expect("allowed")
    }

    #[test]
    fn a_sibling_folder_sharing_the_root_name_prefix_is_not_inside_it() {
        let r = rig();
        let sibling = r.root.join("ext-other");
        fs::create_dir_all(&sibling).expect("mkdir");
        fs::write(sibling.join("a.png"), b"a").expect("write");
        let roots = roots_for(&r, "ext");
        assert!(read_resource(&roots, &sibling.join("a.png")).is_err());
    }

    #[test]
    fn encoded_traversal_and_backslash_tricks_are_just_missing_names_never_a_way_out() {
        let r = rig();
        let roots = roots_for(&r, "ext");
        let base = r.root.join("ext");
        for name in [
            "%2e%2e/secret.txt",
            "..%2fsecret.txt",
            r"media\..\..\elsewhere\x.png",
        ] {
            let target = base.join(name);
            assert!(read_resource(&roots, &target).is_err(), "{name}");
        }
        // Mixed slashes that really do stay inside the root work (Windows accepts both).
        let mixed = format!(r"{}/media\logo.png", base.display());
        #[cfg(windows)]
        assert!(read_resource(&roots, Path::new(&mixed)).is_ok());
        #[cfg(not(windows))]
        let _ = mixed;
    }

    #[test]
    fn spaces_and_unicode_in_paths_work() {
        let r = rig();
        let dir = r.root.join("ext").join("médias & über");
        fs::create_dir_all(&dir).expect("mkdir");
        fs::write(dir.join("ログ file.png"), b"u").expect("write");
        let roots = roots_for(&r, "ext");
        let read = read_resource(&roots, &dir.join("ログ file.png")).expect("read");
        assert_eq!(read.bytes, b"u");
    }

    #[cfg(windows)]
    #[test]
    fn windows_case_differences_stay_inside_and_stream_or_unc_names_are_refused() {
        let r = rig();
        let roots = roots_for(&r, "ext");
        let upper = r
            .root
            .join("ext")
            .join("media")
            .join("logo.png")
            .to_string_lossy()
            .to_uppercase();
        assert!(read_resource(&roots, Path::new(&upper)).is_ok());
        let stream = r.root.join("ext").join("secret.txt:hidden.png");
        assert!(read_resource(&roots, &stream).is_err());
        assert!(read_resource(&roots, Path::new(r"\\localhost\c$\Windows\win.ini")).is_err());
    }

    /// A link inside an allowed root that points outside it must not be followed out: the canonical target is
    /// what is checked. Skipped where the machine won't create links (Windows without developer mode).
    #[test]
    fn a_link_pointing_out_of_the_root_is_refused() {
        let r = rig();
        let link = r.root.join("ext").join("out.png");
        let target = r.root.join("elsewhere").join("x.png");
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(&target, &link).is_ok();
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&target, &link).is_ok();
        if !made {
            return;
        }
        let roots = roots_for(&r, "ext");
        let err = read_resource(&roots, &link).expect_err("link out");
        assert!(err
            .to_string()
            .contains("outside this webview's local resource roots"));
    }

    #[test]
    fn the_missing_file_error_names_the_file_and_the_reason() {
        let r = rig();
        let roots = roots_for(&r, "ext");
        let err = read_resource(&roots, &r.root.join("ext").join("gone.png")).expect_err("missing");
        let text = err.to_string();
        assert!(
            text.contains("gone.png") && text.contains("doesn't exist"),
            "{text}"
        );
    }
}
