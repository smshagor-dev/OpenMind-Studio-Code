//! The discovery datagrams: a JSON object marked as ours (`"m": "openmind-deploy"`) with the protocol version `v`.
//!
//! - **query** (`"t": "q"`): a random `nonce`; nothing else, so a query reveals nothing about the asker;
//! - **answer** (`"t": "a"`): the query's `nonce` and the answering deployment's [`Advert`].
//!
//! [`decode`] tells apart what isn't ours at all (ignored silently: the port may be shared with anything), what is ours
//! but broken (counted), and what is ours in another protocol version (reported as an incompatible deployment, with
//! whatever it says its id and version are — so a computer can say "a newer OpenMind Studio is out there" instead of
//! "nothing found").

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::advert::Advert;
use crate::{is_hex, PROTOCOL};

/// The marker of every packet.
pub const MARK: &str = "openmind-deploy";
/// A packet never exceeds this (one Ethernet frame without fragmentation).
pub const MAX_PACKET: usize = 1400;
/// A query is padded to at least this many bytes, and a responder ignores shorter ones: an answer (at most
/// [`MAX_PACKET`]) is then under three times the query, so a forged source address gains an attacker little.
pub const MIN_QUERY: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Packet {
    Query { nonce: String },
    Answer { nonce: String, advert: Advert },
}

/// What arrived.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decoded {
    Packet(Packet),
    /// Ours, but another protocol version.
    Incompatible {
        protocol: u64,
        deployment_id: Option<String>,
        app_version: Option<String>,
    },
    /// Ours (it carries the mark) but broken or with a field that fails validation.
    Malformed(String),
    /// Not ours.
    Foreign,
}

#[derive(Serialize, Deserialize)]
struct Wire<'a> {
    m: &'a str,
    v: u32,
    t: &'a str,
    nonce: &'a str,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    advert: Option<Advert>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pad: Option<String>,
}

impl Packet {
    pub fn encode(&self) -> Vec<u8> {
        let wire = match self {
            Packet::Query { nonce } => Wire {
                m: MARK,
                v: PROTOCOL,
                t: "q",
                nonce,
                advert: None,
                pad: Some("0".repeat(MIN_QUERY)),
            },
            Packet::Answer { nonce, advert } => Wire {
                m: MARK,
                v: PROTOCOL,
                t: "a",
                nonce,
                advert: Some(advert.clone()),
                pad: None,
            },
        };
        serde_json::to_vec(&wire).unwrap_or_default()
    }
}

/// Reads one datagram (see the module text).
pub fn decode(bytes: &[u8]) -> Decoded {
    if bytes.len() > MAX_PACKET {
        return Decoded::Foreign;
    }
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return Decoded::Foreign;
    };
    if value.get("m").and_then(Value::as_str) != Some(MARK) {
        return Decoded::Foreign;
    }
    let protocol = value.get("v").and_then(Value::as_u64).unwrap_or(0);
    if protocol != u64::from(PROTOCOL) {
        let field = |name: &str| {
            value
                .pointer(&format!("/advert/{name}"))
                .and_then(Value::as_str)
                .filter(|text| text.len() <= 64 && !text.chars().any(char::is_control))
                .map(str::to_string)
        };
        return Decoded::Incompatible {
            protocol,
            deployment_id: field("deploymentId").filter(|id| is_hex(id, 32)),
            app_version: field("appVersion").filter(|v| crate::version::is_valid(v)),
        };
    }
    match read_current(value) {
        Ok(packet) => Decoded::Packet(packet),
        Err(reason) => Decoded::Malformed(reason),
    }
}

fn read_current(value: Value) -> Result<Packet, String> {
    let kind = value.get("t").and_then(Value::as_str).unwrap_or_default();
    let nonce = value
        .get("nonce")
        .and_then(Value::as_str)
        .filter(|nonce| is_hex(nonce, 16))
        .ok_or("nonce")?
        .to_string();
    match kind {
        "q" => Ok(Packet::Query { nonce }),
        "a" => {
            let advert: Advert = value
                .get("advert")
                .cloned()
                .ok_or("advert")
                .and_then(|advert| serde_json::from_value(advert).map_err(|_| "advert"))?;
            advert.validate()?;
            Ok(Packet::Answer { nonce, advert })
        }
        _ => Err("packet type".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::advert::tests::share_advert;

    #[test]
    fn queries_and_answers_round_trip_and_fit_one_datagram() {
        let query = Packet::Query {
            nonce: "00112233445566ff".into(),
        };
        assert_eq!(decode(&query.encode()), Decoded::Packet(query));
        let mut advert = share_advert();
        advert.share_path = Some(format!(r"\\server\{}", "a".repeat(380)));
        advert.deployment_id =
            crate::share_id_for(advert.share_path.as_deref().unwrap_or_default());
        let answer = Packet::Answer {
            nonce: "00112233445566ff".into(),
            advert,
        };
        let bytes = answer.encode();
        assert!(bytes.len() <= MAX_PACKET, "{}", bytes.len());
        assert_eq!(decode(&bytes), Decoded::Packet(answer));
    }

    #[test]
    fn foreign_broken_and_other_version_packets_are_told_apart() {
        assert_eq!(decode(b"hello"), Decoded::Foreign);
        assert_eq!(
            decode(br#"{"m":"openmind-collab","v":1}"#),
            Decoded::Foreign
        );
        assert_eq!(decode(&vec![b' '; MAX_PACKET + 1]), Decoded::Foreign);
        assert!(matches!(
            decode(br#"{"m":"openmind-deploy","v":1,"t":"q","nonce":"xyz"}"#),
            Decoded::Malformed(_)
        ));
        assert!(matches!(
            decode(br#"{"m":"openmind-deploy","v":1,"t":"z","nonce":"00112233445566ff"}"#),
            Decoded::Malformed(_)
        ));
        let mut advert = serde_json::to_value(share_advert()).expect("json");
        advert["instance"] = "not-hex".into();
        let bad = serde_json::json!({"m": MARK, "v": 1, "t": "a", "nonce": "00112233445566ff", "advert": advert});
        assert!(matches!(
            decode(&serde_json::to_vec(&bad).expect("bytes")),
            Decoded::Malformed(_)
        ));
        let id = share_advert().deployment_id;
        let newer = serde_json::json!({"m": MARK, "v": 7, "t": "a", "nonce": "x",
            "advert": {"deploymentId": id, "appVersion": "2.0.0", "somethingNew": true}});
        assert_eq!(
            decode(&serde_json::to_vec(&newer).expect("bytes")),
            Decoded::Incompatible {
                protocol: 7,
                deployment_id: Some(id),
                app_version: Some("2.0.0".into())
            }
        );
    }
}
