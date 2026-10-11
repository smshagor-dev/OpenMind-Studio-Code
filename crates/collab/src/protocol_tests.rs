//! Frame encoding and the checks a received frame must pass.

use super::*;

fn session() -> SessionId {
    SessionId::random().expect("session")
}

fn file() -> FileId {
    FileId::random().expect("file")
}

#[test]
fn frames_round_trip_on_their_channel() {
    let frame = Frame::new(
        session(),
        1,
        Body::YjsUpdate {
            file: file(),
            id: MessageId::random().expect("id"),
            update: Bytes(vec![1, 2, 3]),
        },
    )
    .expect("frame");
    assert_eq!(frame.channel, Channel::Sync);
    let bytes = frame.encode().expect("encode");
    assert_eq!(Frame::decode(&bytes).expect("decode"), frame);
    let command = Frame::new(
        session(),
        2,
        Body::Command {
            command: Command::RotateInvite,
        },
    )
    .expect("frame");
    assert_eq!(command.channel, Channel::Control);
    assert_eq!(
        Frame::decode(&command.encode().expect("encode")).expect("decode"),
        command
    );
}

fn tamper(frame: &Frame, change: impl FnOnce(&mut serde_json::Value)) -> Vec<u8> {
    let mut value = serde_json::to_value(frame).expect("value");
    change(&mut value);
    serde_json::to_vec(&value).expect("bytes")
}

#[test]
fn a_role_or_permission_claim_in_a_frame_is_refused_not_trusted() {
    let frame = Frame::new(session(), 1, Body::Leave).expect("frame");
    let claimed = tamper(&frame, |v| {
        v["role"] = serde_json::json!("owner");
    });
    assert!(
        Frame::decode(&claimed).is_err(),
        "unknown top-level fields are refused"
    );
}

#[test]
fn malformed_frames_are_refused() {
    let transfer = TransferId::random().expect("transfer");
    let frame = Frame::new(
        session(),
        1,
        Body::FileRequest {
            file: file(),
            transfer,
        },
    )
    .expect("frame");
    let wrong_version = tamper(&frame, |v| v["v"] = serde_json::json!(2));
    assert!(Frame::decode(&wrong_version).is_err());
    let wrong_channel = tamper(&frame, |v| v["channel"] = serde_json::json!("control"));
    assert!(Frame::decode(&wrong_channel).is_err());
    let bad_id = tamper(&frame, |v| {
        v["body"]["data"]["file"] = serde_json::json!("../../etc")
    });
    assert!(Frame::decode(&bad_id).is_err());
    assert!(Frame::decode(b"not json").is_err());
    assert!(
        Frame::decode(&vec![b' '; MAX_FRAME_BYTES + 1]).is_err(),
        "size is checked before parsing"
    );
}

#[test]
fn traversal_in_file_names_is_refused_at_decode() {
    let frame = Frame::new(
        session(),
        1,
        Body::FileCreate {
            path: RelPath::parse("src/new.ts").expect("path"),
            kind: FileKind::File,
        },
    )
    .expect("frame");
    for bad in [
        "../outside.ts",
        "/abs.ts",
        "C:/x.ts",
        "a\\b.ts",
        "src/../../x",
    ] {
        let hostile = tamper(&frame, |v| {
            v["body"]["data"]["path"] = serde_json::json!(bad)
        });
        assert!(Frame::decode(&hostile).is_err(), "{bad}");
    }
}

#[test]
fn oversized_payloads_are_refused() {
    let big = Frame::new(
        session(),
        1,
        Body::Awareness {
            state: Bytes(vec![0; MAX_AWARENESS_BYTES + 1]),
        },
    )
    .expect("frame");
    assert!(Frame::decode(&serde_json::to_vec(&big).expect("bytes")).is_err());
    let reason = Frame::new(
        session(),
        1,
        Body::Reject {
            of: MessageId::random().expect("id"),
            reason: "x".repeat(201),
        },
    )
    .expect("frame");
    assert!(Frame::decode(&serde_json::to_vec(&reason).expect("bytes")).is_err());
    let rename = Frame::new(
        session(),
        1,
        Body::Command {
            command: Command::RenameRoom {
                name: "\u{202e}x".into(),
            },
        },
    )
    .expect("frame");
    assert!(Frame::decode(&serde_json::to_vec(&rename).expect("bytes")).is_err());
}

