use std::path::Path;

use serde::{Deserialize, Serialize};

/// What a file is previewed as, decided by its extension only (never by running or opening anything).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PreviewKind {
    Image,
    Pdf,
    Docx,
    Xlsx,
    Csv,
    Markdown,
    Html,
    Latex,
    Unsupported,
}

pub const MAX_IMAGE_BYTES: u64 = 15 * 1024 * 1024;
pub const MAX_PDF_BYTES: u64 = 30 * 1024 * 1024;
pub const MAX_OFFICE_BYTES: u64 = 25 * 1024 * 1024;
/// A CSV larger than this is previewed from its first bytes only (never refused, never fully loaded).
pub const MAX_CSV_READ_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_MARKUP_BYTES: u64 = 5 * 1024 * 1024;
/// The largest file "Open as Text" is offered for.
pub const MAX_OPEN_AS_TEXT_BYTES: u64 = 10 * 1024 * 1024;

/// The preview kind for a file name.
pub fn detect(path: &Path) -> PreviewKind {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match extension.as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "svg" => PreviewKind::Image,
        "pdf" => PreviewKind::Pdf,
        "docx" => PreviewKind::Docx,
        "xlsx" => PreviewKind::Xlsx,
        "csv" => PreviewKind::Csv,
        "md" | "markdown" => PreviewKind::Markdown,
        "html" | "htm" => PreviewKind::Html,
        "tex" => PreviewKind::Latex,
        _ => PreviewKind::Unsupported,
    }
}

/// True for the kinds whose file is text, so "Open as Text" makes sense (SVG is text too).
pub fn is_text_source(kind: PreviewKind, path: &Path) -> bool {
    match kind {
        PreviewKind::Csv | PreviewKind::Markdown | PreviewKind::Html | PreviewKind::Latex => true,
        PreviewKind::Image => path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("svg")),
        _ => false,
    }
}

/// The size above which a kind is refused (or, for CSV, cut short).
pub fn size_limit(kind: PreviewKind) -> u64 {
    match kind {
        PreviewKind::Image => MAX_IMAGE_BYTES,
        PreviewKind::Pdf => MAX_PDF_BYTES,
        PreviewKind::Docx | PreviewKind::Xlsx => MAX_OFFICE_BYTES,
        PreviewKind::Csv => MAX_CSV_READ_BYTES,
        PreviewKind::Markdown | PreviewKind::Html | PreviewKind::Latex => MAX_MARKUP_BYTES,
        PreviewKind::Unsupported => MAX_OPEN_AS_TEXT_BYTES,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extensions_route_to_kinds_case_insensitively() {
        for (name, kind) in [
            ("a.PNG", PreviewKind::Image),
            ("a.svg", PreviewKind::Image),
            ("a.pdf", PreviewKind::Pdf),
            ("a.docx", PreviewKind::Docx),
            ("a.xlsx", PreviewKind::Xlsx),
            ("a.CSV", PreviewKind::Csv),
            ("a.markdown", PreviewKind::Markdown),
            ("a.htm", PreviewKind::Html),
            ("a.tex", PreviewKind::Latex),
            ("a.exe", PreviewKind::Unsupported),
            ("README", PreviewKind::Unsupported),
            ("a.docm", PreviewKind::Unsupported),
        ] {
            assert_eq!(detect(Path::new(name)), kind, "{name}");
        }
    }

    #[test]
    fn only_text_formats_offer_open_as_text() {
        assert!(is_text_source(PreviewKind::Markdown, Path::new("a.md")));
        assert!(is_text_source(PreviewKind::Image, Path::new("a.svg")));
        assert!(!is_text_source(PreviewKind::Image, Path::new("a.png")));
        assert!(!is_text_source(PreviewKind::Pdf, Path::new("a.pdf")));
    }

    #[test]
    fn every_kind_has_a_limit() {
        assert!(size_limit(PreviewKind::Pdf) > size_limit(PreviewKind::Image));
        assert!(size_limit(PreviewKind::Markdown) < size_limit(PreviewKind::Docx));
    }
}
