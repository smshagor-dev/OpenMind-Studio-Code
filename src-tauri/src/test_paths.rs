//! Test-only path helpers.

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};

/// The 8.3 short spelling of an existing folder or file (`C:\Users\RUNNER~1\...`), as Windows reports it, when it differs
/// from the long one. `None` when the volume doesn't create short names (then the long and short spellings are the same
/// and there is nothing to compare). The paths these tests pass are plain ASCII, so cmd's code page doesn't matter.
pub fn short_spelling(path: &Path) -> Option<PathBuf> {
    let output = std::process::Command::new("cmd")
        .raw_arg(format!(
            "/d /c for %I in (\"{}\") do @echo %~sI",
            path.display()
        ))
        .output()
        .ok()?;
    let short = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let long = path.to_string_lossy();
    (output.status.success() && !short.is_empty() && !short.eq_ignore_ascii_case(&long))
        .then(|| PathBuf::from(short))
}
