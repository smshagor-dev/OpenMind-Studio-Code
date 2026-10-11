//! The local harness: a real relay on loopback, an Owner network over an in-memory `openmind_collab::Authority`
//! (the same authority the app uses, without the database), and real `str0m` participants over loopback UDP.

#![allow(dead_code)]

use std::sync::Arc;
use std::time::Duration;

use openmind_collab::authority::{Actor, Authority, Command, JoinOutcome};
use openmind_collab::binding::owner_hello;
use openmind_collab::ids::Challenge;
use openmind_collab::protocol::{Admission, Body, Frame, Handshake};
use openmind_collab::{PeerId, PeerIdentity, RoomCode, RoomUid, SessionId};
use openmind_collab_net::ice::IceSetup;
use openmind_collab_net::owner::{
    FrameOutcome, OwnerAuthority, OwnerEvent, OwnerNetwork, OwnerOptions,
};
use openmind_collab_net::participant::{
    self, JoinMode, Participant, ParticipantConfig, ParticipantEvent,
};
use openmind_collab_net::relay::TurnRelay;
use openmind_collab_net::signaling::WsSignaling;
use openmind_collab_net::stun::StunGatherer;
use openmind_collab_net::transport::BoxFuture;
use openmind_collab_net::NetError;
use openmind_collab_signal::{Relay, RelayConfig, Topic};
use tokio::sync::{mpsc, Mutex};

pub mod lan;

pub const WAIT: Duration = Duration::from_secs(15);

/// The authority as the app wires it, minus persistence.
pub struct MemoryAuthority {
    pub authority: Mutex<Authority>,
    room: RoomUid,
    pub workspace: Mutex<MemWorkspace>,
    /// Collaborative documents, as the app keeps them (storage is this process's memory here).
    pub docs: Mutex<openmind_collab::docs::DocHost>,
    /// Members' presence (phase 7), as the app keeps it.
    pub presence: Mutex<openmind_collab::presence::PresenceBoard>,
    /// The voice call (phase 9), as the app keeps it.
    pub voice: Mutex<openmind_collab::voice::VoiceBoard>,
}

/// An in-memory shared workspace (the app's real one reads the disk).
#[derive(Default)]
pub struct MemWorkspace {
    pub table: openmind_collab::FileTable,
    pub contents: std::collections::HashMap<String, Vec<u8>>,
    pub version: u64,
    /// Files whose snapshot is sent with a wrong checksum (to test verification).
    pub corrupt: std::collections::HashSet<String>,
    pub too_large: std::collections::HashSet<String>,
}

impl MemWorkspace {
    pub fn sync(&mut self) {
        let paths: Vec<openmind_collab::RelPath> = self
            .contents
            .keys()
            .map(|p| openmind_collab::RelPath::parse(p).expect("path"))
            .collect();
        openmind_collab::share::sync_table(&mut self.table, &paths, &[]);
        self.version += 1;
    }

    pub fn snapshot(&self) -> openmind_collab::manifest::ManifestSnapshot {
        let stats = self
            .contents
            .iter()
            .map(|(p, b)| {
                (
                    p.to_lowercase(),
                    openmind_collab::manifest::FileStat {
                        size: b.len() as u64,
                        modified_ms: 1,
                    },
                )
            })
            .collect();
        openmind_collab::manifest::ManifestSnapshot {
            version: self.version,
            root: "My Project".into(),
            entries: Arc::new(openmind_collab::manifest::entries_of(&self.table, &stats)),
        }
    }

    pub fn id(&self, path: &str) -> openmind_collab::FileId {
        self.table
            .id_of(&openmind_collab::RelPath::parse(path).expect("path"))
            .cloned()
            .expect("shared")
    }
}