#[test]
fn handshakes_round_trip_and_verify() {
    let identity = PeerIdentity::generate().expect("identity");
    let code = crate::code::RoomCode::generate().expect("code");
    let room = RoomUid::random().expect("room");
    let challenge = Challenge::random().expect("challenge");
    let join = JoinRequest::create(&identity, &code, &room, &challenge, "Ada");
    assert!(join.verify_signature().is_ok());
    let message = Handshake::Join(join.clone());
    assert_eq!(
        Handshake::decode(&message.encode().expect("encode")).expect("decode"),
        message
    );
    let encoded = String::from_utf8(message.encode().expect("encode")).expect("utf8");
    assert!(
        !encoded.contains(&code.display().replace('-', "")[2..]),
        "the code never travels"
    );
    let reconnect = ReconnectRequest::create(&identity, &room, &challenge);
    assert!(reconnect.verify_signature().is_ok());
    let mut forged = reconnect;
    forged.room = RoomUid::random().expect("room");
    assert!(forged.verify_signature().is_err());
}

#[test]
fn a_full_manifest_page_round_trips() {
    use crate::files::{FileKind, FileTable, RelPath};
    let mut table = FileTable::default();
    let paths: Vec<RelPath> = (0..3000)
        .map(|i| RelPath::parse(&format!("pkg{}/m{i}/file_number_{i}.ts", i % 30)).expect("p"))
        .collect();
    crate::share::sync_table(&mut table, &paths, &[]);
    let entries = crate::manifest::entries_of(&table, &Default::default());
    let pages = crate::manifest::paginate(&entries);
    let total = pages.len() as u32;
    for (i, page) in pages.into_iter().enumerate() {
        let body = Body::ManifestPage {
            version: 1,
            page: i as u32,
            pages: total,
            root: "W".into(),
            entries: page,
        };
        let frame = Frame::new(session(), 1, body).expect("frame");
        let bytes = frame.encode().expect("encode");
        assert!(bytes.len() < 120 * 1024, "{}", bytes.len());
        assert_eq!(Frame::decode(&bytes).expect("decode"), frame);
    }
    let _ = FileKind::File;
}

fn replace_key(value: &mut serde_json::Value, key: &str, with: &serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map.iter_mut() {
                if k == key {
                    *v = with.clone();
                } else {
                    replace_key(v, key, with);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for v in items {
                replace_key(v, key, with);
            }
        }
        _ => {}
    }
}

#[test]
fn a_classroom_media_grant_round_trips_and_a_bad_one_is_refused() {
    let grant = crate::sfu::VoiceMediaGrant::Sfu {
        url: "wss://media.example.edu".into(),
        token: crate::sfu::SecretText("header.payload.signature".into()),
        expires_ms: 1,
    };
    let frame = Frame::new(
        session(),
        3,
        Body::VoiceMedia {
            of: MessageId::random().expect("id"),
            media: grant,
        },
    )
    .expect("frame");
    assert_eq!(frame.channel, Channel::Control);
    assert_eq!(
        Frame::decode(&frame.encode().expect("encode")).expect("decode"),
        frame
    );
    for (key, bad) in [
        ("url", serde_json::json!("http://media.example.edu")),
        ("url", serde_json::json!("file:///c:/x")),
        ("url", serde_json::json!("x".repeat(600))),
        ("token", serde_json::json!("")),
        ("token", serde_json::json!("t".repeat(5000))),
    ] {
        let bytes = tamper(&frame, |v| replace_key(v, key, &bad));
        assert!(
            Frame::decode(&bytes).is_err(),
            "{key} = {bad} must be refused"
        );
    }
    let request = Frame::new(session(), 4, Body::VoiceMediaRequest).expect("frame");
    assert_eq!(request.channel, Channel::Control);
}
