//! The media server's management API (LiveKit's RoomService over Twirp/JSON), used only by the Owner's computer to
//! enforce OpenMind's decisions: a member who may no longer speak loses publishing on the server too (not just in its
//! own client), and a member out of the call (left, kicked, banned, `voice.join` revoked, room closed) is removed.
//! Each call carries a one-minute admin token for that media room only; the API secret never leaves this computer.
//!
//! Transport: `https://` with the shared, proxy-aware agent (certificate verification always on) — or plain `http://`
//! only for a server on this computer or the local network (a classroom server), which never goes through a proxy.

use std::net::IpAddr;
use std::time::Duration;

use openmind_collab::sfu::{admin_token, media_room, ApiKey};
use serde_json::{json, Value};

const LIMIT: Duration = Duration::from_secs(5);

/// The HTTP(S) base of a media server's ws(s):// address, refusing plain HTTP beyond the local network.
pub fn http_base(url: &str) -> Result<String, String> {
    let (scheme, rest) = if let Some(rest) = url.strip_prefix("wss://") {
        ("https", rest)
    } else if let Some(rest) = url.strip_prefix("ws://") {
        ("http", rest)
    } else {
        return Err("The media server address must start with ws:// or wss://.".into());
    };
    let host_port = rest.split('/').next().unwrap_or_default();
    if host_port.is_empty() || host_port.contains('@') {
        return Err("The media server address has no host.".into());
    }
    if scheme == "http" && !is_local_host(host_port) {
        return Err(
            "A media server outside the local network must use wss:// (TLS). Plain ws:// is only for a server on this \
             computer or the local network."
                .into(),
        );
    }
    Ok(format!("{scheme}://{host_port}"))
}

/// Loopback or a private/link-local address (a classroom LAN), as `host[:port]`.
fn is_local_host(host_port: &str) -> bool {
    let host = if let Some(inner) = host_port.strip_prefix('[') {
        inner.split(']').next().unwrap_or_default()
    } else {
        host_port.rsplit_once(':').map_or(host_port, |(h, _)| h)
    };
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Ok(IpAddr::V6(ip)) => {
            ip.is_loopback()
                || (ip.segments()[0] & 0xfe00) == 0xfc00
                || (ip.segments()[0] & 0xffc0) == 0xfe80
        }
        Err(_) => false,
    }
}

fn agent(base: &str) -> ureq::Agent {
    if base.starts_with("https://") {
        let timeouts = openmind_network::http::Timeouts {
            connect: LIMIT,
            response: LIMIT,
            body: LIMIT,
        };
        return openmind_network::http::agent(base, timeouts, Some(0));
    }
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(LIMIT))
        .timeout_recv_response(Some(LIMIT))
        .timeout_recv_body(Some(LIMIT))
        .proxy(None)
        .max_redirects(0)
        .build()
        .into()
}

/// One RoomService call; `Ok(None)` when the server answered "not found" (nothing to do).
fn call(
    url: &str,
    api: &ApiKey,
    room_uid: &str,
    method: &str,
    body: &Value,
) -> Result<Option<Value>, String> {
    let base = http_base(url)?;
    let now = super::now_secs();
    let token = admin_token(api, room_uid, now).map_err(|e| e.to_string())?;
    let endpoint = format!("{base}/twirp/livekit.RoomService/{method}");
    let mut response = agent(&base)
        .post(&endpoint)
        .header("Authorization", &format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .send(body.to_string())
        .map_err(|e| {
            format!(
                "The media server couldn't be reached ({method}): {}",
                short(&e.to_string())
            )
        })?;
    let status = response.status().as_u16();
    if status == 404 {
        return Ok(None);
    }
    let text = response.body_mut().read_to_string().unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(format!(
            "The media server refused {method} (HTTP {status})."
        ));
    }
    Ok(Some(serde_json::from_str(&text).unwrap_or(Value::Null)))
}