impl MemoryAuthority {
    pub fn new() -> Arc<Self> {
        let host = PeerIdentity::generate().expect("identity");
        let (authority, _) = Authority::create(host, "Teacher", "Physics", 1).expect("create");
        let room = authority.room().room_uid.clone();
        Arc::new(Self {
            authority: Mutex::new(authority),
            room,
            workspace: Mutex::new(MemWorkspace::default()),
            docs: Mutex::new(openmind_collab::docs::DocHost::default()),
            presence: Mutex::new(Default::default()),
            voice: Mutex::new(Default::default()),
        })
    }

    pub async fn put_many(&self, files: &[(&str, Vec<u8>)]) {
        let mut ws = self.workspace.lock().await;
        for (path, bytes) in files {
            ws.contents.insert(path.to_string(), bytes.clone());
        }
        ws.sync();
    }

    pub async fn put(&self, path: &str, bytes: Vec<u8>) {
        let mut ws = self.workspace.lock().await;
        ws.contents.insert(path.to_string(), bytes);
        ws.sync();
    }

    pub async fn code(&self) -> RoomCode {
        self.authority.lock().await.invite().clone()
    }

    pub async fn host_command(&self, command: Command) {
        let mut authority = self.authority.lock().await;
        let host = Actor::Host(authority.host_identity().peer_id());
        authority.execute(&host, command, 2).expect("host command");
    }

    pub async fn session_of(&self, peer: &PeerId) -> Option<SessionId> {
        self.authority.lock().await.session_of(peer).cloned()
    }
}

impl MemoryAuthority {
    /// The app's voice rules (`host::voice`): the current session, the room's permissions, the capacity.
    async fn voice_state(
        &self,
        actor: Actor,
        state: openmind_collab::voice::VoiceSelf,
    ) -> FrameOutcome {
        let Actor::Remote { peer, session } = &actor else {
            return FrameOutcome::Dropped;
        };
        let room = {
            let authority = self.authority.lock().await;
            if authority.session_of(peer) != Some(session) {
                return FrameOutcome::Rejected("stale session".into());
            }
            authority.room().clone()
        };
        match self.voice.lock().await.update(&room, peer, state) {
            Ok(_) => FrameOutcome::Accepted,
            Err(refusal) => FrameOutcome::Rejected(refusal.text().into()),
        }
    }

    /// Negotiation is relayed only between two members of the call, under the authenticated sender.
    async fn voice_signal(
        &self,
        actor: Actor,
        to: PeerId,
        signal: openmind_collab::voice::VoiceSignal,
    ) -> FrameOutcome {
        let Actor::Remote { peer, session } = &actor else {
            return FrameOutcome::Dropped;
        };
        if self.authority.lock().await.session_of(peer) != Some(session) {
            return FrameOutcome::Dropped;
        }
        if !self.voice.lock().await.may_signal(peer, &to) {
            return FrameOutcome::Dropped;
        }
        FrameOutcome::Relay(vec![(
            to,
            Body::VoicePeerSignal {
                from: peer.clone(),
                signal,
            },
        )])
    }

    /// The app's presence rules, minus the file paths: the current session, a shared file, a newer state; relayed to
    /// the other connected members under the authenticated peer.
    async fn presence(
        &self,
        actor: Actor,
        state: openmind_collab::presence::PresenceState,
    ) -> FrameOutcome {
        let Actor::Remote { peer, session } = &actor else {
            return FrameOutcome::Dropped;
        };
        let others: Vec<PeerId> = {
            let authority = self.authority.lock().await;
            if authority.session_of(peer) != Some(session) {
                return FrameOutcome::Dropped;
            }
            let members = authority.room().members.keys();
            members
                .filter(|p| *p != peer && authority.session_of(p).is_some())
                .cloned()
                .collect()
        };
        if let Some(file) = &state.active {
            if !self.workspace.lock().await.table.get(file).is_some() {
                return FrameOutcome::Dropped;
            }
        }
        if !self.presence.lock().await.accept(peer, &state) {
            return FrameOutcome::Dropped;
        }
        let relay = others.into_iter().map(|to| {
            (
                to,
                Body::PeerPresence {
                    peer: peer.clone(),
                    state: state.clone(),
                },
            )
        });
        FrameOutcome::Relay(relay.collect())
    }

