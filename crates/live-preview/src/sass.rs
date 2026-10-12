//! SCSS / Sass for the built-in browser: browsers only understand CSS, so a `.scss`/`.sass` file is compiled (by
//! `grass`, in process) when the page asks for it — or when it asks for a missing `name.css` that has a `name.scss` /
//! `name.sass` beside it (the usual "link the compiled file" layout). A compile error becomes a stylesheet that shows
//! the message at the top of the page, so a broken style is never silently unstyled.

use std::path::{Path, PathBuf};

/// `.scss` and `.sass` files.
pub fn is_sass(path: &Path) -> bool {
    path.extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
        .is_some_and(|ext| ext == "scss" || ext == "sass")
}

/// For a missing `name.css`: the `name.scss` (else `name.sass`) beside it, if there is one.
pub fn source_for_css(css: &Path) -> Option<PathBuf> {
    let is_css = css
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("css"));
    if !is_css {
        return None;
    }
    ["scss", "sass"]
        .iter()
        .map(|ext| css.with_extension(ext))
        .find(|candidate| candidate.is_file())
}

/// Compiles `path` (imports resolve from its own folder) into CSS.
pub fn compile(path: &Path) -> Result<String, String> {
    // A canonical Windows path starts with `\\?\`; errors name the file the way the user knows it.
    let plain = path.to_string_lossy();
    let path = Path::new(plain.strip_prefix(r"\\?\").unwrap_or(&plain));
    let mut options = grass::Options::default();
    if let Some(folder) = path.parent() {
        options = options.load_path(folder);
    }
    grass::from_path(path, &options).map_err(|err| err.to_string())
}

/// A stylesheet that shows `message` above the page (and in the stylesheet itself as a comment).
pub fn error_stylesheet(file: &str, message: &str) -> String {
    let text = format!("SCSS error in {file}:\n{message}");
    let comment = text.replace("*/", "* /");
    format!(
        "/* {comment} */\nhtml::before {{ content: {content}; display: block; white-space: pre-wrap; \
         font: 13px/1.4 Consolas, monospace; color: #fff; background: #c62828; padding: 10px 14px; }}\n",
        content = css_string(&text),
    )
}

/// `text` as a CSS string literal (quotes, back slashes and line breaks escaped).
fn css_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\A "),
            '\r' => {}
            ch if ch.is_control() => out.push(' '),
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scss_with_variables_nesting_mixins_and_partials_compiles() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("_vars.scss"), "$brand: #336699;\n").unwrap();
        let main = dir.path().join("site.scss");
        std::fs::write(
            &main,
            "@use 'vars';\n@mixin round($r) { border-radius: $r; }\n\
             .card { color: vars.$brand; .title { @include round(4px); } }\n",
        )
        .unwrap();
        let css = compile(&main).unwrap();
        assert!(
            css.contains(".card {") && css.contains("color: #336699;"),
            "{css}"
        );
        assert!(
            css.contains(".card .title {") && css.contains("border-radius: 4px;"),
            "{css}"
        );
    }

    #[test]
    fn indented_sass_compiles_and_errors_say_where() {
        let dir = tempfile::tempdir().unwrap();
        let sass = dir.path().join("a.sass");
        std::fs::write(&sass, "$c: red\np\n  color: $c\n").unwrap();
        assert!(compile(&sass).unwrap().contains("color: red;"));
        let bad = dir.path().join("bad.scss");
        std::fs::write(&bad, ".x { color: $missing; }\n").unwrap();
        let error = compile(&bad).unwrap_err();
        assert!(error.contains("Undefined variable"), "{error}");
        let canonical = std::fs::canonicalize(&bad).unwrap();
        assert!(!compile(&canonical).unwrap_err().contains(r"\\?\"));
    }

    #[test]
    fn a_missing_css_file_maps_to_its_scss_source() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("style.scss"), "p{}").unwrap();
        assert_eq!(
            source_for_css(&dir.path().join("style.css")),
            Some(dir.path().join("style.scss"))
        );
        assert_eq!(source_for_css(&dir.path().join("other.css")), None);
        assert_eq!(source_for_css(&dir.path().join("style.js")), None);
        assert!(is_sass(Path::new("a/B.SCSS")) && is_sass(Path::new("x.sass")));
        assert!(!is_sass(Path::new("x.css")));
    }

    #[test]
    fn the_error_stylesheet_escapes_the_message() {
        let css = error_stylesheet("a.scss", "bad \"quote\" */ end\nline 2 \\ x");
        assert!(css.contains(r#"bad \"quote\""#));
        assert!(css.contains("\\A line 2 \\\\ x"));
        assert!(!css[2..css.find("*/").unwrap()].contains("*/"));
    }
}
