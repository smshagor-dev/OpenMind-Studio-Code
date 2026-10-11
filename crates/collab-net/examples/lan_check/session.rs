//! The two sides of the check, with a few typed commands so each physical test step can be run and seen.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use openmind_collab::authority::Command;
use openmind_collab::{PeerIdentity, RoomCode};
use openmind_collab_net::ice::IceSetup;
use openmind_collab_net::lan::host::{LanHost, LanHostConfig};
use openmind_collab_net::lan::parse_endpoint;
use openmind_collab_net::owner::{OwnerEvent, OwnerNetwork, OwnerOptions};
use openmind_collab_net::participant::{JoinMode, ParticipantConfig};
use openmind_collab_net::relay::TurnRelay;
use openmind_collab_net::remote::{self, RemoteEvent, RemoteWorkspace};
use openmind_collab_net::route::{self, LanOptions, RouteOptions};
use openmind_collab_net::signaling::multi::MultiSignaling;
use openmind_collab_net::stun::StunGatherer;
use openmind_file_watch::{ChangeKind, FileWatcher};
use tokio::sync::mpsc;

use crate::owner::{relative, DiskAuthority};

/// Lines typed on the console.
fn console() -> mpsc::UnboundedReceiver<String> {
    let (tx, rx) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        while std::io::stdin().read_line(&mut line).is_ok_and(|n| n > 0) {
            if tx.send(line.trim().to_string()).is_err() {
                break;
            }
            line.clear();
        }
    });
    rx
}

fn no_internet() -> (IceSetup, Arc<StunGatherer>, Arc<TurnRelay>) {
    (
        IceSetup::default(),
        Arc::new(StunGatherer::new(Vec::new())),
        Arc::new(TurnRelay::new(Vec::new())),
    )
}

pub async fn host(folder: &Path) -> Result<(), String> {
    let authority = DiskAuthority::new(folder)?;
    authority.rescan(&[]).await;
    println!(
        "[lan-check] sharing {} files and folders (secrets and generated folders left out)",
        authority.files().await
    );
    let code = authority.authority.lock().await.invite().display();
    let topic = authority.authority.lock().await.invite().signaling_topic();
    let mut lan = LanHost::start(&topic, LanHostConfig::default())
        .await
        .map_err(|e| e.to_string())?;
    let (ice, gatherer, relay) = no_internet();
    let options = OwnerOptions {
        ice,
        gatherer,
        relay,
        peer_connect_timeout: Duration::from_secs(15),
        handshake_timeout: Duration::from_secs(30),
    };
    let route = lan.route().ok_or("the rendezvous didn't start")?;
    let (owner, mut events) = OwnerNetwork::start(
        authority.clone(),
        Arc::new(MultiSignaling::new(vec![route])),
        options,
    );
    crate::interfaces();
    println!("[lan-check] Room Code (give it to the participant; not written anywhere): {code}");
    println!("[lan-check] hosting: {:?}", lan.status());
    firewall_note();
    println!("[lan-check] commands: status | rotate | ban | quit");
    let (batches_tx, mut batches) = mpsc::unbounded_channel();
    let _watcher = FileWatcher::start(
        authority.root(),
        Arc::new(move |batch| {
            let _ = batches_tx.send(batch);
        }),
    )
    .map_err(|e| e.to_string())?;
    let mut input = console();
    loop {
        tokio::select! {
            Some(event) = events.recv() => print_owner_event(&event),
            Some(batch) = batches.recv() => {
                let root = authority.root().to_path_buf();
                let renames: Vec<_> = batch.changes.iter()
                    .filter(|c| c.kind == ChangeKind::Renamed)
                    .filter_map(|c| Some((relative(&root, c.from.as_deref()?)?, relative(&root, &c.path)?)))
                    .collect();
                if let Some(change) = authority.rescan(&renames).await {
                    println!("[lan-check] tree changed ({} rename(s) reported by the watcher): sent to participants", renames.len());
                    owner.tree_changed(change);
                }
            }
            Some(line) = input.recv() => match line.as_str() {
                "status" => println!("[lan-check] hosting: {:?}", lan.status()),
                "rotate" => {
                    authority.command(Command::RotateInvite).await?;
                    let code = authority.authority.lock().await.invite().display();
                    lan.set_topic(&authority.authority.lock().await.invite().signaling_topic());
                    owner.rehost();
                    println!("[lan-check] new Room Code (the old one no longer works): {code}");
                }
                "ban" => {
                    for peer in authority.members().await {
                        authority.command(Command::Ban { target: peer.clone() }).await?;
                        owner.close_peer(peer);
                    }
                    println!("[lan-check] every member is banned and disconnected");
                }
                "quit" => break,
                _ => println!("[lan-check] commands: status | rotate | ban | quit"),
            },
        }
    }
    owner.stop();
    lan.stop().await;
    Ok(())
}

