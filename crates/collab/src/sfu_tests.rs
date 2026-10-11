use super::*;

fn api() -> ApiKey {
    ApiKey {
        key: "APIclass".into(),
        secret: "a-long-random-secret-for-tests-only".into(),
    }
}

fn peer(n: u8) -> PeerId {
    PeerId::parse(&format!("{:064x}", n)).expect("peer")
}

const NOW: i64 = 1_800_000_000;

#[test]
fn media_names_are_opaque_stable_and_per_room() {
    let room = media_room("room-a");
    assert_eq!(room, media_room("room-a"));
    assert_ne!(room, media_room("room-b"));
    assert!(room.starts_with("om-") && room.len() == 27 && !room.contains("room-a"));
    let p = peer(1);
    let id = media_identity("room-a", &p);
    assert_eq!(id, media_identity("room-a", &p));
    assert_ne!(
        id,
        media_identity("room-b", &p),
        "not linkable across rooms"
    );
    assert_ne!(id, media_identity("room-a", &peer(2)));
    assert!(!id.contains(p.as_str()) && id.len() == 26);
}

#[test]
fn a_member_token_grants_only_this_room_this_identity_and_the_microphone_if_allowed() {
    let token = member_token(&api(), "room-a", &peer(1), true, NOW).expect("token");
    let claims = verify(&token, &api().secret, NOW).expect("valid");
    assert_eq!(claims.iss, "APIclass");
    assert_eq!(claims.sub, media_identity("room-a", &peer(1)));
    assert_eq!(claims.video.room, media_room("room-a"));
    assert!(claims.video.room_join && !claims.video.room_admin);
    assert_eq!(claims.video.can_publish, Some(true));
    assert_eq!(
        claims.video.can_publish_sources,
        vec!["microphone".to_string()]
    );
    assert_eq!(claims.video.can_publish_data, Some(false));
    assert_eq!(claims.exp - NOW, TOKEN_TTL_SECS);

    let listener = member_token(&api(), "room-a", &peer(2), false, NOW).expect("token");
    let claims = verify(&listener, &api().secret, NOW).expect("valid");
    assert_eq!(claims.video.can_publish, Some(false));
    assert!(
        claims.video.can_publish_sources.is_empty(),
        "a listener may publish nothing"
    );
    // The JSON a media server reads uses LiveKit's names.
    let payload = token.split('.').nth(1).expect("payload");
    let json = String::from_utf8(URL_SAFE_NO_PAD.decode(payload).expect("b64")).expect("utf8");
    assert!(
        json.contains("\"roomJoin\":true")
            && json.contains("\"canPublishSources\":[\"microphone\"]")
    );
    assert!(!json.contains("secret") && !json.contains("room-a"));
}

#[test]
fn expired_forged_and_wrong_key_tokens_are_refused() {
    let token = member_token(&api(), "room-a", &peer(1), true, NOW).expect("token");
    assert!(
        verify(&token, &api().secret, NOW + TOKEN_TTL_SECS).is_err(),
        "expired"
    );
    assert!(
        verify(&token, &api().secret, NOW - 60).is_err(),
        "not yet valid"
    );
    assert!(
        verify(&token, "another-secret", NOW).is_err(),
        "wrong secret"
    );
    // Changing the claims (another room, another identity, publishing) breaks the signature.
    let mut parts: Vec<String> = token.split('.').map(String::from).collect();
    let mut claims: Claims =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(&parts[1]).expect("b64")).expect("json");
    claims.video.room = media_room("room-b");
    parts[1] = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).expect("json"));
    assert!(verify(&parts.join("."), &api().secret, NOW).is_err());
    assert!(verify("a.b", &api().secret, NOW).is_err());
}

#[test]
fn the_admin_token_manages_one_room_and_joins_nothing() {
    let token = admin_token(&api(), "room-a", NOW).expect("token");
    let claims = verify(&token, &api().secret, NOW).expect("valid");
    assert!(claims.video.room_admin && !claims.video.room_join);
    assert_eq!(claims.video.room, media_room("room-a"));
    assert!(claims.exp - NOW <= 60);
}

#[test]
fn secrets_never_print_and_grants_are_validated() {
    assert_eq!(format!("{:?}", SecretText("eyJtoken".into())), "****");
    assert!(!format!("{:?}", api()).contains("a-long-random"));
    let ok = VoiceMediaGrant::Sfu {
        url: "wss://media.example.edu".into(),
        token: SecretText("abc.def.ghi".into()),
        expires_ms: 1,
    };
    assert!(ok.validate().is_ok());
    assert!(!format!("{ok:?}").contains("abc.def"));
    let bad_url = VoiceMediaGrant::Sfu {
        url: "javascript:alert(1)".into(),
        token: SecretText("t".into()),
        expires_ms: 1,
    };
    assert!(bad_url.validate().is_err());
    let empty = VoiceMediaGrant::Sfu {
        url: "ws://192.168.0.10:7880".into(),
        token: SecretText(String::new()),
        expires_ms: 1,
    };
    assert!(empty.validate().is_err());
    assert!(VoiceMediaGrant::P2p.validate().is_ok());
    assert_eq!(
        serde_json::to_string(&VoiceMediaGrant::P2p).expect("json"),
        r#"{"kind":"p2p"}"#
    );
}
