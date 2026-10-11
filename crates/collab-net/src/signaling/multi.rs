//! One Owner, several rendezvous: [`MultiSignaling`] makes the Owner's local-network rendezvous and the Internet relay
//! look like a single signaling link to the Owner loop, so a room is hosted on both with the same authority, sessions
//! and protocol — a route is not a kind of room.
//!
//! - `Host`, `Renew` and `Leave` go to every connected route; each participant's signals go back on the route its
//!   slot arrived on (slots are 128-bit random per relay, so two relays never hand out the same one in practice; a
//!   collision is simply not routed).
//! - The link is up while at least one route is: a route that can't be reached at start (no Internet) or drops later
//!   is retried in the background with backoff and re-registered with the last `Host` message when it comes back. Only
//!   when every route is down does the Owner loop see `Closed` (and reconnect the whole set).
//! - [`SignalingTransport::route_of`] tells the Owner which route a slot came from and, on the local rendezvous, the
//!   participant's address — so its peer connection binds to the interface facing it and gathers no STUN/TURN.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use openmind_collab_signal::{ClientMessage, RelayMessage, Slot};
use tokio::sync::mpsc;

use crate::error::NetError;
use crate::state::ConnectionRoute;
use crate::transport::{
    BoxFuture, SignalingConnector, SignalingEvent, SignalingLink, SignalingTransport,
};

/// Where a slot's signaling came from, for routes that know (the Owner's embedded rendezvous).
pub type AddressLookup = Arc<dyn Fn(&Slot) -> Option<SocketAddr> + Send + Sync>;

#[derive(Clone)]
pub struct Route {
    pub route: ConnectionRoute,
    pub connector: Arc<dyn SignalingConnector>,
    pub lookup: Option<AddressLookup>,
}

pub struct MultiSignaling {
    routes: Vec<Route>,
    retry_max: Duration,
}

impl MultiSignaling {
    pub fn new(routes: Vec<Route>) -> Self {
        Self {
            routes,
            retry_max: Duration::from_secs(30),
        }
    }
}

#[derive(Default)]
struct Shared {
    links: Vec<Option<Arc<dyn SignalingTransport>>>,
    slots: HashMap<Slot, usize>,
    host: Option<ClientMessage>,
    closed: bool,
}

struct MultiLink {
    shared: Arc<Mutex<Shared>>,
    routes: Vec<Route>,
}

fn lock(shared: &Mutex<Shared>) -> std::sync::MutexGuard<'_, Shared> {
    shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl SignalingTransport for MultiLink {
    fn send(&self, message: ClientMessage) -> Result<(), NetError> {
        let mut shared = lock(&self.shared);
        if let ClientMessage::Signal { to, .. } = &message {
            let route = shared.slots.get(to).copied().ok_or(NetError::Closed)?;
            let link = shared
                .links
                .get(route)
                .cloned()
                .flatten()
                .ok_or(NetError::Closed)?;
            drop(shared);
            return link.send(message);
        }
        if matches!(message, ClientMessage::Host { .. }) {
            shared.host = Some(message.clone());
        }
        let links: Vec<_> = shared.links.iter().flatten().cloned().collect();
        drop(shared);
        let mut sent = false;
        for link in links {
            sent |= link.send(message.clone()).is_ok();
        }
        sent.then_some(()).ok_or(NetError::Closed)
    }

    fn close(&self) {
        let links: Vec<_> = {
            let mut shared = lock(&self.shared);
            shared.closed = true;
            shared.links.iter_mut().filter_map(Option::take).collect()
        };
        for link in links {
            link.close();
        }
    }

    fn route_of(&self, slot: &Slot) -> Option<(ConnectionRoute, Option<SocketAddr>)> {
        let index = *lock(&self.shared).slots.get(slot)?;
        let route = self.routes.get(index)?;
        Some((
            route.route,
            route.lookup.as_ref().and_then(|lookup| lookup(slot)),
        ))
    }
}

