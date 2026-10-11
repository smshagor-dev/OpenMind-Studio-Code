//! Room management over the real network (phase 8): every command a member sends is authorized by the Owner for that
//! member's session, whatever its UI showed; a turned-down join request is told so; banned peers, locked rooms and old
//! Room Codes are refused. An Owner database behind the real `CollabRuntime`, a real relay, real WebRTC on loopback.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use openmind_collab::authority::Command;
use openmind_collab::permission::{Overrides, Permission, PermissionSet, Role};
use openmind_collab::protocol::{Body, Frame, Refusal};
use openmind_collab::room::MemberStatus;
use openmind_collab::{PeerId, PeerIdentity, RoomCode, RoomUid};
use openmind_collab_net::ice::IceSetup;
use openmind_collab_net::owner::{OwnerEvent, OwnerNetwork, OwnerOptions};
use openmind_collab_net::participant::{
    self, JoinMode, Participant, ParticipantConfig, ParticipantEvent,
};
use openmind_collab_net::relay::TurnRelay;
use openmind_collab_net::route::RouteReport;
use openmind_collab_net::signaling::WsSignaling;
use openmind_collab_net::stun::StunGatherer;
use openmind_collab_net::{ConnectionState, NetError};
use openmind_collab_signal::{Relay, RelayConfig};
use openmind_db::Db;

use super::super::host::{CollabRuntime, CreatedRoom, NewHostedRoom};
use super::super::net_manage::classify;
use super::tests::{wait_owner, RuntimeAuthority, WAIT};

struct World {
    _dir: tempfile::TempDir,
    db: Db,
    runtime: Arc<CollabRuntime>,
    created: CreatedRoom,
    owner: OwnerNetwork,
    events: tokio::sync::mpsc::UnboundedReceiver<OwnerEvent>,
    url: String,
    _relay: Relay,
}

fn ice() -> IceSetup {
    IceSetup {
        bind_ip: Some("127.0.0.1".parse().expect("ip")),
        ..IceSetup::default()
    }
}

async fn world() -> World {
    let dir = tempfile::tempdir().expect("dir");
    let db = Db::connect(&dir.path().join("owner.db")).await.expect("db");
    let runtime = Arc::new(CollabRuntime::default());
    let new = NewHostedRoom {
        name: "Physics",
        display_name: "Teacher",
        workspace_path: "C:/w",
        workspace_name: "w",
    };
    let created = runtime.create_room(&db, &new, 1).await.expect("room");
    let relay = Relay::start("127.0.0.1:0".parse().expect("addr"), RelayConfig::default())
        .await
        .expect("relay");
    let url = format!("ws://{}", relay.addr());
    let authority = Arc::new(RuntimeAuthority {
        runtime: runtime.clone(),
        db: db.clone(),
        room: RoomUid::parse(&created.room_uid).expect("uid"),
    });
    let options = OwnerOptions {
        ice: ice(),
        gatherer: Arc::new(StunGatherer::new(Vec::new())),
        relay: Arc::new(TurnRelay::new(Vec::new())),
        peer_connect_timeout: Duration::from_secs(10),
        handshake_timeout: Duration::from_secs(15),
    };
    let (owner, mut events) =
        OwnerNetwork::start(authority, Arc::new(WsSignaling::direct(&url)), options);
    let registered = |e: &OwnerEvent| {
        matches!(
            e,
            OwnerEvent::Signaling {
                state: ConnectionState::Connected
            }
        )
    };
    wait_owner(&mut events, registered).await;
    World {
        _dir: dir,
        db,
        runtime,
        created,
        owner,
        events,
        url,
        _relay: relay,
    }
}

impl World {
    fn config(
        &self,
        code: &str,
        name: &str,
        pending: Option<Arc<AtomicBool>>,
    ) -> ParticipantConfig {
        ParticipantConfig {
            code: RoomCode::parse(code).expect("code"),
            display_name: name.into(),
            mode: JoinMode::Join,
            ice: ice(),
            gatherer: Arc::new(StunGatherer::new(Vec::new())),
            relay: Arc::new(TurnRelay::new(Vec::new())),
            handshake_timeout: Duration::from_secs(6),
            approval_timeout: WAIT,
            on_pending: pending.map(|flag| {
                Arc::new(move || flag.store(true, Ordering::Relaxed)) as Arc<dyn Fn() + Send + Sync>
            }),
        }
    }

    async fn try_join(&self, who: &PeerIdentity, code: &str) -> Result<Participant, NetError> {
        let config = self.config(code, "Member", None);
        participant::connect(
            who.clone(),
            config,
            Arc::new(WsSignaling::direct(&self.url)),
        )
        .await
    }

    async fn join(&self, who: &PeerIdentity) -> Participant {
        self.try_join(who, &self.created.code)
            .await
            .expect("joined")
    }

