pub mod binary;
pub mod dir_entry;
pub mod document_io;
pub mod encoding;
pub mod error;
pub mod line_ending;
pub mod metadata;
pub mod ops;
pub mod path_safety;

pub use binary::{is_binary, looks_binary};
pub use dir_entry::{read_dir, DirEntryInfo};
pub use document_io::{read_text_file, write_text_file, ReadTextFileResult};
pub use encoding::TextEncoding;
pub use error::FsError;
pub use line_ending::LineEnding;
pub use metadata::{metadata as path_metadata, PathMetadata};
pub use ops::{copy_path, copy_path_as, create_dir, create_file, delete, move_path, rename};
pub use path_safety::{ensure_within_root, normalize_path};
