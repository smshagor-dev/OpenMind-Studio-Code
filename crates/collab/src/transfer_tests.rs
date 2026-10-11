//! Chunking and reassembly.

use super::*;

fn meta_of(snapshot: &Snapshot) -> FileMeta {
    FileMeta {
        transfer: TransferId::random().expect("id"),
        file: FileId::random().expect("id"),
        size: snapshot.bytes.len() as u64,
        sha256: snapshot.sha256.clone(),
        chunk_size: CHUNK_BYTES as u32,
        chunks: snapshot.chunks(),
        text: snapshot.text,
    }
}

fn round_trip(len: usize) -> Vec<u8> {
    let bytes: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
    let snapshot = Snapshot::new(bytes.clone(), false);
    let mut incoming = Incoming::new(meta_of(&snapshot)).expect("incoming");
    for i in 0..snapshot.chunks() {
        incoming
            .add(i, snapshot.chunk(i).expect("chunk"))
            .expect("add");
    }
    let out = incoming.finish().expect("finish");
    assert_eq!(out, bytes);
    out
}

#[test]
fn files_of_every_shape_round_trip() {
    for len in [
        0,
        1,
        CHUNK_BYTES - 1,
        CHUNK_BYTES,
        CHUNK_BYTES + 1,
        3 * CHUNK_BYTES,
        3 * CHUNK_BYTES + 17,
    ] {
        round_trip(len);
    }
    assert_eq!(chunk_count(0), 0);
    assert_eq!(
        chunk_count(CHUNK_BYTES as u64),
        1,
        "an exact boundary is one chunk"
    );
    assert_eq!(chunk_count(CHUNK_BYTES as u64 + 1), 2);
}

#[test]
fn chunks_out_of_order_are_fine_but_bad_ones_are_refused() {
    let snapshot = Snapshot::new(vec![7; 2 * CHUNK_BYTES + 5], true);
    let mut incoming = Incoming::new(meta_of(&snapshot)).expect("incoming");
    incoming
        .add(2, snapshot.chunk(2).expect("c2"))
        .expect("last first");
    assert_eq!(
        incoming.add(2, snapshot.chunk(2).expect("c2")),
        Err(TransferError::Duplicate)
    );
    assert_eq!(incoming.add(3, &[0]), Err(TransferError::BadIndex));
    assert_eq!(incoming.add(0, &[0; 10]), Err(TransferError::BadLength));
    incoming
        .add(0, snapshot.chunk(0).expect("c0"))
        .expect("first");
    assert_eq!(incoming.received(), 2);
}

#[test]
fn a_missing_chunk_or_a_corrupted_one_is_never_handed_out() {
    let snapshot = Snapshot::new(vec![1; CHUNK_BYTES + 10], true);
    let mut missing = Incoming::new(meta_of(&snapshot)).expect("incoming");
    missing.add(0, snapshot.chunk(0).expect("c0")).expect("add");
    assert_eq!(missing.finish(), Err(TransferError::Incomplete));
    let mut corrupted = Incoming::new(meta_of(&snapshot)).expect("incoming");
    let mut bad = snapshot.chunk(0).expect("c0").to_vec();
    bad[5] ^= 0xff;
    corrupted.add(0, &bad).expect("add");
    corrupted
        .add(1, snapshot.chunk(1).expect("c1"))
        .expect("add");
    assert_eq!(corrupted.finish(), Err(TransferError::HashMismatch));
}

#[test]
fn invalid_or_oversized_metadata_is_refused_before_allocating() {
    let snapshot = Snapshot::new(vec![1; 10], true);
    let good = meta_of(&snapshot);
    for meta in [
        FileMeta {
            size: MAX_FILE_BYTES + 1,
            chunks: chunk_count(MAX_FILE_BYTES + 1),
            ..good.clone()
        },
        FileMeta {
            chunk_size: 1024,
            ..good.clone()
        },
        FileMeta {
            chunks: 5,
            ..good.clone()
        },
        FileMeta {
            sha256: "nope".into(),
            ..good.clone()
        },
    ] {
        assert_eq!(
            Incoming::new(meta).map(|_| ()),
            Err(TransferError::InvalidMeta)
        );
    }
    assert!(Snapshot::new(vec![0; 5], false).chunk(1).is_none());
}
