//! Read-only file previews: what a file is (`kind`), whether and how it may be shown (`inspect`, size limits, binary
//! detection), and safe partial parsers for the Office formats (`docx`, `xlsx`). Everything runs in this process on
//! bytes read from one validated file: no external program, no network, no macro or script is ever run, and nothing
//! is written to disk.

pub mod docx;
pub mod error;
pub mod inspect;
pub mod kind;
pub mod path;
pub mod xlsx;
mod zipsafe;

#[cfg(test)]
mod testutil;

pub use docx::{read_docx, DocxBlock, DocxModel};
pub use error::PreviewError;
pub use inspect::{inspect, read_bytes, read_text, Inspection, TextRead};
pub use kind::PreviewKind;
pub use xlsx::{read_xlsx, SheetModel, XlsxModel};
