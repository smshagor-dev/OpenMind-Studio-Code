use std::path::Path;

use tokio::io::AsyncReadExt;

use crate::error::FsError;

/// How many leading bytes to sniff for the binary-detection heuristic.
const SNIFF_LEN: usize = 8000;

/// The same heuristic on bytes already in memory (the first few KB are
/// enough): a NUL byte means binary. Shared with workspace search so both
/// agree on what "binary" is.
pub fn looks_binary(head: &[u8]) -> bool {
    head[..head.len().min(SNIFF_LEN)].contains(&0)
}

/// Heuristic binary-file detection: a NUL byte in the first few KB is the
/// conventional signal editors (and git) use — text files essentially never
/// contain one. Used before opening a file in the text editor, so a click
/// on an image or executable in the explorer doesn't try to decode it as
/// text.
pub async fn is_binary(path: &Path) -> Result<bool, FsError> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|source| FsError::Read {
            path: path.to_path_buf(),
            source,
        })?;

    let mut buf = vec![0u8; SNIFF_LEN];
    let mut read = 0;
    loop {
        let n = file
            .read(&mut buf[read..])
            .await
            .map_err(|source| FsError::Read {
                path: path.to_path_buf(),
                source,
            })?;
        if n == 0 {
            break;
        }
        read += n;
        if read == buf.len() {
            break;
        }
    }

    Ok(looks_binary(&buf[..read]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn text_file_is_not_binary() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("note.txt");
        std::fs::write(&file, "hello, world\nsecond line\n").expect("write");

        assert!(!is_binary(&file).await.expect("is_binary"));
    }

    #[tokio::test]
    async fn file_with_nul_byte_is_binary() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("image.png");
        std::fs::write(&file, [0x89, 0x50, 0x4E, 0x47, 0x00, 0x0D, 0x0A]).expect("write");

        assert!(is_binary(&file).await.expect("is_binary"));
    }

    #[tokio::test]
    async fn empty_file_is_not_binary() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("empty.txt");
        std::fs::write(&file, []).expect("write");

        assert!(!is_binary(&file).await.expect("is_binary"));
    }
}
