//! Which language a file is, by extension. The id is what a language server
//! expects in `textDocument/didOpen` (`typescriptreact` is not `typescript`:
//! it tells the TypeScript server to parse JSX).

/// The LSP language id of `path`, or `None` for a file no server handles.
pub fn language_id(path: &str) -> Option<&'static str> {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match ext.as_str() {
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "typescriptreact",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "javascriptreact",
        "py" | "pyi" | "pyw" => "python",
        "php" | "phtml" => "php",
        "json" => "json",
        "jsonc" => "jsonc",
        "css" => "css",
        "scss" => "scss",
        "less" => "less",
        "html" | "htm" => "html",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_by_extension_case_insensitively() {
        assert_eq!(language_id("C:/My Site/app.TS"), Some("typescript"));
        assert_eq!(language_id(r"C:\p\view.tsx"), Some("typescriptreact"));
        assert_eq!(language_id("a/b.mjs"), Some("javascript"));
        assert_eq!(language_id("x.jsx"), Some("javascriptreact"));
        assert_eq!(language_id("tool.py"), Some("python"));
        assert_eq!(language_id("index.php"), Some("php"));
        assert_eq!(language_id("package.json"), Some("json"));
        assert_eq!(language_id("a.scss"), Some("scss"));
        assert_eq!(language_id("page.htm"), Some("html"));
    }

    #[test]
    fn unknown_or_extensionless_files_have_no_language() {
        assert_eq!(language_id("README"), None);
        assert_eq!(language_id("notes.txt"), None);
        assert_eq!(language_id("dir.d/file"), None);
    }
}
