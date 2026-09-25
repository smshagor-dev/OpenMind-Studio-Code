//! Reading Office files (ZIP containers) without ever extracting anything to disk: only the few known parts are
//! read, into memory, with a hard size cap that holds whatever the archive declares (a "zip bomb" can't inflate past it).

use std::fs::File;
use std::io::Read;

use zip::ZipArchive;

use crate::error::PreviewError;
use crate::kind::MAX_OFFICE_BYTES;
use crate::path::validate;

/// Entries an Office file may hold before it is refused as malformed.
const MAX_ENTRIES: usize = 20_000;
/// The largest single XML part that is read.
pub const MAX_PART_BYTES: u64 = 40 * 1024 * 1024;

pub type Archive = ZipArchive<File>;

/// Opens an Office file: a regular file, not larger than the Office limit, a valid ZIP with a sane entry count.
pub fn open(raw: &str) -> Result<Archive, PreviewError> {
    let path = validate(raw)?;
    let size = std::fs::metadata(&path)
        .map_err(|err| PreviewError::Io(err.to_string()))?
        .len();
    if size > MAX_OFFICE_BYTES {
        return Err(PreviewError::TooLarge {
            size,
            limit: MAX_OFFICE_BYTES,
        });
    }
    let file = File::open(&path).map_err(|err| PreviewError::Io(err.to_string()))?;
    let archive = ZipArchive::new(file).map_err(|_| {
        PreviewError::Malformed(
            "This isn't a valid Office file (it is not a ZIP container).".into(),
        )
    })?;
    if archive.len() > MAX_ENTRIES {
        return Err(PreviewError::Malformed(
            "This Office file has too many parts to preview safely.".into(),
        ));
    }
    Ok(archive)
}

/// The text of one part, or `None` when the archive has no such part.
pub fn read_part(archive: &mut Archive, name: &str) -> Result<Option<String>, PreviewError> {
    let entry = match archive.by_name(name) {
        Ok(entry) => entry,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(_) => {
            return Err(PreviewError::Malformed(format!(
                "The part {name} can't be read (the file is damaged or encrypted)."
            )))
        }
    };
    let mut bytes = Vec::new();
    entry
        .take(MAX_PART_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| {
            PreviewError::Malformed(format!(
                "The part {name} can't be read (the file is damaged)."
            ))
        })?;
    if bytes.len() as u64 > MAX_PART_BYTES {
        return Err(PreviewError::Malformed(format!(
            "The part {name} is too large to preview safely."
        )));
    }
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

pub fn has_part(archive: &mut Archive, name: &str) -> bool {
    archive.by_name(name).is_ok()
}

/// Parses XML with DTDs refused (no entity tricks) and a node cap.
pub fn parse_xml(text: &str) -> Result<roxmltree::Document<'_>, PreviewError> {
    let options = roxmltree::ParsingOptions {
        allow_dtd: false,
        nodes_limit: 4_000_000,
        ..roxmltree::ParsingOptions::default()
    };
    roxmltree::Document::parse_with_options(text, options)
        .map_err(|err| PreviewError::Malformed(format!("The document XML is malformed: {err}")))
}

/// An attribute by its local name, whatever its namespace prefix.
pub fn attr<'a>(node: roxmltree::Node<'a, '_>, name: &str) -> Option<&'a str> {
    node.attributes()
        .find(|attribute| attribute.name() == name)
        .map(|attribute| attribute.value())
}
