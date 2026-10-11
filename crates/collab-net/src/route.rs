//! Choosing how a participant reaches a room. The order, for the same room and the same Room Code:
//!
//! 1. the local network — an address the user typed in, then the address that worked last time, then whatever
//!    discovery finds (mDNS + broadcast) — each tried directly: signaling to the Owner's own rendezvous, a peer bound to
//!    the interface that routes to that Owner, host candidates only (no STUN request, no TURN allocation, nothing on
//!    the Internet);
//! 2. the Internet relay, when one is configured and the local network gave nothing.
//!
//! Every try runs the unchanged handshake: the Owner must prove the Room Code (first join) or its pinned key
//! (reconnect), bound to this connection's DTLS fingerprints, before anything is sent. A machine that announces the
//! room without being its Owner therefore only costs one failed try; the next address is tried. A refusal from an
//! endpoint isn't trusted to stop the search either (anyone can send one before proving anything), but it is the
//! reason reported when nothing else worked.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use openmind_collab::PeerIdentity;

use crate::error::NetError;
use crate::lan::discover::{discover_reporting, DiscoveryConfig};
use crate::lan::{netif, DiscoveryTag, LanEndpoint};
use crate::participant::{self, Participant, ParticipantConfig};
use crate::relay::TurnRelay;
use crate::signaling::WsSignaling;
use crate::state::ConnectionRoute;
use crate::stun::StunGatherer;
use crate::transport::SignalingConnector;

/// Opening the signaling connection to a local Owner: on a LAN it answers in milliseconds or not at all (a firewall
/// that drops packets), so a silent address isn't waited on for long.
pub const LAN_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone)]
pub struct LanOptions {
    /// An Owner address the user typed in (still needs the Room Code).
    pub manual: Option<SocketAddr>,
    /// The address that worked last time (reconnect).
    pub known: Option<SocketAddr>,
    pub discovery: DiscoveryConfig,
    /// How long one local try may take before the next address is tried (an approval wait extends it, as always).
    pub attempt_timeout: Duration,
}

impl Default for LanOptions {
    fn default() -> Self {
        Self {
            manual: None,
            known: None,
            discovery: DiscoveryConfig::default(),
            attempt_timeout: Duration::from_secs(10),
        }
    }
}

#[derive(Clone, Default)]
pub struct RouteOptions {
    /// `None`: the local network isn't tried.
    pub lan: Option<LanOptions>,
    /// `None`: no Internet relay is configured.
    pub internet: Option<Arc<dyn SignalingConnector>>,
}

/// A joined session and how it was reached.
pub struct Routed {
    pub participant: Participant,
    pub route: ConnectionRoute,
    /// The Owner's local rendezvous, for a local-network connection (try it first next time).
    pub endpoint: Option<SocketAddr>,
}

fn lan_config(
    config: &ParticipantConfig,
    endpoint: &LanEndpoint,
    timeout: Duration,
) -> Option<ParticipantConfig> {
    let mut lan = config.clone();
    lan.ice.bind_ip = Some(netif::route_ip(endpoint.addr.ip())?);
    lan.ice.stun.clear();
    lan.ice.turn.clear();
    lan.ice.policy = crate::ice::IcePolicy::All;
    lan.gatherer = Arc::new(StunGatherer::new(Vec::new()));
    lan.relay = Arc::new(TurnRelay::new(Vec::new()));
    lan.handshake_timeout = timeout.min(config.handshake_timeout);
    Some(lan)
}

/// The local addresses to try, in order, without duplicates (discovery runs only if none was given or they failed).
fn push(list: &mut Vec<LanEndpoint>, endpoint: LanEndpoint) {
    if !list.iter().any(|known| known.addr == endpoint.addr) {
        list.push(endpoint);
    }
}

