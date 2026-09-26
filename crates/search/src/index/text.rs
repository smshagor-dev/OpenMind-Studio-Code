/// What reading a file for the index found.
pub enum Content {
    Text(String),
    Binary,
}

/// UTF-16 text is full of NUL bytes but isn't binary; its BOM says so.
fn is_utf16_text(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF])
}

/// Decides text or binary (the same NUL heuristic as the editor's open check) and decodes text.
pub fn classify(bytes: &[u8]) -> Content {
    if openmind_fs::looks_binary(bytes) && !is_utf16_text(bytes) {
        return Content::Binary;
    }
    Content::Text(openmind_fs::encoding::decode(bytes).text)
}

/// A language id (Monaco's names) for an extension, when the index knows one.
pub fn language_of(extension: &str) -> Option<&'static str> {
    Some(match extension.to_ascii_lowercase().as_str() {
        "ts" | "tsx" | "mts" | "cts" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "py" | "pyw" => "python",
        "php" => "php",
        "rs" => "rust",
        "md" | "markdown" => "markdown",
        "json" | "jsonc" => "json",
        "html" | "htm" => "html",
        "css" | "scss" | "less" => "css",
        "go" => "go",
        "java" => "java",
        "c" | "h" => "c",
        "cpp" | "cc" | "hpp" => "cpp",
        "cs" => "csharp",
        "rb" => "ruby",
        "sh" | "bash" => "shell",
        "yml" | "yaml" => "yaml",
        "toml" => "toml",
        "sql" => "sql",
        "xml" => "xml",
        "txt" => "plaintext",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nul_bytes_mean_binary_but_utf16_with_a_bom_is_text() {
        assert!(matches!(classify(b"MZ\0\0binary"), Content::Binary));
        assert!(matches!(classify(b"plain text"), Content::Text(_)));
        let utf16 = [0xFF, 0xFE, b'h', 0, b'i', 0];
        assert!(matches!(classify(&utf16), Content::Text(text) if text == "hi"));
    }

    #[test]
    fn languages_by_extension() {
        assert_eq!(language_of("TS"), Some("typescript"));
        assert_eq!(language_of("php"), Some("php"));
        assert_eq!(language_of("weird"), None);
    }
}
