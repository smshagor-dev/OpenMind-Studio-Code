//! This profile's collaboration identity: an Ed25519 key created on first use and kept in `editor_settings`
//! encrypted with DPAPI (`secret.rs`). It is per local profile (so per machine in a per-machine portable copy) and
//! unrelated to the machine identity. A stored key that can't be decrypted (another Windows user) is reported and
//! never replaced: replacing it would silently orphan every room this profile hosts.

use openmind_collab::PeerIdentity;
use openmind_db::{Db, EditorSettingsRepository};

use crate::secret;

pub const IDENTITY_KEY: &str = "collab.identity";

pub async fn load_or_create(db: &Db) -> Result<PeerIdentity, String> {
    let repo = EditorSettingsRepository::new(db.pool());
    let stored = repo
        .get(IDENTITY_KEY)
        .await
        .map_err(|err| err.to_string())?;
    if let Some(stored) = stored {
        let text = secret::unprotect(&stored)
            .map_err(|err| format!("The collaboration identity can't be read: {err}"))?;
        let identity = PeerIdentity::from_secret_text(&text).map_err(|err| err.to_string())?;
        if !secret::is_protected(&stored) {
            let protected = secret::protect(&text).map_err(|err| err.to_string())?;
            repo.set(IDENTITY_KEY, &protected)
                .await
                .map_err(|err| err.to_string())?;
        }
        return Ok(identity);
    }
    let identity = PeerIdentity::generate().map_err(|err| err.to_string())?;
    let protected = secret::protect(&identity.secret_text()).map_err(|err| err.to_string())?;
    repo.set(IDENTITY_KEY, &protected)
        .await
        .map_err(|err| err.to_string())?;
    tracing::info!(peer = %identity.peer_id().fingerprint(), "collaboration identity created");
    Ok(identity)
}
