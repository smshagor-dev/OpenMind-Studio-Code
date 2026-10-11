//! Room management from any member's computer (Milestone 24, phase 8), plus what a joining member is told.
//!
//! - **Commands as a participant** (`collab_remote_command`): a member that may manage (an Admin, a new Owner after a
//!   transfer) sends the same [`Command`] the Owner's own UI runs; the Owner authorizes it like any other actor and
//!   answers `Ack`/`Reject`, which this side waits for. Nothing is decided here.
//! - **The permission model** (`collab_permission_model`): the backend's permissions, groups and role defaults as data,
//!   so the UI has no permission list of its own.
//! - **Joining**: progress (`collab:join`: searching, connecting, waiting for approval, connected) and a failure
//!   *category* ([`JoinError`]) the UI turns into a sentence; never a Room Code.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use openmind_collab::protocol::{Body, Refusal};
use openmind_collab::Command;
use openmind_collab_net::remote::DocEvent;
use openmind_collab_net::route::{RouteFailure, RouteReport};
use openmind_collab_net::NetError;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

use crate::app_state::AppState;

pub const JOIN_EVENT: &str = "collab:join";
/// How long a member's command waits for the Owner's answer.
const ANSWER_WAIT: Duration = Duration::from_secs(15);

/// A join that didn't work, as a category the UI explains (and the backend's own sentence for details).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinError {
    /// invalidCode, notFound, blocked, locked, banned, closed, denied, full, notMember, approvalTimeout,
    /// relayUnavailable, version, connectionLost, notConfigured, noDisplayName, alreadyJoined, other.
    pub kind: &'static str,
    pub message: String,
}