    /// A command run by the Owner's own UI, with its network effects applied as `apply_effects` does.
    async fn host(&self, command: Command) -> Result<(), String> {
        let effects = self
            .runtime
            .run_command(&self.db, &self.created.room_uid, command, 30)
            .await?;
        for peer in effects.ended {
            self.owner.close_peer(peer);
        }
        if let Some(peer) = effects.approved {
            self.owner.approved(peer);
        }
        for (peer, refusal) in effects.refused {
            self.owner.refuse(peer, refusal);
        }
        if effects.rotated {
            self.owner.rehost();
        }
        Ok(())
    }
}

/// Sends `command` as a member and waits for the Owner's answer.
async fn remote(member: &mut Participant, command: Command) -> Result<(), String> {
    let id = member.send(Body::Command { command }).expect("send");
    tokio::time::timeout(WAIT, async {
        loop {
            match member.next_event().await.expect("events") {
                ParticipantEvent::Frame(Frame {
                    body: Body::Ack { of },
                    ..
                }) if of == id => return Ok(()),
                ParticipantEvent::Frame(Frame {
                    body: Body::Reject { of, reason },
                    ..
                }) if of == id => return Err(reason),
                _ => {}
            }
        }
    })
    .await
    .expect("an answer in time")
}

fn role(target: &PeerIdentity, role: Role) -> Command {
    Command::ChangeRole {
        target: target.peer_id(),
        role,
    }
}

#[test]
fn every_management_command_is_decided_by_the_owner_for_the_senders_session() {
    tauri::async_runtime::block_on(async {
        let w = world().await;
        let (ada_id, vic_id) = (
            PeerIdentity::generate().expect("id"),
            PeerIdentity::generate().expect("id"),
        );
        let mut ada = w.join(&ada_id).await;
        let mut vic = w.join(&vic_id).await;
        let owner: PeerId = w.runtime.identity(&w.db).await.expect("identity").peer_id();

        // A Viewer attempting a moderator's action.
        let refused = remote(&mut vic, role(&ada_id, Role::Editor))
            .await
            .expect_err("viewer");
        assert!(refused.contains("member.changeRole"), "{refused}");
        assert!(remote(&mut vic, Command::SetLocked { locked: true })
            .await
            .is_err());

        // An Admin without the explicit member permissions (they aren't Admin defaults).
        w.host(role(&ada_id, Role::Admin)).await.expect("promote");
        assert!(remote(&mut ada, role(&vic_id, Role::Editor)).await.is_err());
        assert!(remote(
            &mut ada,
            Command::Ban {
                target: vic_id.peer_id()
            }
        )
        .await
        .is_err());
        // ... but with Admin defaults it may lock and kick lower ranks.
        assert_eq!(
            remote(&mut ada, Command::SetLocked { locked: true }).await,
            Ok(())
        );
        assert_eq!(
            remote(&mut ada, Command::SetLocked { locked: false }).await,
            Ok(())
        );

        // Granted, the change works; still nothing at or above its own rank, and never on itself.
        let grant = Overrides {
            grant: PermissionSet::of(&[Permission::MemberChangeRole]),
            deny: PermissionSet::EMPTY,
        };
        w.host(Command::SetOverrides {
            target: ada_id.peer_id(),
            overrides: grant,
        })
        .await
        .expect("grant");
        assert_eq!(remote(&mut ada, role(&vic_id, Role::Editor)).await, Ok(()));
        let up = remote(&mut ada, role(&vic_id, Role::Admin))
            .await
            .expect_err("own rank");
        assert!(up.contains("equal to or above yours"), "{up}");
        assert!(remote(
            &mut ada,
            Command::ChangeRole {
                target: ada_id.peer_id(),
                role: Role::Owner
            }
        )
        .await
        .is_err());
        let owner_kick = remote(
            &mut ada,
            Command::Kick {
                target: owner.clone(),
            },
        )
        .await
        .expect_err("owner");
        assert!(
            owner_kick.contains("equal to or above yours"),
            "{owner_kick}"
        );
        let self_ban = remote(
            &mut ada,
            Command::Ban {
                target: ada_id.peer_id(),
            },
        )
        .await
        .expect_err("self");
        assert!(
            self_ban.contains("permission") || self_ban.contains("yourself"),
            "{self_ban}"
        );
        // Granting itself (or anyone) a permission needs member.managePermissions, which Ada lacks.
        let escalate = Overrides {
            grant: PermissionSet::of(&[Permission::MemberBan]),
            deny: PermissionSet::EMPTY,
        };
        assert!(remote(
            &mut ada,
            Command::SetOverrides {
                target: vic_id.peer_id(),
                overrides: escalate
            }
        )
        .await
        .is_err());
        // Only the Owner can transfer ownership or close the room.
        assert!(remote(
            &mut ada,
            Command::TransferOwnership {
                target: vic_id.peer_id()
            }
        )
        .await
        .is_err());
        assert!(remote(&mut ada, Command::CloseRoom).await.is_err());

        // Stale UI: the Owner demotes Ada while her menu is open; her next command is refused.
        w.host(role(&ada_id, Role::Viewer)).await.expect("demote");
        assert!(remote(&mut ada, role(&vic_id, Role::Viewer)).await.is_err());

        // A forged permission name never even decodes.
        let forged = format!(
            r#"{{"command":"setOverrides","target":"{}","overrides":{{"grant":["root"]}}}}"#,
            vic_id.peer_id()
        );
        assert!(serde_json::from_str::<Command>(&forged).is_err());
    });
}

