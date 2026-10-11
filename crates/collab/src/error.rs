use crate::authz::Denied;

/// Every way a collaboration operation can fail. Messages never contain secrets (codes, keys, proofs).
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CollabError {
    #[error("The operating system's random number generator failed: {0}")]
    Random(String),
    #[error("Not a valid {what}: {reason}")]
    Invalid { what: &'static str, reason: String },
    #[error("The signature doesn't match the peer's public key.")]
    BadSignature,
    #[error("Not allowed: {0}")]
    Denied(Denied),
    #[error("The path is not safe to use: {0}")]
    UnsafePath(String),
    #[error("This file isn't shared in the room.")]
    UnknownFile,
}

impl From<Denied> for CollabError {
    fn from(denied: Denied) -> Self {
        CollabError::Denied(denied)
    }
}

pub(crate) fn invalid(what: &'static str, reason: impl Into<String>) -> CollabError {
    CollabError::Invalid {
        what,
        reason: reason.into(),
    }
}
