//! Watches the open workspace folder for changes made outside the editor
//! (Git, a terminal, Composer/npm, another program) and reports them as small,
//! debounced batches. Paths that can't be inside the workspace and folders
//! that are noise (`node_modules`, `.git`, `target`, `dist`, `build`, `vendor`)
//! never reach the caller. The pieces are pure and tested on their own; only
//! [`FileWatcher`] and [`SystemWatcher`] touch the operating system.
//!
//! Live sync: changes to what is installed — the app's `runtimes/`, `tools/`, `language-servers/`, `extensions/`
//! ([`SystemWatcher`]) and a project's `node_modules`/`.venv`/`venv`/`vendor` (the project's own [`FileWatcher`]) — are
//! classified into a [`SyncTopic`] and coalesced into one announcement per topic per burst.

pub mod coalesce;
pub mod debounce;
pub mod event;
pub mod ignore;
pub mod normalize;
pub mod system;
pub mod topics;
pub mod watcher;

pub use coalesce::{Burst, TopicCoalescer};
pub use debounce::{Debouncer, Raw};
pub use event::{ChangeBatch, ChangeKind, FileChange};
pub use ignore::{is_ignored, IGNORED_FOLDERS};
pub use normalize::normalize_event_path;
pub use system::SystemWatcher;
pub use topics::{classify_app, classify_project, SyncTopic, APP_FOLDERS};
pub use watcher::{FileWatcher, TopicSink, WatchError, TOPIC_MAX_WAIT, TOPIC_QUIET};