    /// The app's document rules, minus the database: read to open, write to change, the file must be shared.
    async fn document(&self, actor: Actor, body: Body) -> FrameOutcome {
        use openmind_collab::docs::Origin;
        let Actor::Remote { peer, .. } = &actor else {
            return FrameOutcome::Rejected("remote only".into());
        };
        let action = match &body {
            Body::YjsUpdate { .. } => openmind_collab::Action::WriteFile,
            _ => openmind_collab::Action::ReadFile,
        };
        if let Err(denied) = self.authority.lock().await.authorize(&actor, &action) {
            return FrameOutcome::Rejected(denied.to_string());
        }
        let mut docs = self.docs.lock().await;
        match body {
            Body::YjsStateRequest { file, state_vector } => {
                if !docs.is_loaded(&file) {
                    let ws = self.workspace.lock().await;
                    let Some(entry) = ws.table.get(&file) else {
                        return FrameOutcome::Rejected("unavailable".into());
                    };
                    let text = String::from_utf8_lossy(
                        ws.contents.get(entry.path.as_str()).map_or(&[][..], |b| b),
                    )
                    .into_owned();
                    docs.load(
                        file.clone(),
                        openmind_collab::crdt::CollabDoc::from_text(&text),
                        0,
                    );
                }
                match docs.subscribe(peer, &file, &state_vector.0) {
                    Ok(sync) => FrameOutcome::Reply(vec![(peer.clone(), sync)]),
                    Err(err) => FrameOutcome::Rejected(err.to_string()),
                }
            }
            Body::YjsUpdate { file, id, update } => {
                match docs.update(Origin::Peer(peer.clone()), &file, id, update.0) {
                    Ok(change) => FrameOutcome::Reply(change.send),
                    Err(err) => FrameOutcome::Rejected(err.to_string()),
                }
            }
            Body::DocUnsubscribe { file } => {
                docs.unsubscribe(peer, &file);
                FrameOutcome::Accepted
            }
            _ => FrameOutcome::Rejected("not a document message".into()),
        }
    }

    /// The Owner's own edit (what the Owner's editor sends to the app).
    pub async fn owner_edit(
        &self,
        file: &openmind_collab::FileId,
        text: &str,
    ) -> Vec<(PeerId, Body)> {
        let mut docs = self.docs.lock().await;
        docs.set_text(file, text)
            .ok()
            .flatten()
            .map(|change| change.send)
            .unwrap_or_default()
    }
}

impl OwnerAuthority for MemoryAuthority {
    fn room_uid(&self) -> RoomUid {
        self.room.clone()
    }

