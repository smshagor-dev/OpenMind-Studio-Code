//! OpenMind Studio's collaboration networking (Milestone 24, phase 4).
//!
//! Topology: an Owner-authoritative star — each participant has one WebRTC connection to the room's Owner, never to
//! another participant. This crate moves bytes and reports connection states; it decides nothing. Authentication,
//! roles, permissions, the audit chain, persistence and file access stay in `openmind-collab` and the app: the Owner
//! side hands every validated frame to an [`owner::OwnerAuthority`], which runs the central `authorize` before
//! anything changes.
//!
//! Layers (each behind a trait in [`transport`], so implementations can change without touching the protocol):
//! - rendezvous: [`signaling`] (WebSocket to the stateless relay, through the app's HTTP proxy when one is set);
//! - local network: [`lan`] (mDNS and broadcast discovery, the Owner's embedded rendezvous, interface choice) and
//!   [`route`] (a participant tries the local network first, then the Internet relay);
//! - candidates: [`stun`] (host + STUN server-reflexive) and [`relay`] (TURN over UDP, TCP or TLS, via [`turn`]; a
//!   fallback ICE only uses when no direct path works);
//! - the connection: [`peer`] (`str0m`, four logical data channels);
//! - sessions: [`gate`] (frame validation and replay protection), [`owner`] and [`participant`].

pub mod error;
pub mod files;
pub mod gate;
pub mod ice;
pub mod lan;
pub mod owner;
pub mod participant;
pub mod peer;
pub mod relay;
pub mod remote;
pub mod route;
pub mod signaling;
pub mod state;
pub mod stun;
pub mod transport;
pub mod turn;

mod tls;

pub use error::NetError;
pub use state::{ConnectionRoute, ConnectionState};
