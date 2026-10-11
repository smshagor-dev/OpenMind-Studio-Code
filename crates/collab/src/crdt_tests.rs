use super::*;

/// A peer document following `owner` (as a participant does after its first sync).
fn follower(owner: &CollabDoc) -> CollabDoc {
    CollabDoc::restore(Some(&owner.full_state()), &[]).expect("sync")
}

/// An edit made on `doc` as one transaction, returned as the update to share.
fn edit(doc: &CollabDoc, at: u32, remove: u32, insert: &str) -> Vec<u8> {
    let before = doc.doc.transact().state_vector();
    {
        let mut txn = doc.doc.transact_mut();
        if remove > 0 {
            doc.text.remove_range(&mut txn, at, remove);
        }
        if !insert.is_empty() {
            doc.text.insert(&mut txn, at, insert);
        }
    }
    doc.doc.transact().encode_diff_v1(&before)
}

#[test]
fn three_editors_converge_whatever_the_order() {
    let owner = CollabDoc::from_text("fn main() {}\n");
    let (a, b) = (follower(&owner), follower(&owner));
    // Same position, insert/insert, insert/delete, all concurrent.
    let from_owner = edit(&owner, 0, 0, "// owner\n");
    let from_a = edit(&a, 0, 0, "// a\n");
    let from_b = edit(&b, 3, 4, "MAIN");
    for (doc, updates) in [
        (&owner, [&from_a, &from_b]),
        (&a, [&from_b, &from_owner]),
        (&b, [&from_owner, &from_a]),
    ] {
        for update in updates {
            assert!(doc.apply(update).expect("apply"));
        }
    }
    assert_eq!(owner.text(), a.text());
    assert_eq!(a.text(), b.text());
    assert!(
        owner.text().contains("// owner")
            && owner.text().contains("// a")
            && owner.text().contains("MAIN")
    );
}

#[test]
fn a_resend_changes_nothing_and_says_so() {
    let owner = CollabDoc::from_text("abc");
    let peer = follower(&owner);
    let update = edit(&peer, 3, 0, "d");
    assert!(owner.apply(&update).expect("first"));
    assert!(!owner.apply(&update).expect("again"), "already integrated");
    assert_eq!(owner.text(), "abcd", "no duplicated text");
}

#[test]
fn malformed_oversized_and_out_of_order_updates_are_refused_untouched() {
    let owner = CollabDoc::from_text("abc");
    for garbage in [vec![], vec![0xFF; 7], b"not a yjs update".to_vec()] {
        assert!(owner.apply(&garbage).is_err(), "{garbage:?}");
    }
    assert_eq!(
        owner.apply(&vec![0; MAX_UPDATE_BYTES + 1]),
        Err(CrdtError::TooLarge)
    );
    // An update that builds on another the Owner never got.
    let peer = follower(&owner);
    let _first = edit(&peer, 0, 0, "x");
    let second = edit(&peer, 0, 0, "y");
    assert_eq!(owner.apply(&second), Err(CrdtError::Missing));
    assert_eq!(owner.text(), "abc");
    assert_eq!(owner.diff(b"\xFF\xFF\xFF"), Err(CrdtError::BadStateVector));
}

#[test]
fn state_vectors_send_only_what_is_missing() {
    let owner = CollabDoc::from_text(&"line\n".repeat(2000));
    let peer = follower(&owner);
    edit(&owner, 0, 0, "new ");
    let missing = owner.diff(&peer.state_vector()).expect("diff");
    assert!(
        missing.len() < owner.full_state().len() / 10,
        "{} vs {}",
        missing.len(),
        owner.full_state().len()
    );
    peer.apply(&missing).expect("apply");
    assert_eq!(peer.text(), owner.text());
    assert!(!peer
        .apply(&owner.diff(&peer.state_vector()).expect("diff"))
        .expect("nothing left"));
}

#[test]
fn whole_text_changes_become_one_minimal_edit_without_splitting_characters() {
    let owner = CollabDoc::from_text("let smile = \"😀\";\nok");
    let peer = follower(&owner);
    let update = owner.set_text("let smile = \"😃\";\nok").expect("changed");
    peer.apply(&update).expect("apply");
    assert_eq!(peer.text(), "let smile = \"😃\";\nok");
    assert!(owner.set_text(&owner.text()).is_none(), "nothing to do");
    let update = owner.set_text("").expect("cleared");
    peer.apply(&update).expect("apply");
    assert_eq!(peer.text(), "");
}

#[test]
fn a_document_is_rebuilt_from_its_snapshot_and_later_updates() {
    let owner = CollabDoc::from_text("start");
    let snapshot = owner.full_state();
    let later = vec![edit(&owner, 5, 0, " middle"), edit(&owner, 0, 5, "begin")];
    let restored = CollabDoc::restore(Some(&snapshot), &later).expect("restore");
    assert_eq!(restored.text(), owner.text());
    assert_eq!(restored.text(), "begin middle");
}

#[test]
fn the_document_size_is_bounded() {
    let owner = CollabDoc::from_text(&"x".repeat(MAX_TEXT_UNITS - 10));
    let peer = follower(&owner);
    let update = edit(&peer, 0, 0, &"y".repeat(100));
    assert_eq!(owner.apply(&update), Err(CrdtError::TextTooLarge));
    assert_eq!(owner.text_units(), MAX_TEXT_UNITS - 10, "unchanged");
}
