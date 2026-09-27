// Shared by `build.rs` (through `include!`) and the crate's tests (through `#[path]`), so the tests check exactly
// what the build script tells Cargo.

/// The `cargo:rerun-if-changed` lines for a migrations folder: the folder itself (Cargo then notices a file that is
/// added or removed) and every `.sql` file in it, sorted so the output is stable.
pub fn rerun_if_changed_lines(crate_dir: &std::path::Path) -> Vec<String> {
    let mut lines = vec!["cargo:rerun-if-changed=migrations".to_string()];
    let mut files: Vec<String> = std::fs::read_dir(crate_dir.join("migrations"))
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| name.ends_with(".sql"))
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    lines.extend(
        files
            .into_iter()
            .map(|name| format!("cargo:rerun-if-changed=migrations/{name}")),
    );
    lines
}
