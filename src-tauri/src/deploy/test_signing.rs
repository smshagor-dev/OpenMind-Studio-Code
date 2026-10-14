//! Tests only: signatures in the release's format (Tauri's base64 of a minisign signature file) made with a throwaway
//! key generated from a fixed seed, so deployment tests run the app's real verifier (`updates::portable::verify`) — a
//! correct signature, another key's, a tampered file and a signature for another version all go through the same code
//! the release uses. It is not OpenMind's release key and signs nothing outside tests.

use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};

pub struct TestKey {
    key: SigningKey,
    id: [u8; 8],
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

impl TestKey {
    pub fn new(seed: u8) -> Self {
        Self {
            key: SigningKey::from_bytes(&[seed; 32]),
            id: [seed, 1, 2, 3, 4, 5, 6, 7],
        }
    }

    /// The public key as `plugins.updater.pubkey` holds one.
    pub fn public(&self) -> String {
        let mut raw = b"Ed".to_vec();
        raw.extend_from_slice(&self.id);
        raw.extend_from_slice(self.key.verifying_key().as_bytes());
        b64(format!("untrusted comment: test key\n{}\n", b64(&raw)).as_bytes())
    }

    /// A signature of `data` whose trusted comment names `version`, as a release's `.sig` file holds it.
    pub fn sign(&self, data: &[u8], version: &str) -> String {
        let signature = self.key.sign(data).to_bytes();
        let mut raw = b"Ed".to_vec();
        raw.extend_from_slice(&self.id);
        raw.extend_from_slice(&signature);
        let trusted = format!("timestamp:1\tfile:test\tversion:{version}");
        let mut global_input = signature.to_vec();
        global_input.extend_from_slice(trusted.as_bytes());
        let global = self.key.sign(&global_input).to_bytes();
        b64(format!(
            "untrusted comment: test signature\n{}\ntrusted comment: {trusted}\n{}\n",
            b64(&raw),
            b64(&global)
        )
        .as_bytes())
    }

    /// The app's verifier with this key in place of the release key.
    pub fn verifier(&self) -> impl Fn(&[u8], &str, &str) -> Result<(), String> + Sync {
        let public = self.public();
        move |data, signature, version| {
            crate::updates::portable::verify(data, signature, &public, version)
        }
    }
}

#[test]
fn signatures_made_here_pass_the_real_check_and_nothing_else_does() {
    let key = TestKey::new(7);
    let verify = key.verifier();
    let signature = key.sign(b"package", "1.0.3");
    verify(b"package", &signature, "1.0.3").expect("good");
    assert!(verify(b"packagE", &signature, "1.0.3").is_err(), "tampered");
    assert!(
        verify(b"package", &signature, "1.0.4").is_err(),
        "other version"
    );
    let other = TestKey::new(8).sign(b"package", "1.0.3");
    assert!(verify(b"package", &other, "1.0.3").is_err(), "another key");
}
