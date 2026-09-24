use std::path::Path;

use crate::encoding::{self, TextEncoding};
use crate::error::FsError;
use crate::line_ending::{self, LineEnding};

pub struct ReadTextFileResult {
    pub content: String,
    pub encoding: TextEncoding,
    pub line_ending: LineEnding,
}

pub async fn read_text_file(path: &Path) -> Result<ReadTextFileResult, FsError> {
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|source| FsError::Read {
            path: path.to_path_buf(),
            source,
        })?;

    let decoded = encoding::decode(&bytes);
    let line_ending = line_ending::detect(&decoded.text);

    Ok(ReadTextFileResult {
        content: decoded.text,
        encoding: decoded.encoding,
        line_ending,
    })
}

pub async fn write_text_file(
    path: &Path,
    content: &str,
    encoding: TextEncoding,
) -> Result<(), FsError> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|source| FsError::CreateDir {
                path: parent.to_path_buf(),
                source,
            })?;
    }

    let bytes = encoding::encode(content, encoding);
    tokio::fs::write(path, bytes)
        .await
        .map_err(|source| FsError::Write {
            path: path.to_path_buf(),
            source,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn writes_then_reads_back_utf8() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("note.txt");

        write_text_file(&path, "hello\nworld\n", TextEncoding::Utf8)
            .await
            .expect("write");
        let result = read_text_file(&path).await.expect("read");

        assert_eq!(result.content, "hello\nworld\n");
        assert_eq!(result.encoding, TextEncoding::Utf8);
        assert_eq!(result.line_ending, LineEnding::Lf);
    }

    #[tokio::test]
    async fn writes_then_reads_back_utf16le_with_crlf() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("note.txt");

        write_text_file(&path, "hello\r\nworld\r\n", TextEncoding::Utf16Le)
            .await
            .expect("write");
        let result = read_text_file(&path).await.expect("read");

        assert_eq!(result.content, "hello\r\nworld\r\n");
        assert_eq!(result.encoding, TextEncoding::Utf16Le);
        assert_eq!(result.line_ending, LineEnding::Crlf);
    }

    #[tokio::test]
    async fn mixed_line_endings_are_reported_and_the_text_is_not_normalized() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("mixed.txt");
        let original = b"one\r\ntwo\nthree\r\nfour\n";
        std::fs::write(&path, original).expect("seed");

        let result = read_text_file(&path).await.expect("read");

        assert_eq!(result.line_ending, LineEnding::Mixed);
        assert_eq!(result.content, "one\r\ntwo\nthree\r\nfour\n");
        // Reading never touches the file.
        assert_eq!(std::fs::read(&path).expect("bytes"), original);
        // Writing the same text back reproduces the original bytes exactly.
        write_text_file(&path, &result.content, result.encoding)
            .await
            .expect("write");
        assert_eq!(std::fs::read(&path).expect("bytes"), original);
    }

    #[tokio::test]
    async fn creates_parent_directories_on_write() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("nested").join("deep").join("note.txt");

        write_text_file(&path, "content", TextEncoding::Utf8)
            .await
            .expect("write");

        assert!(path.exists());
    }

    #[tokio::test]
    async fn read_missing_file_returns_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("missing.txt");

        let result = read_text_file(&path).await;

        assert!(matches!(result, Err(FsError::Read { .. })));
    }
}