/// What Windows Firewall will do with other computers' connections to this program (read-only).
fn firewall_note() {
    use openmind_collab_net::lan::firewall::{check, FirewallVerdict};
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let status = check(&exe, Duration::from_secs(10));
    let meaning = match status.verdict {
        FirewallVerdict::Allowed => "other computers may connect",
        FirewallVerdict::Blocked => "BLOCKED: a rule blocks inbound connections to this program; other computers can't join (allow it in Windows Defender Firewall, or ask IT)",
        FirewallVerdict::NoRule => "no rule yet: Windows asks when this program listens; choose Allow for the network type below, or ask IT",
        FirewallVerdict::Unknown => "couldn't be read",
    };
    println!(
        "[lan-check] Windows Firewall on {:?} networks: {meaning}",
        status.networks
    );
}

fn print_owner_event(event: &OwnerEvent) {
    match event {
        OwnerEvent::Admitted { peer, route, .. } => {
            println!("[lan-check] admitted {} over {route:?}", peer.fingerprint())
        }
        OwnerEvent::Left { peer, reason, .. } => {
            println!("[lan-check] {} left ({reason})", peer.fingerprint())
        }
        OwnerEvent::Link { state, .. } => println!("[lan-check] peer connection: {state:?}"),
        OwnerEvent::Signaling { state } => println!("[lan-check] rendezvous: {state:?}"),
        OwnerEvent::Pending { .. } => println!("[lan-check] a member waits for approval"),
        OwnerEvent::Path { path, .. } => println!("[lan-check] peer connection path: {path:?}"),
        OwnerEvent::Problem { message } => println!("[lan-check] problem: {message}"),
    }
}

fn config(code: RoomCode, mode: JoinMode) -> ParticipantConfig {
    let (ice, gatherer, relay) = no_internet();
    ParticipantConfig {
        code,
        display_name: "LAN check".into(),
        mode,
        ice,
        gatherer,
        relay,
        handshake_timeout: Duration::from_secs(15),
        approval_timeout: Duration::from_secs(120),
        on_pending: None,
    }
}

/// A joined session and what a rejoin needs.
struct Joined {
    workspace: Arc<RemoteWorkspace>,
    events: mpsc::UnboundedReceiver<RemoteEvent>,
    sender: openmind_collab_net::participant::ParticipantSender,
    room: openmind_collab::RoomUid,
    owner_key: openmind_collab::PublicKey,
    endpoint: Option<std::net::SocketAddr>,
    session: openmind_collab::SessionId,
}

async fn connect(
    identity: &PeerIdentity,
    config: ParticipantConfig,
    lan: LanOptions,
) -> Result<Joined, String> {
    let started = Instant::now();
    let options = RouteOptions {
        lan: Some(lan),
        internet: None,
    }; // the Internet route is off: only localLan can work
    let (result, report) = route::connect_with_report(identity.clone(), config, options).await;
    println!(
        "[lan-check] route report: {}",
        serde_json::to_string(&report).unwrap_or_default()
    );
    let routed = result.map_err(|e| e.to_string())?;
    println!(
        "[lan-check] joined in {} ms over {:?} at {:?}",
        started.elapsed().as_millis(),
        routed.route,
        routed.endpoint
    );
    let (room, owner_key) = (
        routed.participant.room().clone(),
        *routed.participant.owner_key(),
    );
    let session = routed.participant.admission().session.clone();
    let sender = routed.participant.sender();
    let (tx, events) = mpsc::unbounded_channel();
    let (workspace, _task) = remote::spawn(
        routed.participant,
        Arc::new(move |e| {
            let _ = tx.send(e);
        }),
    );
    Ok(Joined {
        workspace,
        events,
        sender,
        room,
        owner_key,
        endpoint: routed.endpoint,
        session,
    })
}

