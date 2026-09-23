pub mod document_io;
pub mod encoding;
pub mod error;
pub mod line_ending;

pub use document_io::{read_text_file, write_text_file, ReadTextFileResult};
pub use encoding::TextEncoding;
pub use error::FsError;
pub use line_ending::LineEnding;
