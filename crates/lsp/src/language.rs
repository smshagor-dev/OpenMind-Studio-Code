//! Which language a file is, by name or extension. The id is what a language
//! server expects in `textDocument/didOpen` (`typescriptreact` is not
//! `typescript`: it tells the TypeScript server to parse JSX).

/// The LSP language id of `path`, or `None` for a file no server handles.
pub fn language_id(path: &str) -> Option<&'static str> {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let lower = name.to_ascii_lowercase();
    if lower == "dockerfile" || lower == "containerfile" || lower.starts_with("dockerfile.") {
        return Some("dockerfile");
    }
    let ext = lower.rsplit_once('.')?.1;
    Some(match ext {
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
        "yaml" | "yml" => "yaml",
        "sh" | "bash" => "shellscript",
        "dockerfile" => "dockerfile",
        "rs" => "rust",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" | "hh" | "hxx" => "cpp",
        "f" | "for" | "f90" | "f95" | "f03" | "f08" => "fortran",
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
        assert_eq!(language_id(".github/ci.YML"), Some("yaml"));
        assert_eq!(language_id("build.sh"), Some("shellscript"));
        assert_eq!(language_id("src/main.rs"), Some("rust"));
        assert_eq!(language_id("x.h"), Some("c"));
        assert_eq!(language_id("x.hpp"), Some("cpp"));
        assert_eq!(language_id("solver.F90"), Some("fortran"));
    }

    #[test]
    fn dockerfiles_are_found_by_their_whole_name() {
        assert_eq!(language_id("C:/My App/Dockerfile"), Some("dockerfile"));
        assert_eq!(language_id("api/Dockerfile.prod"), Some("dockerfile"));
        assert_eq!(language_id("Containerfile"), Some("dockerfile"));
        assert_eq!(language_id("web.dockerfile"), Some("dockerfile"));
    }

    #[test]
    fn unknown_or_extensionless_files_have_no_language() {
        assert_eq!(language_id("README"), None);
        assert_eq!(language_id("notes.txt"), None);
        assert_eq!(language_id("dir.d/file"), None);
    }
}
