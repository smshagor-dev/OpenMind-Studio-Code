//! OpenMind Studio's collaboration core (Milestone 24): everything the Room Owner's authority decides, as plain data
//! and pure functions. No networking (that is `openmind-collab-net`), no database (that is `openmind-db`'s collab
//! repositories), no Tauri — so the same code can later run in a dedicated Rust sidecar without a protocol change.
//!
//! The trust model in one paragraph: a peer is the SHA-256 of its Ed25519 public key ([`identity`]); a Room Code is
//! an invitation credential with 110 random bits ([`code`]) from which the stored hash, the join-proof key and the
//! signaling topic are derived separately; a remote peer's role and permissions are never read from what it sends —
//! [`authz::authorize`] looks them up in the Owner's [`room::RoomState`] for the peer the session was authenticated
//! as ([`authority`]); every frame is versioned, size-checked and replay-checked ([`protocol`], [`replay`]); a file
//! is addressed by a [`files::FileId`] the Owner maps to a validated relative path, resolved inside the workspace with
//! link escapes refused ([`workspace`]) and sensitive files never shared ([`privacy`]); the Owner's canonical events
//! form a hash chain it can sign ([`audit`]).

pub mod audit;
pub mod authority;
pub mod authz;
pub mod binding;
pub mod code;
pub mod crdt;
pub mod docs;
pub mod error;
pub mod files;
pub mod fsauth;
mod hmac;
pub mod identity;
pub mod ids;
pub mod manifest;
pub mod netconfig;
pub mod permission;
pub mod presence;
pub mod privacy;
pub mod protocol;
pub mod replay;
pub mod room;
pub mod roomview;
pub mod sfu;
pub mod share;
pub mod sync_chunk;
#[cfg(test)]
mod testkit;
pub mod transfer;
pub mod voice;
pub mod workspace;

pub use authority::{Actor, Authority, Command, JoinOutcome, Outcome};
pub use authz::{authorize, Action, Denied, DenyReason};
pub use code::RoomCode;
pub use error::CollabError;
pub use files::{FileKind, FileTable, RelPath};
pub use identity::{PeerIdentity, PublicKey, Signature};
pub use ids::{FileId, MessageId, PeerId, RoomUid, SessionId, TransferId};
pub use permission::{Overrides, Permission, PermissionSet, Role};
pub use protocol::{Admission, Frame, Handshake, JoinRequest, ReconnectRequest};
pub use room::{Member, MemberStatus, RoomState};