/// What one local try ended with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AttemptOutcome {
    Connected,
    /// Nothing answered, or the connection was refused: a firewall, client isolation, or no Owner there anymore.
    Unreachable,
    /// The rendezvous answered but hosts no room for this code (a wrong or rotated code, another room).
    NoRoom,
    /// Something answered as the room but couldn't prove it is its Owner (an impostor, a changed key).
    NotOwner,
    /// The Owner refused this member (banned, room locked or closed ...).
    Refused,
    /// Signaling worked but the direct connection never came up: UDP between the two computers is blocked.
    NoDirectPath,
    /// Only listed by discovery, not tried yet.
    Found,
    Other,
}

impl AttemptOutcome {
    fn of(err: &NetError) -> Self {
        match err {
            NetError::Io(_) | NetError::Signaling(_) | NetError::NoRoute(_) => {
                AttemptOutcome::Unreachable
            }
            NetError::Relay(openmind_collab_signal::ErrorCode::NoHost) => AttemptOutcome::NoRoom,
            NetError::Protocol(_) => AttemptOutcome::NotOwner,
            NetError::Refused(_) => AttemptOutcome::Refused,
            // Not even the signaling connection opened: nothing answered at that address.
            NetError::Timeout(what) if what.contains("signaling") => AttemptOutcome::Unreachable,
            NetError::Timeout(_) | NetError::Rtc(_) => AttemptOutcome::NoDirectPath,
            _ => AttemptOutcome::Other,
        }
    }
}

/// Why no route worked, as a category a page can explain in the user's language.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RouteFailure {
    /// No Owner of this room was found on the local network (or none answered for this code).
    NotFound,
    /// An Owner address was found or given, but no connection could be made to it: firewall, network policy or
    /// client isolation.
    Blocked,
    /// The Owner refused this member.
    Refused,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub addr: std::net::SocketAddr,
    pub source: crate::lan::LanSource,
    pub outcome: AttemptOutcome,
    pub millis: u64,
}

/// What a join tried and found (diagnostics; holds no Room Code, key or path).
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteReport {
    pub lan_tried: bool,
    pub discovered: Vec<Attempt>,
    pub attempts: Vec<Attempt>,
    pub discovery_millis: u64,
    /// Why discovery couldn't search at all (empty: it searched, and `discovered` is what answered).
    pub discovery_problems: Vec<String>,
    pub route: Option<ConnectionRoute>,
    pub failure: Option<RouteFailure>,
}

impl RouteReport {
    fn classify(&self) -> RouteFailure {
        let outcomes: Vec<AttemptOutcome> = self.attempts.iter().map(|a| a.outcome).collect();
        if outcomes.contains(&AttemptOutcome::Refused) {
            RouteFailure::Refused
        } else if outcomes.iter().any(|o| {
            matches!(
                o,
                AttemptOutcome::Unreachable | AttemptOutcome::NoDirectPath
            )
        }) {
            RouteFailure::Blocked
        } else {
            RouteFailure::NotFound // nothing found, or only rendezvous without this room / without a real Owner
        }
    }
}

