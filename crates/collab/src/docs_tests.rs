use super::*;

fn peer() -> PeerId {
    crate::PeerIdentity::generate().expect("identity").peer_id()
}

fn id() -> MessageId {
    MessageId::random().expect("id")
}

/// A participant's copy, synced the way the protocol does it (state vector -> DocSync).
fn join(host: &mut DocHost, who: &PeerId, file: &FileId) -> CollabDoc {
    let mine = CollabDoc::default();
    let Body::DocSync { update, .. } = host
        .subscribe(who, file, &mine.state_vector())
        .expect("subscribe")
    else {
        panic!("not a sync")
    };
    mine.apply(&update.0).expect("sync");
    mine
}

fn deliver(change: &Change, to: &PeerId, doc: &CollabDoc) {
    for (peer, body) in &change.send {
        if peer == to {
            if let Body::YjsUpdate { update, .. } = body {
                doc.apply(&update.0).expect("apply");
            }
        }
    }
}

fn host_with(text: &str) -> (DocHost, FileId) {
    let mut host = DocHost::default();
    let file = FileId::random().expect("file");
    host.load(file.clone(), CollabDoc::from_text(text), 0);
    (host, file)
}

#[test]
fn an_owner_and_two_editors_converge_through_the_host() {
    let (mut host, file) = host_with("let x = 1;\n");
    let (a, b) = (peer(), peer());
    let (doc_a, doc_b) = (join(&mut host, &a, &file), join(&mut host, &b, &file));
    // Concurrent edits at the same place by both editors, then one by the Owner.
    let up_a = doc_a.set_text("let xa = 1;\n").expect("a");
    let up_b = doc_b.set_text("let xb = 1;\n").expect("b");
    let change_a = host
        .update(Origin::Peer(a.clone()), &file, id(), up_a)
        .expect("a accepted");
    let change_b = host
        .update(Origin::Peer(b.clone()), &file, id(), up_b)
        .expect("b accepted");
    assert!(change_a.to_owner.is_some() && change_a.store.is_some());
    assert_eq!(change_a.send.len(), 1, "forwarded to the other editor only");
    deliver(&change_a, &b, &doc_b);
    deliver(&change_b, &a, &doc_a);
    let owner_text = format!("// owner\n{}", host.text(&file).expect("text"));
    let mine = CollabDoc::restore(Some(&host.full_state(&file).expect("state")), &[])
        .expect("owner editor copy");
    let owner_change = host
        .update(
            Origin::Owner,
            &file,
            id(),
            mine.set_text(&owner_text).expect("owner"),
        )
        .expect("owner");
    assert!(owner_change.to_owner.is_none());
    deliver(&owner_change, &a, &doc_a);
    deliver(&owner_change, &b, &doc_b);
    let canonical = host.text(&file).expect("text");
    assert_eq!(doc_a.text(), canonical);
    assert_eq!(doc_b.text(), canonical);
    assert!(
        canonical.starts_with("// owner\n") && canonical.contains('a') && canonical.contains('b')
    );
}

#[test]
fn a_resend_is_stored_and_forwarded_once() {
    let (mut host, file) = host_with("abc");
    let a = peer();
    let doc = join(&mut host, &a, &file);
    let update = doc.set_text("abcd").expect("edit");
    let first = host
        .update(Origin::Peer(a.clone()), &file, id(), update.clone())
        .expect("first");
    let again = host
        .update(Origin::Peer(a), &file, id(), update)
        .expect("again");
    assert!(first.store.is_some());
    assert_eq!(again, Change::default(), "nothing stored, nothing sent");
    assert_eq!(host.text(&file).as_deref(), Some("abcd"));
}

#[test]
fn changes_need_an_open_document_and_a_live_file() {
    let (mut host, file) = host_with("abc");
    let (a, stranger) = (peer(), peer());
    let doc = join(&mut host, &a, &file);
    let update = doc.set_text("abcX").expect("edit");
    assert_eq!(
        host.update(Origin::Peer(stranger), &file, id(), update.clone()),
        Err(DocError::NotOpen)
    );
    let other = FileId::random().expect("file");
    assert_eq!(
        host.update(Origin::Peer(a.clone()), &other, id(), update.clone()),
        Err(DocError::NotOpen)
    );
    assert!(host
        .update(Origin::Peer(a.clone()), &file, id(), b"garbage".to_vec())
        .is_err());
    assert_eq!(
        host.text(&file).as_deref(),
        Some("abc"),
        "nothing refused changed the document"
    );
    let closed = host.deleted(&file);
    assert_eq!(closed.len(), 1);
    assert!(matches!(
        closed[0].1,
        Body::DocClosed {
            reason: DocClosedReason::Deleted,
            ..
        }
    ));
    assert_eq!(
        host.update(Origin::Peer(a.clone()), &file, id(), update),
        Err(DocError::Deleted),
        "a late change"
    );
    assert_eq!(host.subscribe(&a, &file, &[0]), Err(DocError::Deleted));
}

#[test]
fn snapshots_come_due_and_idle_documents_unload_with_one() {
    let (mut host, file) = host_with("");
    let a = peer();
    let _ = join(&mut host, &a, &file);
    for row in 1..SNAPSHOT_EVERY as i64 {
        assert!(host.stored(&file, row).is_none());
    }
    let (state, _, covers) = host.stored(&file, SNAPSHOT_EVERY as i64).expect("due");
    assert_eq!(covers, SNAPSHOT_EVERY as i64);
    assert!(!state.is_empty());
    assert!(host.unload_idle().is_empty(), "still followed");
    host.stored(&file, 1000);
    host.peer_left(&a);
    let unloaded = host.unload_idle();
    assert_eq!(
        unloaded.len(),
        1,
        "a final snapshot for the changes since the last one"
    );
    assert_eq!(unloaded[0].3, 1000);
    assert_eq!(host.loaded(), 0);
}

#[test]
fn the_owner_editor_keeps_a_document_loaded() {
    let (mut host, file) = host_with("x");
    host.set_owner_bound(&file, true);
    assert!(host.unload_idle().is_empty());
    host.set_owner_bound(&file, false);
    assert!(
        host.unload_idle().is_empty(),
        "no unsaved changes: unloaded without a snapshot"
    );
    assert_eq!(host.loaded(), 0);
}