/// Forwards one route's events into the merged stream; returns when that route's link ends.
async fn pump(
    index: usize,
    mut rx: mpsc::Receiver<SignalingEvent>,
    shared: Arc<Mutex<Shared>>,
    out: mpsc::Sender<SignalingEvent>,
) {
    while let Some(event) = rx.recv().await {
        let SignalingEvent::Message(message) = event else {
            break;
        };
        {
            let mut shared = lock(&shared);
            match &message {
                RelayMessage::Signal { from, .. } => {
                    shared.slots.entry(from.clone()).or_insert(index);
                }
                RelayMessage::PeerArrived { slot } => {
                    shared.slots.insert(slot.clone(), index);
                }
                _ => {}
            }
        }
        if out.send(SignalingEvent::Message(message)).await.is_err() {
            return;
        }
    }
}

/// Keeps route `index` connected until the whole link is closed: forwards its events, reconnects with backoff.
fn supervise(
    index: usize,
    first: Option<SignalingLink>,
    routes: Vec<Route>,
    shared: Arc<Mutex<Shared>>,
    out: mpsc::Sender<SignalingEvent>,
    retry_max: Duration,
) {
    tokio::spawn(async move {
        // A link that was up when the Owner connected gets its Host message from the Owner itself; only a route that
        // connects later (or comes back) is registered again here.
        let mut reconnected = first.is_none();
        let mut next = first;
        let mut backoff = Duration::from_secs(1);
        loop {
            if let Some((link, rx)) = next.take() {
                backoff = Duration::from_secs(1);
                let host = {
                    let mut guard = lock(&shared);
                    if guard.closed {
                        link.close();
                        return;
                    }
                    guard.links[index] = Some(link.clone());
                    guard.host.clone()
                };
                if let Some(host) = host.filter(|_| reconnected) {
                    let _ = link.send(host); // a route that came back registers the room again
                }
                reconnected = true;
                pump(index, rx, shared.clone(), out.clone()).await;
                let all_down = {
                    let mut guard = lock(&shared);
                    guard.links[index] = None;
                    guard.slots.retain(|_, route| *route != index);
                    guard.closed || guard.links.iter().all(Option::is_none)
                };
                if all_down {
                    let _ = out
                        .send(SignalingEvent::Closed {
                            reason: "every signaling route is down".into(),
                        })
                        .await;
                    return;
                }
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(retry_max);
            if lock(&shared).closed || out.is_closed() {
                return;
            }
            match routes[index].connector.connect().await {
                Ok(link) => next = Some(link),
                Err(err) => {
                    tracing::debug!(%err, route = ?routes[index].route, "a signaling route is still unreachable")
                }
            }
        }
    });
}

impl SignalingConnector for MultiSignaling {
    fn connect(&self) -> BoxFuture<'_, Result<SignalingLink, NetError>> {
        Box::pin(async move {
            let attempts = self.routes.iter().map(|route| route.connector.connect());
            let results = futures_util::future::join_all(attempts).await;
            if results.iter().all(Result::is_err) {
                let reason = results
                    .into_iter()
                    .filter_map(Result::err)
                    .map(|e| e.to_string())
                    .collect::<Vec<_>>()
                    .join("; ");
                return Err(NetError::Signaling(reason));
            }
            let shared = Arc::new(Mutex::new(Shared {
                links: vec![None; self.routes.len()],
                ..Shared::default()
            }));
            let (out, merged) = mpsc::channel(256);
            for (index, result) in results.into_iter().enumerate() {
                let first = match result {
                    Ok(link) => Some(link),
                    Err(err) => {
                        tracing::info!(%err, route = ?self.routes[index].route, "a signaling route is unreachable; retrying in the background");
                        None
                    }
                };
                if let Some((link, _)) = &first {
                    lock(&shared).links[index] = Some(link.clone());
                }
                supervise(
                    index,
                    first,
                    self.routes.clone(),
                    shared.clone(),
                    out.clone(),
                    self.retry_max,
                );
            }
            let link: Arc<dyn SignalingTransport> = Arc::new(MultiLink {
                shared,
                routes: self.routes.clone(),
            });
            Ok((link, merged))
        })
    }
}