    fn topic(&self) -> BoxFuture<'_, Result<Topic, String>> {
        Box::pin(
            async move { Topic::parse(&self.authority.lock().await.invite().signaling_topic()) },
        )
    }

    fn hello(
        &self,
        challenge: Challenge,
        bound: Challenge,
    ) -> BoxFuture<'_, Result<Handshake, String>> {
        Box::pin(async move {
            let a = self.authority.lock().await;
            Ok(owner_hello(
                a.host_identity(),
                a.invite(),
                &self.room,
                &challenge,
                &bound,
            ))
        })
    }

    fn admit(
        &self,
        request: Handshake,
        bound: Challenge,
    ) -> BoxFuture<'_, Result<JoinOutcome, String>> {
        Box::pin(async move {
            let mut a = self.authority.lock().await;
            let result = match &request {
                Handshake::Join(join) => a.join(join, &bound, 3),
                Handshake::Reconnect(again) => a.reconnect(again, &bound, 3),
                _ => return Err("not a join".into()),
            };
            result
                .map(|(outcome, _)| outcome)
                .map_err(|e| e.to_string())
        })
    }

    fn admit_approved(&self, peer: PeerId) -> BoxFuture<'_, Result<Admission, String>> {
        Box::pin(async move {
            self.authority
                .lock()
                .await
                .admit_approved(&peer, 4)
                .map(|(a, _)| a)
                .map_err(|e| e.to_string())
        })
    }

    fn frame(&self, actor: Actor, frame: Frame) -> BoxFuture<'_, FrameOutcome> {
        Box::pin(async move {
            match frame.body {
                Body::Command { command } => {
                    match self.authority.lock().await.execute(&actor, command, 5) {
                        Ok(_) => FrameOutcome::Accepted,
                        Err(err) => FrameOutcome::Rejected(err.to_string()),
                    }
                }
                body @ (Body::YjsStateRequest { .. }
                | Body::YjsUpdate { .. }
                | Body::DocUnsubscribe { .. }) => self.document(actor, body).await,
                Body::Presence { state } => self.presence(actor, state).await,
                Body::VoiceState { state } => self.voice_state(actor, state).await,
                Body::VoiceSignal { to, signal } => self.voice_signal(actor, to, signal).await,
                _ => FrameOutcome::Rejected("reserved for a later phase".into()),
            }
        })
    }

    fn disconnected(&self, peer: PeerId, session: SessionId, reason: String) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let _ = self
                .authority
                .lock()
                .await
                .disconnect(&peer, &session, &reason, 6);
        })
    }

    fn manifest(
        &self,
        actor: Actor,
    ) -> BoxFuture<'_, Result<openmind_collab::manifest::ManifestSnapshot, String>> {
        Box::pin(async move {
            self.authority
                .lock()
                .await
                .authorize(&actor, &openmind_collab::Action::ReadFile)
                .map_err(|d| d.to_string())?;
            Ok(self.workspace.lock().await.snapshot())
        })
    }

    fn open_file(
        &self,
        actor: Actor,
        file: openmind_collab::FileId,
    ) -> BoxFuture<
        '_,
        Result<openmind_collab::transfer::Snapshot, openmind_collab::transfer::FileErrorCode>,
    > {
        use openmind_collab::transfer::{FileErrorCode, Snapshot};
        Box::pin(async move {
            if self
                .authority
                .lock()
                .await
                .authorize(&actor, &openmind_collab::Action::ReadFile)
                .is_err()
            {
                return Err(FileErrorCode::Unavailable);
            }
            let ws = self.workspace.lock().await;
            let path = ws
                .table
                .get(&file)
                .map(|e| e.path.to_string())
                .ok_or(FileErrorCode::Unavailable)?;
            if ws.too_large.contains(&path) {
                return Err(FileErrorCode::TooLarge);
            }
            let bytes = ws
                .contents
                .get(&path)
                .cloned()
                .ok_or(FileErrorCode::Unavailable)?;
            let mut snapshot = Snapshot::new(bytes, true);
            if ws.corrupt.contains(&path) {
                snapshot.sha256 = "0".repeat(64);
            }
            Ok(snapshot)
        })
    }
}

pub fn ice() -> IceSetup {
    IceSetup {
        bind_ip: Some("127.0.0.1".parse().expect("ip")),
        ..IceSetup::default()
    }
}

pub struct World {
    pub relay: Option<Relay>,
    pub url: String,
    pub owner: OwnerNetwork,
    pub events: mpsc::UnboundedReceiver<OwnerEvent>,
    pub authority: Arc<MemoryAuthority>,
}

pub async fn start_relay(config: RelayConfig, addr: &str) -> Relay {
    Relay::start(addr.parse().expect("addr"), config)
        .await
        .expect("relay")
}

pub async fn world() -> World {
    world_with(ice(), Arc::new(TurnRelay::new(Vec::new()))).await
}

