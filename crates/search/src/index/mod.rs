//! The persistent workspace index (Milestone 12): file names, text, symbols. Local only — one SQLite file per
//! workspace under the app's own `data/search-index/`, nothing leaves the machine.

pub mod crawl;
pub mod manager;
pub mod query;
pub mod settings;
pub mod store;
pub mod symbols;
pub mod sync;
pub mod text;

#[cfg(test)]
mod tests;

pub use manager::{IndexEvents, IndexManager, IndexStatus};
pub use query::{file_symbols, search_files, search_symbols, search_text, FileHit, SymbolHit};
pub use settings::{IndexSettings, INDEX_EXCLUDED_DIRS};
pub use store::{IndexStore, StoreStats};
pub use symbols::Symbol;
