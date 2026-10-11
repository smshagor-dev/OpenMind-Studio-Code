//! OpenMind Studio's collaboration signaling relay (Milestone 24): rendezvous for WebRTC only.
//!
//! It holds in memory, and only while they are in use: topics (derived from a Room Code; never the code), which
//! connection hosts or joined each, and the offers/answers/candidates it is forwarding. It persists nothing —
//! no Room Codes, files, membership, history, audit, CRDT data, permissions or workspace state — and it is not
//! trusted: a participant and the Owner authenticate each other over the encrypted WebRTC connection afterwards,
//! with proofs bound to that connection, so a relay that tampers with signaling only makes the join fail.
//! Established WebRTC sessions don't need the relay; it can restart without disturbing them.

pub mod hub;
pub mod proto;
pub mod server;

pub use hub::{HubCounts, RelayConfig};
pub use proto::{
    ClientMessage, ErrorCode, NegotiationId, RelayMessage, Signal, SignalKind, Slot, Topic,
    SIGNAL_VERSION,
};
pub use server::{Relay, RemoteLookup};