fn millis(started: std::time::Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

async fn try_lan(
    identity: &PeerIdentity,
    config: &ParticipantConfig,
    endpoints: &[LanEndpoint],
    timeout: Duration,
    report: &mut RouteReport,
    errors: &mut Vec<NetError>,
) -> Option<Routed> {
    for endpoint in endpoints {
        let started = std::time::Instant::now();
        let attempt = |outcome| Attempt {
            addr: endpoint.addr,
            source: endpoint.source,
            outcome,
            millis: millis(started),
        };
        let Some(lan) = lan_config(config, endpoint, timeout) else {
            report.attempts.push(attempt(AttemptOutcome::Unreachable));
            errors.push(NetError::NoRoute(format!(
                "no network route to {}",
                endpoint.addr
            )));
            continue;
        };
        let signaling = Arc::new(
            WsSignaling::direct(&endpoint.signaling_url()).with_timeout(LAN_CONNECT_TIMEOUT),
        );
        match participant::connect(identity.clone(), lan, signaling).await {
            Ok(participant) => {
                report.attempts.push(attempt(AttemptOutcome::Connected));
                return Some(Routed {
                    participant,
                    route: ConnectionRoute::LocalLan,
                    endpoint: Some(endpoint.addr),
                });
            }
            Err(err) => {
                tracing::info!(addr = %endpoint.addr, source = ?endpoint.source, %err, "a local-network try failed");
                report.attempts.push(attempt(AttemptOutcome::of(&err)));
                errors.push(err);
            }
        }
    }
    None
}

/// Why nothing worked, in words a person can act on (pages translate the report's category instead).
fn explain(failure: RouteFailure, errors: &[NetError]) -> NetError {
    if let Some(refused) = errors.iter().find(|e| matches!(e, NetError::Refused(_))) {
        return refused.clone();
    }
    let lan = match failure {
        RouteFailure::Refused => "The room refused the connection.",
        RouteFailure::Blocked => {
            "OpenMind Studio found or tried the Owner on the local network, but the connection couldn't be completed. \
             The Owner's computer may be blocking inbound local-network traffic (Windows Firewall or the network's \
             policy), or the network may keep computers from reaching each other (client isolation)."
        }
        RouteFailure::NotFound => {
            "No room with this code was found on the local network. Check the code and that the Owner is hosting it on \
             the same network; if discovery is blocked there, enter the Owner's local address."
        }
    };
    let last = errors
        .last()
        .map(|e| format!(" (Last error: {e})"))
        .unwrap_or_default();
    NetError::NoRoute(format!(
        "{lan} No Internet signaling server is configured.{last}"
    ))
}

/// Joins (or rejoins) a room by the best available route.
pub async fn connect(
    identity: PeerIdentity,
    config: ParticipantConfig,
    options: RouteOptions,
) -> Result<Routed, NetError> {
    connect_with_report(identity, config, options).await.0
}

/// [`connect`], with what was found and tried along the way.
pub async fn connect_with_report(
    identity: PeerIdentity,
    config: ParticipantConfig,
    options: RouteOptions,
) -> (Result<Routed, NetError>, RouteReport) {
    let mut report = RouteReport::default();
    let mut errors = Vec::new();
    if let Some(lan) = &options.lan {
        report.lan_tried = true;
        let mut first: Vec<LanEndpoint> = Vec::new();
        for addr in [lan.manual, lan.known].into_iter().flatten() {
            push(&mut first, LanEndpoint::known(addr));
        }
        if let Some(routed) = try_lan(
            &identity,
            &config,
            &first,
            lan.attempt_timeout,
            &mut report,
            &mut errors,
        )
        .await
        {
            report.route = Some(routed.route);
            return (Ok(routed), report);
        }
        let started = std::time::Instant::now();
        let tag = DiscoveryTag::for_topic(&config.code.signaling_topic());
        let search = discover_reporting(&tag, &lan.discovery).await;
        report.discovery_problems = search.problems;
        let discovered: Vec<LanEndpoint> = search
            .found
            .into_iter()
            .filter(|e| !first.iter().any(|f| f.addr == e.addr))
            .collect();
        report.discovery_millis = millis(started);
        report.discovered = discovered
            .iter()
            .map(|e| Attempt {
                addr: e.addr,
                source: e.source,
                outcome: AttemptOutcome::Found,
                millis: report.discovery_millis,
            })
            .collect();
        if let Some(routed) = try_lan(
            &identity,
            &config,
            &discovered,
            lan.attempt_timeout,
            &mut report,
            &mut errors,
        )
        .await
        {
            report.route = Some(routed.route);
            return (Ok(routed), report);
        }
    }
    if let Some(internet) = options.internet.clone() {
        let result = participant::connect(identity, config, internet)
            .await
            .map(|participant| Routed {
                participant,
                route: ConnectionRoute::InternetRelay,
                endpoint: None,
            });
        report.route = result.as_ref().ok().map(|r| r.route);
        return (result, report);
    }
    let failure = report.classify();
    report.failure = Some(failure);
    (Err(explain(failure, &errors)), report)
}
