//! Collaboration networking in the app: hosting a room on the network (an `OwnerNetwork`) and joining one as a
//! participant. Transient connection information goes to every window as `collab:net` events; durable room/member
//! state stays in the `Collaboration` canonical domain. Nothing polls: states arrive as events.
//!
//! Settings come from the Phase 1 network settings (signaling URL, STUN, TURN) and the DPAPI-protected TURN password.
//! The signaling WebSocket follows the proxy OpenMind uses for its own requests; WebRTC traffic doesn't (a proxy
//! for signaling is not a relay for peer connections).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use openmind_collab::netconfig::NetConfig;
use openmind_collab::RoomUid;
use openmind_collab_net::ice::IceSetup;
use openmind_collab_net::lan::firewall::FirewallStatus;
use openmind_collab_net::lan::host::{LanHost, LanHostConfig, LanHostStatus};
use openmind_collab_net::owner::{OwnerEvent, OwnerNetwork, OwnerOptions};
use openmind_collab_net::participant::ParticipantSender;
use openmind_collab_net::relay::TurnRelay;
use openmind_collab_net::remote::RemoteWorkspace;
use openmind_collab_net::route::RouteReport;
use openmind_collab_net::signaling::multi::{MultiSignaling, Route};
use openmind_collab_net::signaling::WsSignaling;
use openmind_collab_net::stun::StunGatherer;
use openmind_collab_net::transport::IcePath;
use openmind_collab_net::{ConnectionRoute, ConnectionState};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

use super::net_authority::AppAuthority;
use crate::app_state::AppState;
use crate::state::Domain;

pub const NET_EVENT: &str = "collab:net";

