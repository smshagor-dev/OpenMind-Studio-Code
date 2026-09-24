//! Watches the open workspace folder for changes made outside the editor
//! (Git, a terminal, Composer/npm, another program) and reports them as small,
//! debounced batches. Paths that can't be inside the workspace and folders
//! that are noise (`node_modules`, `.git`, `target`, `dist`, `build`, `vendor`)
//! never reach the caller. The pieces are pure and tested on their own; only
//! [`FileWatcher`] touches the operating system.

pub mod debounce;
pub mod event;
pub mod ignore;
pub mod normalize;
pub mod watcher;

pub use debounce::{Debouncer, Raw};
pub use event::{ChangeBatch, ChangeKind, FileChange};
pub use ignore::{is_ignored, IGNORED_FOLDERS};
pub use normalize::normalize_event_path;
pub use watcher::{FileWatcher, WatchError};