/// An error message without anything after the first line (never a token: it is only in a header).
fn short(text: &str) -> String {
    text.lines()
        .next()
        .unwrap_or_default()
        .chars()
        .take(160)
        .collect()
}

/// Whether `identity` may publish its microphone (the server unpublishes it at once when not).
pub fn set_publish(
    url: &str,
    api: &ApiKey,
    room_uid: &str,
    identity: &str,
    can_publish: bool,
) -> Result<(), String> {
    let sources: Vec<&str> = if can_publish {
        vec!["MICROPHONE"]
    } else {
        Vec::new()
    };
    let body = json!({
        "room": media_room(room_uid),
        "identity": identity,
        "permission": {
            "canSubscribe": true,
            "canPublish": can_publish,
            "canPublishData": false,
            "canPublishSources": sources,
        },
    });
    call(url, api, room_uid, "UpdateParticipant", &body).map(drop)
}

/// Removes `identity` from the media room (nothing happens when it isn't there).
///
/// Its rights are taken away first. A LiveKit server hands each connected client a refreshed token (every 5 minutes,
/// valid 10, with the participant's *current* grants) and refreshes it again when the grants change; tokens can't be
/// revoked. Revoking first means the last token this client receives lets it neither listen nor speak, so a modified
/// client that keeps it and reconnects gets nothing from the room (older refreshed tokens are covered by the Owner's
/// watch list in `enforce`).
pub fn remove(url: &str, api: &ApiKey, room_uid: &str, identity: &str) -> Result<(), String> {
    let revoke = json!({
        "room": media_room(room_uid),
        "identity": identity,
        "permission": {
            "canSubscribe": false,
            "canPublish": false,
            "canPublishData": false,
            "canPublishSources": [],
        },
    });
    call(url, api, room_uid, "UpdateParticipant", &revoke)?;
    let body = json!({ "room": media_room(room_uid), "identity": identity });
    call(url, api, room_uid, "RemoveParticipant", &body).map(drop)
}

/// Who is in the media room now: (identity, may publish, published audio tracks).
pub fn participants(
    url: &str,
    api: &ApiKey,
    room_uid: &str,
) -> Result<Vec<(String, bool, usize)>, String> {
    let body = json!({ "room": media_room(room_uid) });
    let Some(answer) = call(url, api, room_uid, "ListParticipants", &body)? else {
        return Ok(Vec::new());
    };
    let list = answer["participants"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    Ok(list
        .iter()
        .map(|p| {
            let identity = p["identity"].as_str().unwrap_or_default().to_string();
            // Twirp answers with the proto field names (`can_publish`); accept the JSON name too.
            let permission = &p["permission"];
            let can_publish = permission["can_publish"]
                .as_bool()
                .or_else(|| permission["canPublish"].as_bool())
                .unwrap_or(false);
            let audio = p["tracks"].as_array().map_or(0, |tracks| {
                tracks
                    .iter()
                    .filter(|t| t["type"] == "AUDIO" || t["type"] == 0)
                    .count()
            });
            (identity, can_publish, audio)
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_http_only_on_this_computer_or_the_local_network() {
        assert_eq!(
            http_base("ws://192.168.1.20:7880").as_deref(),
            Ok("http://192.168.1.20:7880")
        );
        assert_eq!(
            http_base("ws://127.0.0.1:7880/rtc").as_deref(),
            Ok("http://127.0.0.1:7880")
        );
        assert_eq!(
            http_base("ws://10.0.0.5:7880").as_deref(),
            Ok("http://10.0.0.5:7880")
        );
        assert_eq!(
            http_base("wss://media.example.edu").as_deref(),
            Ok("https://media.example.edu")
        );
        assert!(
            http_base("ws://media.example.edu:7880").is_err(),
            "a public server must use TLS"
        );
        assert!(http_base("ws://8.8.8.8:7880").is_err());
        assert!(http_base("http://192.168.1.20").is_err());
        assert!(http_base("wss://user:pass@media.example.edu").is_err());
        assert!(http_base("wss://").is_err());
    }
}