/// The live networks of this app (rooms hosted, rooms joined).
#[derive(Default)]
pub struct NetRuntime {
    hosting: Mutex<HashMap<String, OwnerNetwork>>,
    joined: Mutex<HashMap<String, ParticipantSender>>,
    remotes: Mutex<HashMap<String, Arc<RemoteWorkspace>>>,
    states: Mutex<HashMap<String, ConnectionState>>,
    /// Hosted rooms' local-network presence (rendezvous + announcements).
    lan_hosts: Mutex<HashMap<String, LanHost>>,
    /// Joined rooms: the route used, and the Owner's local address when it was the local network (tried first on a
    /// rejoin; kept in memory only — a route is not stored with the room).
    routes: Mutex<HashMap<String, ConnectionRoute>>,
    /// Joined rooms: the kind of path the connection to the Owner takes (no address; diagnostics).
    paths: Mutex<HashMap<String, IcePath>>,
    /// Hosted rooms: the kind of path each member's connection takes, by its signaling slot.
    host_paths: Mutex<HashMap<String, HashMap<String, IcePath>>>,
    lan_known: Mutex<HashMap<String, SocketAddr>>,
    /// What Windows Firewall does with other computers' connections to this app (read when hosting starts).
    firewall: Mutex<Option<FirewallStatus>>,
    /// What the latest join found and tried (diagnostics: addresses and outcomes, never a code).
    last_join: Mutex<Option<RouteReport>>,
    /// Presence: this computer's windows, and what joined rooms' Owners said (phase 7; memory only).
    pub presence: super::net_presence::PresenceRuntime,
    /// A participant's sent document changes, by the frame the Owner's acknowledgement will name.
    pub doc_frames: super::net_docs::DocFrames,
    /// Voice: which window holds each room's call, the joined rooms' rosters (phase 9; memory only).
    pub voice: super::net_voice::VoiceRuntime,
    /// Classroom voice: this computer's media server and what the media server was told (phase 11).
    pub sfu: super::sfu::SfuRuntime,
    /// Management commands sent as a participant, waiting for the Owner's answer (phase 8).
    pub command_waits: super::net_manage::CommandWaits,
    /// Hosted rooms' pending re-reads after file changes (`net_share`).
    pub share_queue: super::net_share::ShareQueue,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl NetRuntime {
    pub fn hosting(&self, room: &str) -> Option<OwnerNetwork> {
        lock(&self.hosting)
            .get(room)
            .filter(|n| n.is_running())
            .cloned()
    }

    /// How a joined room was reached (none for a hosted room).
    pub fn route_of(&self, room: &str) -> Option<ConnectionRoute> {
        lock(&self.routes).get(room).copied()
    }

    pub fn joined(&self, room: &str) -> Option<ParticipantSender> {
        lock(&self.joined).get(room).cloned()
    }

    pub fn remember_host(&self, room: &str, network: OwnerNetwork) {
        lock(&self.hosting).insert(room.to_string(), network);
    }

    pub fn remember_joined(&self, room: &str, sender: ParticipantSender) {
        lock(&self.joined).insert(room.to_string(), sender);
    }

    pub fn stop_host(&self, room: &str) {
        if let Some(network) = lock(&self.hosting).remove(room) {
            network.stop();
        }
        lock(&self.lan_hosts).remove(room); // withdraws the announcements, closes the rendezvous
        lock(&self.host_paths).remove(room);
    }

    pub fn remember_route(&self, room: &str, route: ConnectionRoute, endpoint: Option<SocketAddr>) {
        lock(&self.routes).insert(room.to_string(), route);
        if let Some(endpoint) = endpoint {
            lock(&self.lan_known).insert(room.to_string(), endpoint);
        }
    }

    pub fn remember_path(&self, room: &str, path: IcePath) {
        lock(&self.paths).insert(room.to_string(), path);
    }

    /// A hosted room's member connection reported its path (`None`: the connection ended).
    pub(super) fn host_path(&self, room: &str, slot: &str, path: Option<IcePath>) {
        let mut all = lock(&self.host_paths);
        let room_paths = all.entry(room.to_string()).or_default();
        match path {
            Some(path) => room_paths.insert(slot.to_string(), path),
            None => room_paths.remove(slot),
        };
    }

    pub fn remember_report(&self, report: RouteReport) {
        *lock(&self.last_join) = Some(report);
    }

    /// Everything needed to see why local-network collaboration does or doesn't work here.
    pub fn diagnostics(
        &self,
        lan_enabled: bool,
        signaling_configured: bool,
        turn: TurnDiagnostics,
    ) -> NetDiagnostics {
        NetDiagnostics {
            lan_enabled,
            signaling_configured,
            turn,
            paths: lock(&self.paths).clone(),
            host_paths: lock(&self.host_paths)
                .iter()
                .map(|(room, slots)| (room.clone(), slots.values().copied().collect()))
                .collect(),
            interfaces: openmind_collab_net::lan::netif::current()
                .into_iter()
                .map(|i| InterfaceView {
                    rank: i.rank,
                    addresses: i.addresses().iter().map(ToString::to_string).collect(),
                })
                .collect(),
            hosting: lock(&self.lan_hosts)
                .iter()
                .map(|(room, host)| (room.clone(), host.status()))
                .collect(),
            routes: lock(&self.routes).clone(),
            last_join: lock(&self.last_join).clone(),
            firewall: lock(&self.firewall).clone(),
        }
    }

    /// The Owner's local address that worked last for a joined room.
    pub fn known_lan(&self, room: &str) -> Option<SocketAddr> {
        lock(&self.lan_known).get(room).copied()
    }

    pub fn forget_joined(&self, room: &str) -> Option<ParticipantSender> {
        lock(&self.remotes).remove(room);
        lock(&self.routes).remove(room);
        lock(&self.paths).remove(room);
        lock(&self.joined).remove(room)
    }

    pub fn remember_remote(&self, room: &str, remote: Arc<RemoteWorkspace>) {
        lock(&self.remotes).insert(room.to_string(), remote);
    }

    /// The shared workspace of a room joined as a participant.
    pub fn remote(&self, room: &str) -> Option<Arc<RemoteWorkspace>> {
        lock(&self.remotes).get(room).cloned()
    }

    pub(super) fn set_state(&self, room: &str, state: ConnectionState) {
        lock(&self.states).insert(room.to_string(), state);
    }

    /// Stops every network (the app is closing).
    pub fn stop_all(&self) {
        for (_, network) in lock(&self.hosting).drain() {
            network.stop();
        }
        lock(&self.lan_hosts).clear();
        for (_, sender) in lock(&self.joined).drain() {
            let _ = sender.send(openmind_collab::protocol::Body::Leave);
            sender.close();
        }
    }

    pub fn status(&self) -> NetStatus {
        let states = lock(&self.states).clone();
        NetStatus {
            hosting: lock(&self.hosting)
                .iter()
                .filter(|(_, n)| n.is_running())
                .map(|(r, _)| r.clone())
                .collect(),
            joined: lock(&self.joined).keys().cloned().collect(),
            states,
            lan_endpoints: lock(&self.lan_hosts)
                .iter()
                .map(|(room, host)| {
                    (
                        room.clone(),
                        host.endpoints().iter().map(ToString::to_string).collect(),
                    )
                })
                .collect(),
            routes: lock(&self.routes).clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetStatus {
    pub hosting: Vec<String>,
    pub joined: Vec<String>,
    pub states: HashMap<String, ConnectionState>,
    /// Hosted rooms: the local addresses participants can type in when discovery is blocked (`ip:port`).
    pub lan_endpoints: HashMap<String, Vec<String>>,
    /// Joined rooms: how they were reached.
    pub routes: HashMap<String, ConnectionRoute>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceView {
    /// 0 = a LAN with a router, 1 = a LAN without one, 2 = VPN/other, 3 = link-local only.
    pub rank: u8,
    pub addresses: Vec<String>,
}

/// `collab_net_diagnostics`: the local-network state of this computer (no Room Code, key, identity or path).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetDiagnostics {
    pub lan_enabled: bool,
    pub signaling_configured: bool,
    pub turn: TurnDiagnostics,
    /// The interfaces local rooms use, best first (host-only virtual switches and loopback are left out).
    pub interfaces: Vec<InterfaceView>,
    pub hosting: HashMap<String, LanHostStatus>,
    pub routes: HashMap<String, ConnectionRoute>,
    /// Joined rooms: the kind of path to the Owner.
    pub paths: HashMap<String, IcePath>,
    /// Hosted rooms: the kinds of path members' connections take (no address, no member).
    pub host_paths: HashMap<String, Vec<IcePath>>,
    pub last_join: Option<RouteReport>,
    /// Read when a room is hosted: whether other computers' connections reach this app (`None`: not checked yet).
    pub firewall: Option<FirewallStatus>,
}

/// Whether TURN can be used here: the configured servers' protocols (no host, user name or password).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnDiagnostics {
    /// `notConfigured` (no server), `noLogin` (servers without a saved user name and password) or `configured`.
    pub status: &'static str,
    pub protocols: Vec<openmind_collab_net::transport::RelayProtocol>,
    /// Debug builds' relay-only test mode (`OPENMIND_DEV_COLLAB_ICE=relay`).
    pub relay_only: bool,
}

/// One `collab:net` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetEvent<'a, E: Serialize> {
    pub room_uid: &'a str,
    pub side: &'static str,
    pub event: E,
}

/// Everything a connection needs from the settings.
pub struct NetSetup {
    /// The Internet signaling relay, when one is configured.
    pub signaling_url: Option<String>,
    /// Local-network rooms on (the default).
    pub lan: bool,
    pub ice: IceSetup,
    /// The configured TURN servers and the stored login (read only when an allocation starts).
    relay: Arc<TurnRelay>,
}

impl NetSetup {
    pub fn gatherer(&self) -> Arc<StunGatherer> {
        Arc::new(StunGatherer::new(self.ice.stun.clone()))
    }

    pub fn relay(&self) -> Arc<TurnRelay> {
        self.relay.clone()
    }
}

pub async fn setup(state: &AppState) -> Result<NetSetup, String> {
    let config: NetConfig = super::read_config(state);
    let signaling_url = config.signaling_url.clone();
    let lan = crate::commands::preferences::user_bool(state, "collaboration.localNetwork");
    if signaling_url.is_none() && !lan {
        return Err("Turn on Settings > Collaboration > Local Network, or set a signaling server for rooms across networks.".into());
    }
    let mut ice = IceSetup::from_config(&config);
    ice.bind_ip = debug_bind_ip();
    ice.policy = debug_ice_policy();
    let relay = super::turn_login::relay(state, &ice);
    Ok(NetSetup {
        signaling_url,
        lan,
        ice,
        relay,
    })
}

/// Debug builds only: `OPENMIND_DEV_COLLAB_ICE=relay` offers only TURN-relayed candidates on Internet routes, to
/// verify that a room really works through the TURN server. Release builds ignore it; local-network routes never use
/// TURN either way.
pub(crate) fn debug_ice_policy() -> openmind_collab_net::ice::IcePolicy {
    let relay_only = cfg!(debug_assertions)
        && std::env::var("OPENMIND_DEV_COLLAB_ICE").is_ok_and(|v| v.eq_ignore_ascii_case("relay"));
    if relay_only {
        openmind_collab_net::ice::IcePolicy::RelayOnly
    } else {
        openmind_collab_net::ice::IcePolicy::All
    }
}

/// Debug builds only: `OPENMIND_DEV_COLLAB_BIND=127.0.0.1` keeps WebRTC on this computer, so two local copies of the
/// app can be tested together without listening on a network interface (no firewall prompt). Release builds ignore it.
fn debug_bind_ip() -> Option<std::net::IpAddr> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let ip: std::net::IpAddr = std::env::var("OPENMIND_DEV_COLLAB_BIND")
        .ok()?
        .parse()
        .ok()?;
    ip.is_loopback().then_some(ip)
}

/// Starts hosting `room` on the network (no-op when it already runs).
pub async fn host(app: &AppHandle, state: &AppState, room: &str) -> Result<(), String> {
    if state.collab.net.hosting(room).is_some() {
        return Ok(());
    }
    let uid = RoomUid::parse(room).map_err(|e| e.to_string())?;
    // Loads the room (and refuses one this machine doesn't host) before anything goes on the network.
    let topic = state.collab.topic(&state.db, room, super::now_ms()).await?;
    let setup = setup(state).await?;
    let mut routes = Vec::new();
    if setup.lan {
        // The local network first: the same room, signaled through the Owner's own rendezvous.
        match LanHost::start(&topic, LanHostConfig::default()).await {
            Ok(lan) => {
                routes.extend(lan.route());
                check_firewall(app);
                lock(&state.collab.net.lan_hosts).insert(room.to_string(), lan);
            }
            Err(err) => tracing::warn!(%err, "the room can't be offered on the local network"),
        }
    }
    if let Some(url) = &setup.signaling_url {
        routes.push(Route {
            route: ConnectionRoute::InternetRelay,
            connector: Arc::new(WsSignaling::new(url)),
            lookup: None,
        });
    }
    if routes.is_empty() {
        return Err(
            "The room couldn't be offered on the local network, and no signaling server is set."
                .into(),
        );
    }
    let options = OwnerOptions {
        ice: setup.ice.clone(),
        gatherer: setup.gatherer(),
        relay: setup.relay(),
        peer_connect_timeout: Duration::from_secs(20),
        handshake_timeout: Duration::from_secs(30),
    };
    let authority = Arc::new(AppAuthority {
        app: app.clone(),
        room: uid,
    });
    let (network, events) =
        OwnerNetwork::start(authority, Arc::new(MultiSignaling::new(routes)), options);
    state.collab.net.remember_host(room, network);
    super::sfu::restore_mode(state, room).await;
    // Accepted changes nobody saved before the app last ended go back into the Owner's editor at once.
    let recovered = state
        .collab
        .docs_recover(&state.db, room, super::now_ms())
        .await;
    super::net_docs::owner_events(app, room, recovered);
    tauri::async_runtime::spawn(forward_host(app.clone(), room.to_string(), events));
    Ok(())
}

/// Reads Windows Firewall's answer for this app in the background (read-only; it never changes a rule).
fn check_firewall(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(exe) = std::env::current_exe() else {
            return;
        };
        let status = tauri::async_runtime::spawn_blocking(move || {
            openmind_collab_net::lan::firewall::check(&exe, Duration::from_secs(10))
        })
        .await;
        if let (Ok(status), Some(state)) = (status, app.try_state::<AppState>()) {
            if status.verdict == openmind_collab_net::lan::firewall::FirewallVerdict::Blocked {
                tracing::warn!("Windows Firewall blocks inbound connections to OpenMind Studio: other computers can't join rooms hosted here");
            }
            *lock(&state.collab.net.firewall) = Some(status);
        }
    });
}

