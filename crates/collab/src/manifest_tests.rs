//! Manifest entries, pagination and the participant's tree.

use super::*;
use crate::share::sync_table;

fn p(text: &str) -> RelPath {
    RelPath::parse(text).expect("path")
}

fn manifest(files: &[&str]) -> (FileTable, BTreeMap<FileId, ManifestEntry>) {
    let mut table = FileTable::default();
    let paths: Vec<RelPath> = files.iter().map(|f| p(f)).collect();
    sync_table(&mut table, &paths, &[]);
    let stats: HashMap<String, FileStat> = paths
        .iter()
        .map(|f| {
            (
                f.key(),
                FileStat {
                    size: 10,
                    modified_ms: 5,
                },
            )
        })
        .collect();
    let entries = entries_of(&table, &stats);
    (table, entries)
}

#[test]
fn entries_name_their_parent_and_carry_no_absolute_path() {
    let (table, entries) = manifest(&["src/app/main.ts", "logo.png"]);
    let main = &entries[table.id_of(&p("src/app/main.ts")).expect("main")];
    let app = table.id_of(&p("src/app")).cloned();
    assert_eq!(
        (main.name.as_str(), main.parent.clone(), main.size),
        ("main.ts", app, 10)
    );
    assert!(!main.binary_hint);
    assert!(entries[table.id_of(&p("logo.png")).expect("logo")].binary_hint);
    assert!(entries[table.id_of(&p("src")).expect("src")]
        .parent
        .is_none());
    let json = serde_json::to_string(&entries.values().collect::<Vec<_>>()).expect("json");
    assert!(!json.contains(":\\") && !json.contains("C:/"));
}

#[test]
fn a_huge_tree_is_split_into_pages_that_each_fit_one_message() {
    let files: Vec<String> = (0..6000)
        .map(|i| format!("pkg{}/module_{i}/source_file_number_{i}.ts", i % 40))
        .collect();
    let refs: Vec<&str> = files.iter().map(String::as_str).collect();
    let (_, entries) = manifest(&refs);
    let pages = paginate(&entries);
    assert!(pages.len() > 1, "more than one page");
    for page in &pages {
        assert!(serde_json::to_vec(page).expect("json").len() <= PAGE_BYTES + 4096);
        assert!(page.len() <= MAX_PAGE_ENTRIES);
    }
    assert_eq!(pages.iter().map(Vec::len).sum::<usize>(), entries.len());
    let mut tree = RemoteTree::default();
    let total = pages.len() as u32;
    // Pages may arrive in any order; the tree switches only when all are there.
    for (i, page) in pages.into_iter().enumerate().rev() {
        let complete = tree
            .apply_page(1, i as u32, total, "My Project", page)
            .expect("page");
        assert_eq!(complete, i == 0);
    }
    assert_eq!(tree.entries().len(), entries.len());
    assert_eq!(tree.root(), "My Project");
}

#[test]
fn an_empty_workspace_is_still_one_page() {
    let pages = paginate(&BTreeMap::new());
    assert_eq!(pages.len(), 1);
    let mut tree = RemoteTree::default();
    assert!(tree
        .apply_page(1, 0, 1, "Empty", pages.into_iter().next().expect("page"))
        .expect("page"));
    assert!(tree.is_ready());
}

#[test]
fn deltas_apply_in_order_and_anything_else_asks_for_a_resync() {
    let (mut table, old) = manifest(&["a.ts", "b.ts"]);
    let mut tree = RemoteTree::default();
    tree.apply_page(3, 0, 1, "W", old.values().cloned().collect())
        .expect("page");
    sync_table(&mut table, &[p("b.ts"), p("c.ts")], &[]);
    let new = entries_of(&table, &HashMap::new());
    let (upserts, removed) = diff(&old, &new);
    assert_eq!(
        (upserts.len(), removed.len()),
        (1 + 1, 1),
        "c added, b's stats changed, a removed"
    );
    assert_eq!(
        tree.apply_delta(5, 6, upserts.clone(), removed.clone())
            .expect("delta"),
        DeltaResult::Resync
    );
    assert!(!tree.is_ready());
    tree.apply_page(3, 0, 1, "W", old.values().cloned().collect())
        .expect("page");
    assert_eq!(
        tree.apply_delta(3, 4, upserts, removed).expect("delta"),
        DeltaResult::Applied
    );
    let names: Vec<&str> = tree.entries().values().map(|e| e.name.as_str()).collect();
    assert_eq!(names.len(), 2);
    assert!(names.contains(&"c.ts") && !names.contains(&"a.ts"));
}

#[test]
fn malformed_pages_are_refused() {
    let mut tree = RemoteTree::default();
    assert!(
        tree.apply_page(1, 2, 2, "W", Vec::new()).is_err(),
        "page out of range"
    );
    assert!(tree.apply_page(1, 0, 0, "W", Vec::new()).is_err());
    assert!(tree
        .apply_page(1, 0, MAX_PAGES + 1, "W", Vec::new())
        .is_err());
    tree.apply_page(1, 0, 2, "W", Vec::new()).expect("first");
    assert!(
        tree.apply_page(1, 0, 2, "W", Vec::new()).is_err(),
        "duplicate page"
    );
    let (_, entries) = manifest(&["x.ts"]);
    let mut lying = entries.values().next().cloned().expect("entry");
    lying.name = "other.ts".into();
    assert!(
        RemoteTree::default()
            .apply_page(1, 0, 1, "W", vec![lying])
            .is_err(),
        "name must match path"
    );
}

#[test]
fn big_deltas_are_sent_as_resets() {
    let (_, entries) = manifest(&["a.ts"]);
    assert!(delta_fits(
        &entries.values().cloned().collect::<Vec<_>>(),
        &[]
    ));
    let many: Vec<FileId> = (0..MAX_PAGE_ENTRIES + 1)
        .map(|_| FileId::random().expect("id"))
        .collect();
    assert!(!delta_fits(&[], &many));
}
