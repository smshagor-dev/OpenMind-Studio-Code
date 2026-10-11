//! The one TLS client configuration of collaboration networking (the signaling relay over `wss://` and TURN over
//! TLS): rustls with the `ring` provider, the webpki roots plus Windows' certificate store, safe protocol versions,
//! full certificate and host name verification. There is no switch that turns verification off. Tests may add a
//! root of their own (a local test CA); nothing a room or a peer sends can change this configuration.

use std::sync::Arc;

use rustls::RootCertStore;

use crate::error::NetError;

pub(crate) fn client_config(
    extra_roots: Option<&RootCertStore>,
) -> Result<Arc<rustls::ClientConfig>, NetError> {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    for cert in rustls_native_certs::load_native_certs().certs {
        let _ = roots.add(cert);
    }
    if let Some(extra) = extra_roots {
        roots.extend(extra.roots.iter().cloned());
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| NetError::Config(e.to_string()))?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Arc::new(config))
}