/// After a Room Code rotation: the hosted room is announced and registered under the new code's topic on every route.
/// Members already connected stay connected.
pub async fn rehost(app: &AppHandle, room: &str) -> Result<(), String> {
    let Some(state) = app.try_state::<AppState>() else {
        return Ok(());
    };
    let Some(network) = state.collab.net.hosting(room) else {
        return Ok(());
    };
    let topic = state.collab.topic(&state.db, room, super::now_ms()).await?;
    if let Some(lan) = lock(&state.collab.net.lan_hosts).get_mut(room) {
        lan.set_topic(&topic);
    }
    network.rehost();
    Ok(())
}

async fn forward_host(
    app: AppHandle,
    room: String,
    mut events: mpsc::UnboundedReceiver<OwnerEvent>,
) {
    while let Some(event) = events.recv().await {
        if let OwnerEvent::Signaling { state } = &event {
            if let Some(app_state) = app.try_state::<AppState>() {
                app_state.collab.net.set_state(&room, *state);
            }
        }
        if let Some(app_state) = app.try_state::<AppState>() {
            match &event {
                OwnerEvent::Path { slot, path } => {
                    app_state.collab.net.host_path(&room, slot, Some(*path))
                }
                OwnerEvent::Link { slot, state } if state.is_finished() => {
                    app_state.collab.net.host_path(&room, slot, None)
                }
                _ => {}
            }
        }
        if matches!(event, OwnerEvent::Admitted { .. } | OwnerEvent::Left { .. }) {
            crate::state::refresh_soon(&app, &[Domain::Collaboration]);
        }
        if matches!(event, OwnerEvent::Pending { .. }) {
            // Moderators connected elsewhere see the waiting member at once.
            crate::state::refresh_soon(&app, &[Domain::Collaboration]);
            let (app, room) = (app.clone(), room.clone());
            tauri::async_runtime::spawn(async move {
                super::net_presence::refresh_roster(&app, &room).await;
            });
        }
        let _ = app.emit(
            NET_EVENT,
            NetEvent {
                room_uid: &room,
                side: "host",
                event,
            },
        );
    }
}
