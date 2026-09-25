use std::fs::File;
use std::io::Read;
use std::path::Path;

use serde::Serialize;

use crate::error::PreviewError;
use crate::kind::{
    detect, is_text_source, size_limit, PreviewKind, MAX_CSV_READ_BYTES, MAX_OPEN_AS_TEXT_BYTES,
};
use crate::path::validate;

/// What is known about a file before any preview is built. Everything comes from the file name, its size and its
/// first bytes; nothing is opened as a document, run or converted.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub kind: PreviewKind,
    /// The file is not text (a NUL in its first bytes, or an image/PDF/Office file).
    pub binary: bool,
    /// Larger than the kind's limit (a CSV is then previewed partially, everything else is refused).
    pub too_large: bool,
    pub limit: u64,
    /// "Open as Text" is safe: text, and small enough for the editor.
    pub text_safe: bool,
}

fn sniff(path: &Path) -> Result<Vec<u8>, PreviewError> {
    let mut head = vec![0u8; 8000];
    let mut file = File::open(path).map_err(|err| PreviewError::Io(err.to_string()))?;
    let read = file
        .read(&mut head)
        .map_err(|err| PreviewError::Io(err.to_string()))?;
    head.truncate(read);
    Ok(head)
}

/// Looks at a file the UI wants to preview.
pub fn inspect(raw: &str) -> Result<Inspection, PreviewError> {
    let path = validate(raw)?;
    let size = std::fs::metadata(&path)
        .map_err(|err| PreviewError::Io(err.to_string()))?
        .len();
    let kind = detect(&path);
    let head = sniff(&path)?;
    let looks_binary = openmind_fs::looks_binary(&head);
    // Images, PDFs and Office files are binary by nature; SVG and the text formats are judged by their bytes.
    let binary = match kind {
        PreviewKind::Pdf | PreviewKind::Docx | PreviewKind::Xlsx => true,
        PreviewKind::Image => !is_text_source(kind, &path),
        _ => looks_binary,
    };
    let limit = size_limit(kind);
    let openable = is_text_source(kind, &path) || kind == PreviewKind::Unsupported;
    let text_safe = openable && !looks_binary && size <= MAX_OPEN_AS_TEXT_BYTES;
    Ok(Inspection {
        path: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        size,
        kind,
        binary,
        too_large: size > limit,
        limit,
        text_safe,
    })
}

/// A file's bytes for the image and PDF viewers, refused above the kind's limit.
pub fn read_bytes(raw: &str) -> Result<Vec<u8>, PreviewError> {
    let info = inspect(raw)?;
    if !matches!(info.kind, PreviewKind::Image | PreviewKind::Pdf) {
        return Err(PreviewError::Malformed(
            "Only images and PDFs are sent to the viewer as bytes.".into(),
        ));
    }
    if info.too_large {
        return Err(PreviewError::TooLarge {
            size: info.size,
            limit: info.limit,
        });
    }
    std::fs::read(&info.path).map_err(|err| PreviewError::Io(err.to_string()))
}

/// The decoded text of a text-format file. A CSV bigger than the cap is cut at the cap (`truncated`); every other
/// kind is refused above its limit and refused when the bytes are binary.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TextRead {
    pub text: String,
    pub truncated: bool,
}

pub fn read_text(raw: &str) -> Result<TextRead, PreviewError> {
    let info = inspect(raw)?;
    if !is_text_source(info.kind, Path::new(&info.path)) {
        return Err(PreviewError::Malformed(
            "This file isn't a text format.".into(),
        ));
    }
    if info.binary {
        return Err(PreviewError::Binary);
    }
    let partial = info.kind == PreviewKind::Csv;
    if info.too_large && !partial {
        return Err(PreviewError::TooLarge {
            size: info.size,
            limit: info.limit,
        });
    }
    let cap = if partial {
        MAX_CSV_READ_BYTES
    } else {
        info.limit
    };
    let mut bytes = Vec::new();
    File::open(&info.path)
        .and_then(|file| file.take(cap).read_to_end(&mut bytes))
        .map_err(|err| PreviewError::Io(err.to_string()))?;
    let mut decoded = openmind_fs::encoding::decode(&bytes).text;
    let truncated = partial && info.size > cap;
    if truncated {
        // The cut may fall inside a line: keep whole lines only, so no half row is shown as a row.
        if let Some(end) = decoded.rfind('\n') {
            decoded.truncate(end + 1);
        }
    }
    Ok(TextRead {
        text: decoded,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &tempfile::TempDir, name: &str, bytes: &[u8]) -> String {
        let path = dir.path().join(name);
        std::fs::write(&path, bytes).expect("write");
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn kinds_binary_flags_and_text_safety() {
        let dir = tempfile::tempdir().expect("tempdir");
        let md = inspect(&write(&dir, "read me.md", b"# hi")).expect("md");
        assert_eq!(md.kind, PreviewKind::Markdown);
        assert!(!md.binary && md.text_safe && !md.too_large);
        let png = inspect(&write(&dir, "a.png", b"\x89PNG\0\0")).expect("png");
        assert!(png.binary && !png.text_safe);
        let svg = inspect(&write(&dir, "a.svg", b"<svg/>")).expect("svg");
        assert!(!svg.binary && svg.text_safe);
        let blob = inspect(&write(&dir, "data.bin", b"ab\0cd")).expect("bin");
        assert_eq!(blob.kind, PreviewKind::Unsupported);
        assert!(blob.binary || !blob.text_safe);
        assert!(!blob.text_safe);
        let notes = inspect(&write(&dir, "notes.xyz", b"plain")).expect("xyz");
        assert!(!notes.binary && notes.text_safe);
        let fake_md = inspect(&write(&dir, "fake.md", b"a\0b")).expect("fake");
        assert!(fake_md.binary && !fake_md.text_safe);
    }

    #[test]
    fn limits_refuse_bytes_and_text_but_cut_csv() {
        let dir = tempfile::tempdir().expect("tempdir");
        let big_md = dir.path().join("big.md");
        std::fs::write(&big_md, "a".repeat(6 * 1024 * 1024)).expect("big");
        let info = inspect(&big_md.to_string_lossy()).expect("inspect");
        assert!(info.too_large);
        assert!(matches!(
            read_text(&big_md.to_string_lossy()),
            Err(PreviewError::TooLarge { .. })
        ));
        let big_png = dir.path().join("big.png");
        std::fs::File::create(&big_png)
            .and_then(|f| f.set_len(16 * 1024 * 1024))
            .expect("big");
        assert!(matches!(
            read_bytes(&big_png.to_string_lossy()),
            Err(PreviewError::TooLarge { .. })
        ));
        let csv = dir.path().join("rows.csv");
        let line = "a,b,c\n";
        std::fs::write(&csv, line.repeat(2_000_000)).expect("csv");
        let read = read_text(&csv.to_string_lossy()).expect("csv read");
        assert!(read.truncated);
        assert!(read.text.ends_with('\n'));
        assert!(read.text.len() as u64 <= MAX_CSV_READ_BYTES);
    }

    #[test]
    fn binary_text_and_wrong_kind_reads_are_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = write(&dir, "fake.md", b"a\0b");
        assert!(matches!(read_text(&fake), Err(PreviewError::Binary)));
        let pdf = write(&dir, "a.pdf", b"%PDF-1.4");
        assert!(read_text(&pdf).is_err());
        assert_eq!(read_bytes(&pdf).expect("pdf bytes"), b"%PDF-1.4");
        let docx = write(&dir, "a.docx", b"PK");
        assert!(read_bytes(&docx).is_err());
    }
}
