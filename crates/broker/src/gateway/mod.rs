//! The local package gateway: a loopback HTTP server that pip, npm, Go and Git in OpenMind's terminals are pointed at
//! (process-local settings only). Everything it fetches goes through the broker and the Download Manager's route. It
//! listens on 127.0.0.1 only, accepts only requests addressed to 127.0.0.1/localhost with its port (so a web page can't
//! reach it through DNS rebinding), and every path on the main port carries a per-run random token.

pub mod credentials;
pub mod fetch;
pub mod git;
pub mod goproxy;
pub mod http1;
mod live;
pub mod npm;
pub mod pypi;
pub mod rustup;
pub mod server;
pub mod tunnel;
pub mod upstream;

pub use server::{Gateway, GatewayConfig};
pub use upstream::{UpRequest, UpResponse, Upstream, UreqUpstream};
