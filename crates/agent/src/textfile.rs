//! Text files as the agent sees and changes them. The model always works with `\n` line breaks; a file written back
//! keeps its own encoding (UTF-8, UTF-8 with BOM, UTF-16, Windows-1252) and its CRLF line endings, so an edit changes
//! only the lines it meant to. Writes go through a temporary file and a rename.

use std::fs;
use std::io::{Read, Write};
use std::path::Path;

use openmind_fs::encoding::{decode, encode, TextEncoding};
use openmind_fs::line_ending::{detect, LineEnding};

/// The agent reads files up to this size.
pub const MAX_TEXT_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextFile {
    /// The content with `\n` line breaks.
    pub text: String,
    pub encoding: TextEncoding,
    pub line_ending: LineEnding,
}

impl TextFile {
    /// A new file: UTF-8, the line breaks of this platform's convention for new text (`\n`).
    pub fn new_file() -> Self {
        Self {
            text: String::new(),
            encoding: TextEncoding::Utf8,
            line_ending: LineEnding::Lf,
        }
    }
}

pub fn read(path: &Path) -> Result<TextFile, String> {
    let meta = fs::metadata(path).map_err(|_| format!("{} does not exist.", path.display()))?;
    if meta.is_dir() {
        return Err("That is a folder; use list_dir to see what is in it.".into());
    }
    if meta.len() > MAX_TEXT_BYTES {
        return Err(format!(
            "The file is {} MB, too big to read whole. Use search to find the part you need.",
            meta.len() / (1024 * 1024)
        ));
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|mut f| f.read_to_end(&mut bytes))
        .map_err(|err| format!("The file can't be read: {err}"))?;
    let head = &bytes[..bytes.len().min(8000)];
    let utf16 = head.starts_with(&[0xFF, 0xFE]) || head.starts_with(&[0xFE, 0xFF]);
    if !utf16 && openmind_fs::looks_binary(head) {
        return Err("This is a binary file, not text; the agent can't read or edit it.".into());
    }
    let decoded = decode(&bytes);
    let line_ending = detect(&decoded.text);
    let text = decoded.text.replace("\r\n", "\n");
    Ok(TextFile {
        text,
        encoding: decoded.encoding,
        line_ending,
    })
}

/// Writes `text` (with `\n` breaks) in the encoding and line endings of `like`.
pub fn write(path: &Path, text: &str, like: &TextFile) -> Result<(), String> {
    write_bytes(path, &encoded_bytes(text, like))
}

pub fn encoded_bytes(text: &str, like: &TextFile) -> Vec<u8> {
    let body = if like.line_ending == LineEnding::Crlf {
        text.replace("\r\n", "\n").replace('\n', "\r\n")
    } else {
        text.to_string()
    };
    encode(&body, like.encoding)
}

/// Exclusively creates a random temporary file; never follows a project-supplied temporary symlink.
pub fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("The folder can't be created: {err}"))?;
    }
    let parent = path.parent().ok_or("The file has no parent folder.")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    if let Ok(meta) = fs::metadata(path) {
        temp.as_file()
            .set_permissions(meta.permissions())
            .map_err(|e| e.to_string())?;
    }
    temp.write_all(bytes)
        .and_then(|()| temp.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    temp.persist(path)
        .map(|_| ())
        .map_err(|e| format!("The file can't be replaced: {}", e.error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crlf_files_stay_crlf_after_an_edit() {
        let dir = tempfile::tempdir().expect("tmp");
        let path = dir.path().join("a.txt");
        fs::write(&path, "one\r\ntwo\r\n").expect("write");
        let file = read(&path).expect("read");
        assert_eq!(file.text, "one\ntwo\n");
        assert_eq!(file.line_ending, LineEnding::Crlf);
        write(&path, &file.text.replace("two", "2"), &file).expect("write");
        assert_eq!(fs::read(&path).expect("read"), b"one\r\n2\r\n");
    }

    #[test]
    fn utf8_with_bom_keeps_its_bom() {
        let dir = tempfile::tempdir().expect("tmp");
        let path = dir.path().join("b.cs");
        fs::write(&path, b"\xEF\xBB\xBFclass A {}\n").expect("write");
        let file = read(&path).expect("read");
        write(&path, "class B {}\n", &file).expect("write");
        assert!(fs::read(&path)
            .expect("read")
            .starts_with(b"\xEF\xBB\xBFclass B"));
    }

    #[test]
    fn binary_files_and_folders_are_refused() {
        let dir = tempfile::tempdir().expect("tmp");
        let bin = dir.path().join("x.bin");
        fs::write(&bin, [0u8, 1, 2, 0, 4]).expect("write");
        assert!(read(&bin).unwrap_err().contains("binary"));
        assert!(read(dir.path()).unwrap_err().contains("folder"));
        assert!(read(&dir.path().join("missing"))
            .unwrap_err()
            .contains("does not exist"));
    }

    #[test]
    fn new_files_get_their_folders() {
        let dir = tempfile::tempdir().expect("tmp");
        let path = dir.path().join("src/deep/new.ts");
        write(&path, "export {};\n", &TextFile::new_file()).expect("write");
        assert_eq!(fs::read_to_string(&path).expect("read"), "export {};\n");
        assert!(!dir
            .path()
            .join("src/deep/new.ts.openmind-agent.tmp")
            .exists());
    }
}

#[cfg(all(test, unix))]
mod safety_tests {
    use super::*;
    #[test]
    fn predictable_temporary_symlink_is_never_opened() {
        let dir = tempfile::tempdir().expect("tmp");
        let outside = dir.path().join("outside");
        fs::write(&outside, b"keep").expect("outside");
        let path = dir.path().join("a.txt");
        let trap = dir.path().join("a.txt.openmind-agent.tmp");
        std::os::unix::fs::symlink(&outside, &trap).expect("link");
        write(&path, "new", &TextFile::new_file()).expect("write");
        assert_eq!(fs::read(&outside).expect("outside"), b"keep");
        assert_eq!(fs::read(&path).expect("file"), b"new");
        assert!(!fs::symlink_metadata(path)
            .expect("meta")
            .file_type()
            .is_symlink());
    }
}
