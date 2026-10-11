//! Applies the Owner's voice decisions on the media server (classroom mode). Runs whenever the call's roster changes
//! (a join, a leave, a kick or ban, a role or permission change, a force mute, the room closing): each member of the
//! call should publish exactly when OpenMind lets it speak, and nobody outside the call should be in the media room.
//! A member's own client follows the roster too, but this is what makes it hold even for a client that doesn't.
//! No polling: nothing runs unless the roster changed.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use openmind_collab::sfu::{media_identity, VoiceMode};
use tauri::{AppHandle, Manager};

use super::{lock, server, twirp, MediaServer};
use crate::app_state::AppState;

/// What to do on the media server to go from `applied` to `desired` (identity -> may publish).
pub fn plan(
    applied: &HashMap<String, bool>,
    desired: &HashMap<String, bool>,
) -> (Vec<(String, bool)>, Vec<String>) {
    let mut set: Vec<(String, bool)> = desired
        .iter()
        .filter(|(id, may)| applied.get(*id) != Some(*may))
        .map(|(id, may)| (id.clone(), *may))
        .collect();
    let mut remove: Vec<String> = applied
        .keys()
        .filter(|id| !desired.contains_key(*id))
        .cloned()
        .collect();
    set.sort();
    remove.sort();
    (set, remove)
}

fn apply(
    server: &MediaServer,
    room: &str,
    set: &[(String, bool)],
    remove: &[String],
) -> Vec<String> {
    let mut failed = Vec::new();
    for identity in remove {
        if let Err(err) = twirp::remove(&server.url, &server.api, room, identity) {
            failed.push(err);
        }
    }
    for (identity, may) in set {
        if let Err(err) = twirp::set_publish(&server.url, &server.api, room, identity, *may) {
            failed.push(err);
        }
    }
    failed
}

/// How long a removed identity could still hold a token the media server refreshed for it (LiveKit: 10 minutes).
const WATCH_FOR: Duration = Duration::from_secs(10 * 60);
/// The media room is listed at most this often for the watch list (only while something is watched).
const CHECK_EVERY: Duration = Duration::from_secs(3);

/// Identities removed from a room's media room in the last [`WATCH_FOR`], and when it was last listed for them. A
/// client that was removed but kept a refreshed token could reconnect on its own; OpenMind's own client never does (it
/// connects only with a new grant). Whenever the call changes, a watched identity found back in the media room is
/// removed again. Event-driven like the rest: nothing runs while the call is quiet.
#[derive(Default)]
pub struct Watch {
    removed: HashMap<String, Instant>,
    checked: Option<Instant>,
}

impl Watch {
    fn note(&mut self, identities: &[String], now: Instant) {
        for identity in identities {
            self.removed.insert(identity.clone(), now);
        }
    }

    /// The identities to look for now, if a look is due (expired ones and members granted again are forgotten).
    fn due(&mut self, desired: &HashMap<String, bool>, now: Instant) -> Option<Vec<String>> {
        self.removed
            .retain(|id, at| now.duration_since(*at) < WATCH_FOR && !desired.contains_key(id));
        let recent = self
            .checked
            .is_some_and(|at| now.duration_since(at) < CHECK_EVERY);
        if self.removed.is_empty() || recent {
            return None;
        }
        self.checked = Some(now);
        Some(self.removed.keys().cloned().collect())
    }
}

/// Watched identities that are back in the media room.
fn returned(server: &MediaServer, room: &str, watched: &[String]) -> Vec<String> {
    match twirp::participants(&server.url, &server.api, room) {
        Ok(present) => present
            .into_iter()
            .map(|(identity, _, _)| identity)
            .filter(|identity| watched.contains(identity))
            .collect(),
        Err(err) => {
            tracing::warn!(%err, "the media room couldn't be checked for removed members");
            Vec::new()
        }
    }
}