#[test]
fn the_room_view_follows_each_members_own_permissions() {
    tauri::async_runtime::block_on(async {
        let w = world().await;
        let (ada_id, vic_id) = (
            PeerIdentity::generate().expect("id"),
            PeerIdentity::generate().expect("id"),
        );
        let _ada = w.join(&ada_id).await;
        let _vic = w.join(&vic_id).await;
        let room = w.created.room_uid.as_str();
        let view = w
            .runtime
            .room_view(room, &vic_id.peer_id())
            .await
            .expect("view");
        assert_eq!(view.you.role, Role::Viewer);
        assert!(view.members.iter().all(|m| m.granted.is_none()));
        w.host(role(&ada_id, Role::Admin)).await.expect("promote");
        let grant = Overrides {
            grant: PermissionSet::of(&[Permission::MemberManagePermissions]),
            deny: PermissionSet::EMPTY,
        };
        w.host(Command::SetOverrides {
            target: ada_id.peer_id(),
            overrides: grant,
        })
        .await
        .expect("grant");
        let view = w
            .runtime
            .room_view(room, &ada_id.peer_id())
            .await
            .expect("view");
        assert_eq!(view.you.role, Role::Admin);
        let vic = view
            .members
            .iter()
            .find(|m| m.peer == vic_id.peer_id())
            .expect("vic");
        assert!(vic.online && vic.permissions.is_some());
    });
}

#[test]
fn a_turned_down_join_request_is_told_and_banned_locked_and_old_codes_are_refused() {
    tauri::async_runtime::block_on(async {
        let mut w = world().await;
        w.host(Command::SetApproval { required: true })
            .await
            .expect("approval");
        let waiting = PeerIdentity::generate().expect("id");
        let flag = Arc::new(AtomicBool::new(false));
        let config = w.config(&w.created.code, "Waiting", Some(flag.clone()));
        let url = w.url.clone();
        let join = tokio::spawn(async move {
            participant::connect(waiting.clone(), config, Arc::new(WsSignaling::direct(&url))).await
        });
        wait_owner(&mut w.events, |e| matches!(e, OwnerEvent::Pending { .. })).await;
        let room = w.created.room_uid.clone();
        let snapshot = w
            .runtime
            .room_view(
                &room,
                &w.runtime.identity(&w.db).await.expect("id").peer_id(),
            )
            .await;
        let pending = snapshot
            .expect("view")
            .members
            .into_iter()
            .find(|m| m.status == MemberStatus::Pending);
        let target = pending.expect("a waiting member").peer;
        w.host(Command::DenyJoin { target }).await.expect("deny");
        let err = join.await.expect("task").err().expect("denied");
        assert!(
            flag.load(Ordering::Relaxed),
            "the participant heard it was waiting"
        );
        assert!(matches!(err, NetError::Refused(Refusal::Denied)), "{err:?}");
        assert_eq!(classify(&err, &empty_report(), true).kind, "denied");

        // Approval off again; a banned member can't come back, even with the right code.
        w.host(Command::SetApproval { required: false })
            .await
            .expect("approval off");
        let bo = PeerIdentity::generate().expect("id");
        let _session = w.join(&bo).await;
        w.host(Command::Ban {
            target: bo.peer_id(),
        })
        .await
        .expect("ban");
        let banned = w
            .try_join(&bo, &w.created.code)
            .await
            .err()
            .expect("banned");
        assert_eq!(classify(&banned, &empty_report(), false).kind, "banned");

        // A locked room refuses newcomers.
        w.host(Command::SetLocked { locked: true })
            .await
            .expect("lock");
        let late = PeerIdentity::generate().expect("id");
        let locked = w
            .try_join(&late, &w.created.code)
            .await
            .err()
            .expect("locked");
        assert_eq!(classify(&locked, &empty_report(), false).kind, "locked");
        w.host(Command::SetLocked { locked: false })
            .await
            .expect("unlock");

        // After a rotation the old code no longer finds the room; the new one does.
        let old = w.created.code.clone();
        w.host(Command::RotateInvite).await.expect("rotate");
        let fresh = w.runtime.invite_code(&w.db, &room, 40).await.expect("code");
        assert_ne!(fresh, old);
        assert!(
            w.try_join(&late, &old).await.is_err(),
            "the old Room Code stops working"
        );
        // The new one works as soon as the Owner is registered under its topic again (no reconnect of anyone).
        let mut joined = false;
        for _ in 0..10 {
            if w.try_join(&late, &fresh).await.is_ok() {
                joined = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        assert!(joined, "the new Room Code works");
    });
}

fn empty_report() -> RouteReport {
    RouteReport {
        lan_tried: false,
        discovered: Vec::new(),
        attempts: Vec::new(),
        discovery_millis: 0,
        discovery_problems: Vec::new(),
        route: None,
        failure: None,
    }
}