/// Waits for the tree and checks what must never be in it.
async fn tree_ready(joined: &mut Joined, started: Instant) -> Result<(), String> {
    tokio::time::timeout(Duration::from_secs(30), async {
        while let Some(event) = joined.events.recv().await {
            if matches!(event, RemoteEvent::TreeReady { .. }) {
                return;
            }
        }
    })
    .await
    .map_err(|_| "the shared tree didn't arrive in 30 s".to_string())?;
    let (count, leaks) = joined.workspace.tree(|t| {
        let leaks: Vec<String> = t
            .entries()
            .values()
            .filter(|e| {
                e.name.to_lowercase().starts_with(".env")
                    || e.path.as_str().contains(':')
                    || e.path.as_str().starts_with('/')
            })
            .map(|e| e.path.to_string())
            .collect();
        (t.entries().len(), leaks)
    });
    println!(
        "[lan-check] tree: {count} entries in {} ms (no file content downloaded)",
        started.elapsed().as_millis()
    );
    if leaks.is_empty() {
        println!("[lan-check] OK: no .env file, no absolute or drive path in the tree");
        Ok(())
    } else {
        Err(format!(
            "the tree contains entries that must never be shared: {leaks:?}"
        ))
    }
}

async fn open(joined: &Joined, path: Option<&str>) {
    let pick = joined.workspace.tree(|t| {
        let mut files = t
            .entries()
            .values()
            .filter(|e| e.kind == openmind_collab::FileKind::File);
        match path {
            Some(path) => files
                .find(|e| e.path.as_str().eq_ignore_ascii_case(path))
                .cloned(),
            None => files.max_by_key(|e| e.size).cloned(), // the largest file: several 64 KB chunks
        }
    });
    let Some(entry) = pick else {
        println!("[lan-check] no such file in the tree");
        return;
    };
    let started = Instant::now();
    match joined.workspace.fetch(entry.id.clone()).await {
        Ok(file) => println!(
            "[lan-check] OK: {} ({} bytes, {} chunk(s)) arrived in {} ms, SHA-256 {} verified, {}; document identity omcollab://{}/{}",
            entry.path,
            file.bytes.len(),
            openmind_collab::transfer::chunk_count(file.bytes.len() as u64),
            started.elapsed().as_millis(),
            file.sha256,
            if file.text { "text" } else { "binary" },
            joined.room,
            entry.id
        ),
        Err(err) => println!("[lan-check] {} couldn't be fetched: {err}", entry.path),
    }
}

fn print_remote(event: RemoteEvent) {
    match event {
        RemoteEvent::TreeDelta {
            upserts, removed, ..
        } => {
            for entry in upserts {
                println!(
                    "[lan-check] tree: {} is now at {} (id {})",
                    entry.kind.as_str(),
                    entry.path,
                    entry.id
                );
            }
            for id in removed {
                println!("[lan-check] tree: id {id} removed");
            }
        }
        RemoteEvent::State(state) => println!("[lan-check] connection: {state:?}"),
        RemoteEvent::TreeStale => {
            println!("[lan-check] tree: the Owner sent a new tree; fetching it")
        }
        _ => {}
    }
}

const JOIN_HELP: &str = "[lan-check] commands: ls | open <path> | big | reconnect | quit   (tree changes are printed as they arrive)";

pub async fn join(code: &str, addr: Option<&str>) -> Result<(), String> {
    let code = RoomCode::parse(code).map_err(|e| e.to_string())?;
    let manual = addr.map(parse_endpoint).transpose()?;
    crate::interfaces();
    let identity = PeerIdentity::generate().map_err(|e| e.to_string())?;
    let started = Instant::now();
    let mut joined = connect(
        &identity,
        config(code.clone(), JoinMode::Join),
        LanOptions {
            manual,
            ..LanOptions::default()
        },
    )
    .await?;
    tree_ready(&mut joined, started).await?;
    println!("{JOIN_HELP}");
    let mut input = console();
    loop {
        tokio::select! {
            Some(event) = joined.events.recv() => print_remote(event),
            Some(line) = input.recv() => match line.split_once(' ').map_or((line.as_str(), None), |(c, a)| (c, Some(a))) {
                ("ls", _) => joined.workspace.tree(|t| {
                    let mut paths: Vec<String> = t.entries().values().map(|e| e.path.to_string()).collect();
                    paths.sort();
                    paths.iter().for_each(|p| println!("  {p}"));
                }),
                ("open", path) => open(&joined, path).await,
                ("big", _) => open(&joined, None).await,
                ("reconnect", _) => {
                    joined.sender.close();
                    let mode = JoinMode::Reconnect { room: joined.room.clone(), owner_key: joined.owner_key };
                    let lan = LanOptions { manual, known: joined.endpoint, ..LanOptions::default() };
                    let old = joined.session.clone();
                    let started = Instant::now();
                    joined = connect(&identity, config(code.clone(), mode), lan).await?;
                    println!("[lan-check] fresh session: {}", if joined.session != old { "yes" } else { "NO" });
                    tree_ready(&mut joined, started).await?;
                }
                ("quit", _) => break,
                _ => println!("{JOIN_HELP}"),
            },
        }
    }
    joined.sender.close();
    Ok(())
}