/// Brings the media server in line with the call. Nothing happens for a peer-to-peer room.
pub async fn sync(app: &AppHandle, room: &str) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let _one_at_a_time = state.collab.net.sfu.syncing.lock().await;
    let (mode, members) = state.collab.voice_media_members(room).await;
    let applied = lock(&state.collab.net.sfu.applied)
        .get(room)
        .cloned()
        .unwrap_or_default();
    let desired: HashMap<String, bool> =
        if mode == VoiceMode::Sfu && state.collab.net.hosting(room).is_some() {
            members
                .iter()
                .map(|(peer, may)| (media_identity(room, peer), *may))
                .collect()
        } else {
            HashMap::new()
        };
    let (set, remove) = plan(&applied, &desired);
    let watched = lock(&state.collab.net.sfu.watched)
        .entry(room.to_string())
        .or_default()
        .due(&desired, Instant::now());
    if set.is_empty() && remove.is_empty() && watched.is_none() {
        return;
    }
    let Ok(server) = server(&state).await else {
        // No media server any more: nothing on it to correct; start over when one is back.
        lock(&state.collab.net.sfu.applied).remove(room);
        lock(&state.collab.net.sfu.watched).remove(room);
        return;
    };
    let room_id = room.to_string();
    let set_c = set.clone();
    let mut remove_c = remove.clone();
    let (failed, removed) = tauri::async_runtime::spawn_blocking(move || {
        if let Some(watched) = watched {
            remove_c.extend(returned(&server, &room_id, &watched));
        }
        (apply(&server, &room_id, &set_c, &remove_c), remove_c)
    })
    .await
    .unwrap_or_else(|e| (vec![e.to_string()], Vec::new()));
    lock(&state.collab.net.sfu.watched)
        .entry(room.to_string())
        .or_default()
        .note(&removed, Instant::now());
    for err in &failed {
        tracing::warn!(%err, "the media server couldn't be brought in line with the call");
    }
    let mut all = lock(&state.collab.net.sfu.applied);
    if desired.is_empty() {
        all.remove(room);
    } else {
        all.insert(room.to_string(), desired);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, bool)]) -> HashMap<String, bool> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    #[test]
    fn removed_identities_are_watched_for_the_token_lifetime_then_forgotten() {
        let t0 = Instant::now();
        let mut watch = Watch::default();
        assert_eq!(
            watch.due(&HashMap::new(), t0),
            None,
            "nothing removed: nothing listed"
        );
        watch.note(&["kicked".to_string(), "rejoined".to_string()], t0);
        let first = watch.due(&map(&[("rejoined", false)]), t0).expect("due");
        assert_eq!(first, ["kicked"], "a member granted again isn't watched");
        assert_eq!(
            watch.due(&HashMap::new(), t0 + Duration::from_secs(1)),
            None,
            "not listed more often than every 3 s"
        );
        assert!(watch
            .due(&HashMap::new(), t0 + Duration::from_secs(4))
            .is_some());
        assert_eq!(
            watch.due(&HashMap::new(), t0 + WATCH_FOR),
            None,
            "forgotten after the token lifetime"
        );
    }

    #[test]
    fn only_differences_are_sent() {
        let applied = map(&[("a", true), ("b", true), ("gone", true)]);
        let desired = map(&[("a", true), ("b", false), ("new", false)]);
        let (set, remove) = plan(&applied, &desired);
        // b lost voice.speak (or was force-muted): publishing withdrawn on the server; new joined listen-only.
        assert_eq!(
            set,
            vec![("b".to_string(), false), ("new".to_string(), false)]
        );
        // gone left, was kicked or banned, or lost voice.join: out of the media room.
        assert_eq!(remove, vec!["gone".to_string()]);
        assert_eq!(
            plan(&desired, &desired),
            (Vec::new(), Vec::new()),
            "nothing changed, nothing sent"
        );
        // The room closed (or left classroom mode): everyone out.
        let (set, remove) = plan(&desired, &HashMap::new());
        assert!(set.is_empty() && remove.len() == 3);
    }
}
