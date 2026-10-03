//! Names the user types for a new or renamed Explorer entry. Every rule is checked here, in Rust, before anything
//! touches the disk: a name can never reach outside the folder it is created in (`..`, a drive, a root), and names
//! Windows can't store (reserved device names, `<>:"|?*`, a trailing dot or space) are refused with the reason.

use std::path::PathBuf;

use crate::error::FsError;

const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Why one path segment can't be used as a file or folder name, or `None` when it can.
pub fn segment_problem(segment: &str) -> Option<String> {
    if segment.is_empty() {
        return Some("A file or folder name must be provided.".into());
    }
    if segment == "." || segment == ".." {
        return Some(format!("\"{segment}\" is not a valid file or folder name."));
    }
    if let Some(bad) = segment
        .chars()
        .find(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
    {
        let shown = if bad.is_control() {
            "a control character".to_string()
        } else {
            format!("\"{bad}\"")
        };
        return Some(format!(
            "The name \"{segment}\" contains {shown}, which file names can't contain."
        ));
    }
    if segment.ends_with('.') || segment.ends_with(' ') {
        return Some(format!(
            "The name \"{segment}\" can't end with a dot or a space."
        ));
    }
    let stem = segment.split('.').next().unwrap_or(segment).trim_end();
    if RESERVED
        .iter()
        .any(|reserved| reserved.eq_ignore_ascii_case(stem))
    {
        return Some(format!(
            "\"{segment}\" is reserved by Windows and can't be used as a name."
        ));
    }
    if segment.len() > 255 {
        return Some("The name is too long.".into());
    }
    None
}

/// A single name (rename): no folder separators allowed.
pub fn validate_name(name: &str) -> Result<(), FsError> {
    if name.contains(['/', '\\']) {
        return Err(FsError::InvalidName {
            name: name.into(),
            reason: "A name can't contain \"/\" or \"\\\".".into(),
        });
    }
    match segment_problem(name) {
        Some(reason) => Err(FsError::InvalidName {
            name: name.into(),
            reason,
        }),
        None => Ok(()),
    }
}

/// A name that may name sub-folders (`src/components/Button.tsx`, VS Code's New File): its segments, each valid.
/// Leading or doubled separators and absolute paths are refused, so the result is always relative.
pub fn relative_segments(name: &str) -> Result<Vec<String>, FsError> {
    let segments: Vec<&str> = name.split(['/', '\\']).collect();
    for segment in &segments {
        if let Some(reason) = segment_problem(segment) {
            return Err(FsError::InvalidName {
                name: name.into(),
                reason,
            });
        }
    }
    Ok(segments.into_iter().map(str::to_string).collect())
}

/// `segments` joined under `base`.
pub fn join_segments(base: &std::path::Path, segments: &[String]) -> PathBuf {
    segments
        .iter()
        .fold(base.to_path_buf(), |path, segment| path.join(segment))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_names_pass() {
        for name in [
            "main.py",
            "hello world.txt",
            ".gitignore",
            "Привет.md",
            "日本語.ts",
            "a..b",
        ] {
            assert!(validate_name(name).is_ok(), "{name}");
        }
    }

    #[test]
    fn escapes_and_windows_rules_are_refused_with_a_reason() {
        for name in [
            "", ".", "..", "a/b", "..\\x", "a:b", "x?", "con", "NUL.txt", "lpt1", "end.", "end ",
            "a\u{1}",
        ] {
            let err = validate_name(name).expect_err(name);
            assert!(matches!(err, FsError::InvalidName { .. }), "{name}");
            assert!(!err.to_string().is_empty());
        }
    }

    #[test]
    fn nested_names_split_into_valid_segments_and_never_escape() {
        assert_eq!(
            relative_segments("src/components\\Button.tsx").expect("ok"),
            vec!["src", "components", "Button.tsx"]
        );
        for name in [
            "../x",
            "a/../b",
            "/abs",
            "C:/x",
            "a//b",
            "a/",
            "\\\\server\\share",
        ] {
            assert!(relative_segments(name).is_err(), "{name}");
        }
    }
}