/// A world whose Owner finds candidates with `ice` and relays through `relay` (TURN tests).
pub async fn world_with(
    ice: IceSetup,
    relay: Arc<dyn openmind_collab_net::transport::RelayProvider>,
) -> World {
    let signal_relay = start_relay(RelayConfig::default(), "127.0.0.1:0").await;
    let url = format!("ws://{}", signal_relay.addr());
    let authority = MemoryAuthority::new();
    let options = OwnerOptions {
        ice,
        gatherer: Arc::new(StunGatherer::new(Vec::new())),
        relay,
        peer_connect_timeout: Duration::from_secs(10),
        handshake_timeout: Duration::from_secs(15),
    };
    let (owner, mut events) = OwnerNetwork::start(
        authority.clone(),
        Arc::new(WsSignaling::direct(&url)),
        options,
    );
    wait_for(&mut events, |e| matches!(e, OwnerEvent::Signaling { state } if *state == openmind_collab_net::ConnectionState::Connected)).await;
    World {
        relay: Some(signal_relay),
        url,
        owner,
        events,
        authority,
    }
}

pub async fn wait_for(
    events: &mut mpsc::UnboundedReceiver<OwnerEvent>,
    matches: impl Fn(&OwnerEvent) -> bool,
) -> OwnerEvent {
    tokio::time::timeout(WAIT, async {
        loop {
            let event = events.recv().await.expect("owner events");
            if matches(&event) {
                return event;
            }
        }
    })
    .await
    .expect("the owner event in time")
}

pub fn config(code: RoomCode, mode: JoinMode) -> ParticipantConfig {
    ParticipantConfig {
        code,
        display_name: "Student".into(),
        mode,
        ice: ice(),
        gatherer: Arc::new(StunGatherer::new(Vec::new())),
        relay: Arc::new(TurnRelay::new(Vec::new())),
        handshake_timeout: Duration::from_secs(15),
        approval_timeout: Duration::from_secs(15),
        on_pending: None,
    }
}

pub async fn try_join(
    world: &World,
    identity: &PeerIdentity,
    mode: JoinMode,
) -> Result<Participant, NetError> {
    let code = world.authority.code().await;
    try_join_with(world, identity, config(code, mode)).await
}

/// Joins with a configuration of the test's own (another ICE setup or relay).
pub async fn try_join_with(
    world: &World,
    identity: &PeerIdentity,
    config: ParticipantConfig,
) -> Result<Participant, NetError> {
    participant::connect(
        identity.clone(),
        config,
        Arc::new(WsSignaling::direct(&world.url)),
    )
    .await
}

pub async fn join(world: &World) -> (PeerIdentity, Participant) {
    let identity = PeerIdentity::generate().expect("identity");
    let participant = try_join(world, &identity, JoinMode::Join)
        .await
        .expect("joined");
    (identity, participant)
}

/// The next frame from the Owner matching `matches`.
pub async fn frame(participant: &mut Participant, matches: impl Fn(&Body) -> bool) -> Body {
    tokio::time::timeout(WAIT, async {
        loop {
            match participant.next_event().await.expect("participant events") {
                ParticipantEvent::Frame(frame) if matches(&frame.body) => return frame.body,
                _ => {}
            }
        }
    })
    .await
    .expect("the frame in time")
}

/// The Owner's answer (Ack or Reject) to message `id`.
pub async fn answer(
    participant: &mut Participant,
    id: &openmind_collab::MessageId,
) -> Result<(), String> {
    match frame(
        participant,
        |b| matches!(b, Body::Ack { of } | Body::Reject { of, .. } if of == id),
    )
    .await
    {
        Body::Ack { .. } => Ok(()),
        Body::Reject { reason, .. } => Err(reason),
        _ => unreachable!(),
    }
}

pub async fn ping(participant: &mut Participant, nonce: u64) {
    participant.send(Body::Ping { nonce }).expect("ping");
    frame(
        participant,
        |b| matches!(b, Body::Pong { nonce: n } if *n == nonce),
    )
    .await;
}