impl JoinError {
    pub fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl From<String> for JoinError {
    fn from(message: String) -> Self {
        Self::new("other", message)
    }
}

/// The category of a failed connection attempt (`pending`: the Owner had said "waiting for approval").
pub fn classify(err: &NetError, report: &RouteReport, pending: bool) -> JoinError {
    let kind = match err {
        NetError::Refused(refusal) => match refusal {
            Refusal::InvalidInvite | Refusal::WrongRoom | Refusal::BadSignature => "invalidCode",
            Refusal::Banned => "banned",
            Refusal::Locked => "locked",
            Refusal::Closed => "closed",
            Refusal::Denied => "denied",
            Refusal::Full => "full",
            Refusal::NotAMember => "notMember",
            Refusal::WrongChallenge | Refusal::InvalidName => "other",
        },
        NetError::Timeout(_) if pending => "approvalTimeout",
        NetError::NoRoute(_) | NetError::Timeout(_) => match report.failure {
            Some(RouteFailure::Blocked) => "blocked",
            Some(RouteFailure::Refused) => "denied",
            Some(RouteFailure::NotFound) | None => "notFound",
        },
        // The relay answered: nobody hosts this code (a wrong or old code, or the Owner isn't hosting).
        NetError::Relay(openmind_collab_signal::ErrorCode::NoHost) => "notFound",
        NetError::Relay(openmind_collab_signal::ErrorCode::UnsupportedVersion) => "version",
        NetError::Signaling(_) | NetError::Relay(_) => "relayUnavailable",
        NetError::Protocol(text) if text.contains("version") => "version",
        NetError::Closed => "connectionLost",
        NetError::Config(_) => "notConfigured",
        _ => "other",
    };
    JoinError::new(kind, err.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JoinProgress<'a> {
    stage: &'a str,
}

/// Tells the windows how a join is going: `searching` (local network), `connecting`, `pending`, `connected`.
pub fn progress(app: &AppHandle, stage: &str) {
    let _ = app.emit(JOIN_EVENT, JoinProgress { stage });
}

/// Commands this computer sent as a participant, waiting for the Owner's answer (by message id).
#[derive(Default)]
pub struct CommandWaits {
    waiting: Mutex<HashMap<String, oneshot::Sender<Result<(), String>>>>,
}

impl CommandWaits {
    fn lock(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<String, oneshot::Sender<Result<(), String>>>> {
        self.waiting
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// An acknowledgement or refusal: `true` when it answered a command sent here.
    pub fn answered(&self, event: &DocEvent) -> bool {
        let (frame, result) = match event {
            DocEvent::Acked { frame } => (frame, Ok(())),
            DocEvent::Rejected { frame, reason } => (frame, Err(reason.clone())),
            _ => return false,
        };
        match self.lock().remove(frame.as_str()) {
            Some(answer) => {
                let _ = answer.send(result);
                true
            }
            None => false,
        }
    }
}

/// Runs `command` in a joined room as this member; the Owner decides and the answer comes back.
#[tauri::command]
pub async fn collab_remote_command(
    state: State<'_, AppState>,
    room_uid: String,
    command: Command,
) -> Result<(), String> {
    command.validate().map_err(|e| e.to_string())?;
    send_and_wait(&state, &room_uid, Body::Command { command }).await
}

/// Sends `body` to a joined room's Owner and waits for its acknowledgement or refusal.
pub async fn send_and_wait(state: &AppState, room_uid: &str, body: Body) -> Result<(), String> {
    let sender = state
        .collab
        .net
        .joined(room_uid)
        .ok_or("You are not connected to this room.")?;
    let (answer, wait) = oneshot::channel();
    // Registered before sending, so an answer can't arrive first.
    let id = {
        let mut waiting = state.collab.net.command_waits.lock();
        let id = sender.send(body).map_err(|e| e.to_string())?;
        waiting.insert(id.to_string(), answer);
        id
    };
    let result = tokio::time::timeout(ANSWER_WAIT, wait).await;
    state.collab.net.command_waits.lock().remove(id.as_str());
    match result {
        Ok(Ok(answer)) => answer,
        Ok(Err(_)) | Err(_) => {
            Err("The room didn't answer. Check the connection and try again.".into())
        }
    }
}

/// The backend's permissions (names, groups), each role's defaults and the Owner-only ones.
#[tauri::command]
pub fn collab_permission_model() -> openmind_collab::roomview::PermissionModel {
    openmind_collab::roomview::permission_model()
}

/// Answers waiting commands from the participant listener; other document events go on to `net_docs`.
pub fn intercept(app: &AppHandle, event: &DocEvent) -> bool {
    app.try_state::<AppState>().is_some_and(|state| {
        state.collab.net.command_waits.answered(event)
            || state.collab.net.voice.media_rejected(event)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(failure: Option<RouteFailure>) -> RouteReport {
        RouteReport {
            lan_tried: true,
            discovered: Vec::new(),
            attempts: Vec::new(),
            discovery_millis: 0,
            discovery_problems: Vec::new(),
            route: None,
            failure,
        }
    }

    #[test]
    fn failures_become_categories_the_ui_can_explain() {
        let none = report(None);
        let kind =
            |err: NetError, report: &RouteReport, pending| classify(&err, report, pending).kind;
        assert_eq!(
            kind(NetError::Refused(Refusal::InvalidInvite), &none, false),
            "invalidCode"
        );
        assert_eq!(
            kind(NetError::Refused(Refusal::Locked), &none, false),
            "locked"
        );
        assert_eq!(
            kind(NetError::Refused(Refusal::Banned), &none, false),
            "banned"
        );
        assert_eq!(
            kind(NetError::Refused(Refusal::Denied), &none, false),
            "denied"
        );
        assert_eq!(
            kind(NetError::Refused(Refusal::Closed), &none, false),
            "closed"
        );
        assert_eq!(
            kind(NetError::Timeout("waiting"), &none, true),
            "approvalTimeout"
        );
        let blocked = report(Some(RouteFailure::Blocked));
        assert_eq!(
            kind(NetError::NoRoute("x".into()), &blocked, false),
            "blocked"
        );
        assert_eq!(
            kind(NetError::NoRoute("x".into()), &none, false),
            "notFound"
        );
        assert_eq!(
            kind(NetError::Signaling("down".into()), &none, false),
            "relayUnavailable"
        );
        assert_eq!(
            kind(
                NetError::Protocol("unsupported version 9".into()),
                &none,
                false
            ),
            "version"
        );
        assert_eq!(kind(NetError::Closed, &none, false), "connectionLost");
    }

    #[test]
    fn an_answer_reaches_only_the_command_it_belongs_to() {
        let waits = CommandWaits::default();
        let id = openmind_collab::MessageId::random().expect("id");
        let other = openmind_collab::MessageId::random().expect("id");
        let (tx, mut rx) = oneshot::channel();
        waits.lock().insert(id.to_string(), tx);
        assert!(!waits.answered(&DocEvent::Acked { frame: other }));
        let refused = DocEvent::Rejected {
            frame: id,
            reason: "that member's role is equal to or above yours".into(),
        };
        assert!(waits.answered(&refused));
        assert_eq!(
            rx.try_recv().expect("answer"),
            Err("that member's role is equal to or above yours".into())
        );
    }
}
