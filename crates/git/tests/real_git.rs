//! Runs the client against a real `git` (the machine's, if it has one — the
//! tests skip themselves otherwise) in temporary folders with spaces in their
//! names.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use openmind_git::{
    find_system, resolve, ChangeKind, GitClient, GitError, GitRegistry, LogEntry, RepoStatus,
};

struct Harness {
    client: GitClient,
    log: Arc<Mutex<Vec<LogEntry>>>,
    _temp: tempfile::TempDir,
    root: PathBuf,
}

fn harness() -> Option<Harness> {
    let system_path = std::env::var_os("PATH");
    find_system(system_path.clone())?;
    let exe = resolve(&[], true, system_path).ok()?;
    let log = Arc::new(Mutex::new(Vec::new()));
    let sink_log = log.clone();
    let client = GitClient::new(
        exe,
        Arc::new(move |entry| sink_log.lock().unwrap().push(entry)),
        GitRegistry::default(),
    );
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("my project");
    std::fs::create_dir_all(&root).unwrap();
    Some(Harness {
        client,
        log,
        _temp: temp,
        root,
    })
}

fn write(root: &Path, name: &str, text: &str) {
    let path = root.join(name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, text).unwrap();
}

/// File text with Windows line endings (`core.autocrlf`) normalized.
fn read(root: &Path, name: &str) -> String {
    let text = std::fs::read_to_string(root.join(name)).unwrap();
    text.replace("\r\n", "\n")
}

fn kinds(status: &RepoStatus, path: &str) -> (ChangeKind, ChangeKind) {
    let change = status
        .changes
        .iter()
        .find(|change| change.path == path)
        .unwrap_or_else(|| panic!("{path} not in status: {:?}", status.changes));
    (change.index, change.worktree)
}

fn ready(h: &Harness) {
    h.client.init(&h.root).unwrap();
    h.client
        .set_identity(&h.root, "Test User", "test@example.com")
        .unwrap();
}

fn commit_file(h: &Harness, name: &str, text: &str) {
    write(&h.root, name, text);
    h.client.stage(&h.root, &[name.to_string()]).unwrap();
    h.client.commit(&h.root, "add file").unwrap();
}

#[test]
fn a_folder_that_is_not_a_repository_is_reported_and_init_fixes_it() {
    let Some(h) = harness() else { return };
    // A temp folder is outside any repository.
    assert_eq!(h.client.find_root(&h.root), Err(GitError::NotARepository));
    h.client.init(&h.root).unwrap();
    let root = h.client.find_root(&h.root).unwrap();
    assert!(root.join(".git").exists());
}

#[test]
fn untracked_staged_committed_modified_flow_with_spaces_in_names() {
    let Some(h) = harness() else { return };
    ready(&h);
    write(&h.root, "src/my file.txt", "one\n");

    let status = h.client.status(&h.root).unwrap();
    assert_eq!(
        kinds(&status, "src/my file.txt"),
        (ChangeKind::Unmodified, ChangeKind::Untracked)
    );
    assert!(!status.has_head());

    // Stage, then unstage before the first commit (no HEAD to restore from).
    h.client
        .stage(&h.root, &["src/my file.txt".into()])
        .unwrap();
    assert_eq!(
        kinds(&h.client.status(&h.root).unwrap(), "src/my file.txt").0,
        ChangeKind::Added
    );
    h.client
        .unstage(&h.root, &["src/my file.txt".into()])
        .unwrap();
    assert_eq!(
        kinds(&h.client.status(&h.root).unwrap(), "src/my file.txt").1,
        ChangeKind::Untracked
    );

    h.client
        .stage(&h.root, &["src/my file.txt".into()])
        .unwrap();
    let summary = h.client.commit(&h.root, "  first commit \n").unwrap();
    assert!(summary.contains("first commit"), "{summary}");
    let clean = h.client.status(&h.root).unwrap();
    assert!(clean.changes.is_empty());
    assert!(clean.has_head());
    assert!(clean.branch.is_some());

    write(&h.root, "src/my file.txt", "one\ntwo\n");
    let changed = h.client.status(&h.root).unwrap();
    assert_eq!(
        kinds(&changed, "src/my file.txt"),
        (ChangeKind::Unmodified, ChangeKind::Modified)
    );
}

#[test]
fn commit_needs_a_message_and_staged_changes() {
    let Some(h) = harness() else { return };
    ready(&h);
    write(&h.root, "a.txt", "x");
    assert_eq!(h.client.commit(&h.root, "   "), Err(GitError::EmptyMessage));
    assert_eq!(
        h.client.commit(&h.root, "msg"),
        Err(GitError::NothingStaged)
    );
}

#[test]
fn diffs_show_both_sides_for_working_tree_and_staged_changes() {
    let Some(h) = harness() else { return };
    ready(&h);
    commit_file(&h, "a b.txt", "one\n");
    write(&h.root, "a b.txt", "one\ntwo\n");

    let working = h.client.diff_sides(&h.root, "a b.txt", false).unwrap();
    assert_eq!(working.original.as_deref(), Some("one\n"));
    assert_eq!(working.modified.as_deref(), Some("one\ntwo\n"));

    h.client.stage(&h.root, &["a b.txt".into()]).unwrap();
    let staged = h.client.diff_sides(&h.root, "a b.txt", true).unwrap();
    assert_eq!(staged.original.as_deref(), Some("one\n"));
    assert_eq!(staged.modified.as_deref(), Some("one\ntwo\n"));

    // Added and deleted files have one empty side.
    write(&h.root, "new.txt", "n\n");
    let untracked = h.client.diff_sides(&h.root, "new.txt", false).unwrap();
    assert_eq!(
        (untracked.original, untracked.modified.as_deref()),
        (None, Some("n\n"))
    );
    std::fs::remove_file(h.root.join("a b.txt")).unwrap();
    h.client.stage(&h.root, &["a b.txt".into()]).unwrap();
    let deleted = h.client.diff_sides(&h.root, "a b.txt", true).unwrap();
    assert_eq!(
        (deleted.original.as_deref(), deleted.modified),
        (Some("one\n"), None)
    );
}

#[test]
fn a_binary_file_is_reported_as_binary() {
    let Some(h) = harness() else { return };
    ready(&h);
    std::fs::write(h.root.join("blob.bin"), [0u8, 1, 2, 0, 255]).unwrap();
    let sides = h.client.diff_sides(&h.root, "blob.bin", false).unwrap();
    assert!(sides.binary && sides.modified.is_none());
}

#[test]
fn discard_needs_confirmation_and_only_touches_tracked_edits() {
    let Some(h) = harness() else { return };
    ready(&h);
    commit_file(&h, "keep.txt", "original\n");
    write(&h.root, "keep.txt", "edited\n");
    write(&h.root, "untracked.txt", "u\n");

    assert_eq!(
        h.client.discard(&h.root, &["keep.txt".into()], false),
        Err(GitError::NotConfirmed("Discarding changes"))
    );
    assert_eq!(
        std::fs::read_to_string(h.root.join("keep.txt")).unwrap(),
        "edited\n"
    );
    // An untracked file is not a discard target.
    assert!(matches!(
        h.client.discard(&h.root, &["untracked.txt".into()], true),
        Err(GitError::NothingToDiscard(_))
    ));

    h.client
        .discard(&h.root, &["keep.txt".into()], true)
        .unwrap();
    assert_eq!(read(&h.root, "keep.txt"), "original\n");
    assert!(h.root.join("untracked.txt").exists());

    // Deleting an untracked file: confirmation, and it must really be untracked.
    assert!(h
        .client
        .delete_untracked(&h.root, "untracked.txt", false)
        .is_err());
    assert!(matches!(
        h.client.delete_untracked(&h.root, "keep.txt", true),
        Err(GitError::NothingToDiscard(_))
    ));
    h.client
        .delete_untracked(&h.root, "untracked.txt", true)
        .unwrap();
    assert!(!h.root.join("untracked.txt").exists());
}

#[test]
fn stage_all_unstage_all_and_discard_all() {
    let Some(h) = harness() else { return };
    ready(&h);
    commit_file(&h, "a.txt", "a\n");
    write(&h.root, "a.txt", "changed\n");
    write(&h.root, "b.txt", "b\n");

    h.client.stage_all(&h.root).unwrap();
    assert_eq!(h.client.status(&h.root).unwrap().staged_count(), 2);
    h.client.unstage_all(&h.root).unwrap();
    let status = h.client.status(&h.root).unwrap();
    assert_eq!(status.staged_count(), 0);
    assert_eq!(kinds(&status, "b.txt").1, ChangeKind::Untracked);

    assert_eq!(
        h.client.discard_all(&h.root, false),
        Err(GitError::NotConfirmed("Discarding all changes"))
    );
    h.client.discard_all(&h.root, true).unwrap();
    assert_eq!(read(&h.root, "a.txt"), "a\n");
    assert!(h.root.join("b.txt").exists());
}

#[test]
fn paths_that_leave_the_repository_are_refused_before_git_runs() {
    let Some(h) = harness() else { return };
    ready(&h);
    let before = h.log.lock().unwrap().len();
    for bad in [
        "../outside.txt",
        "/etc/passwd",
        "C:/Windows/x",
        ".git/config",
    ] {
        assert!(
            h.client.stage(&h.root, &[bad.to_string()]).is_err(),
            "{bad}"
        );
        assert!(h.client.diff_sides(&h.root, bad, false).is_err(), "{bad}");
    }
    assert_eq!(h.log.lock().unwrap().len(), before, "git must not have run");
}

#[test]
fn branches_can_be_listed_created_switched_and_deleted() {
    let Some(h) = harness() else { return };
    ready(&h);
    commit_file(&h, "a.txt", "a\n");
    let start = h.client.status(&h.root).unwrap().branch.unwrap();

    h.client.create_branch(&h.root, "feature/one").unwrap();
    let branches = h.client.branches(&h.root).unwrap();
    assert!(branches
        .iter()
        .any(|b| b.name == "feature/one" && b.current));
    assert!(branches.iter().any(|b| b.name == start && !b.current));

    assert!(matches!(
        h.client.create_branch(&h.root, "bad name"),
        Err(GitError::InvalidBranchName(_))
    ));
    assert!(matches!(
        h.client.create_branch(&h.root, "-D"),
        Err(GitError::InvalidBranchName(_))
    ));

    h.client.switch_branch(&h.root, &start).unwrap();
    assert_eq!(
        h.client.delete_branch(&h.root, "feature/one", false),
        Err(GitError::NotConfirmed("Deleting a branch"))
    );
    h.client
        .delete_branch(&h.root, "feature/one", true)
        .unwrap();
    assert!(!h
        .client
        .branches(&h.root)
        .unwrap()
        .iter()
        .any(|b| b.name == "feature/one"));
}

#[test]
fn switching_would_not_overwrite_local_changes_and_says_so() {
    let Some(h) = harness() else { return };
    ready(&h);
    commit_file(&h, "a.txt", "one\n");
    let start = h.client.status(&h.root).unwrap().branch.unwrap();
    h.client.create_branch(&h.root, "other").unwrap();
    write(&h.root, "a.txt", "two\n");
    h.client.stage_all(&h.root).unwrap();
    h.client.commit(&h.root, "two").unwrap();
    h.client.switch_branch(&h.root, &start).unwrap();
    write(&h.root, "a.txt", "local edit\n");

    let error = h.client.switch_branch(&h.root, "other").unwrap_err();
    assert!(
        error.to_string().to_lowercase().contains("overwritten"),
        "{error}"
    );
    assert_eq!(
        std::fs::read_to_string(h.root.join("a.txt")).unwrap(),
        "local edit\n",
        "the local edit must survive"
    );
}

#[test]
fn identity_round_trips_and_is_validated() {
    let Some(h) = harness() else { return };
    h.client.init(&h.root).unwrap();
    assert_eq!(
        h.client.set_identity(&h.root, "", "a@b.c"),
        Err(GitError::InvalidIdentity)
    );
    assert_eq!(
        h.client.set_identity(&h.root, "N", "no-at-sign"),
        Err(GitError::InvalidIdentity)
    );
    h.client.set_identity(&h.root, "Name", "n@x.io").unwrap();
    let identity = h.client.identity(&h.root).unwrap();
    assert_eq!(identity.name.as_deref(), Some("Name"));
    assert_eq!(identity.email.as_deref(), Some("n@x.io"));
}

#[test]
fn push_fetch_and_pull_work_against_a_local_remote_and_report_ahead_behind() {
    let Some(h) = harness() else { return };
    ready(&h);
    commit_file(&h, "a.txt", "a\n");
    let remote = h._temp.path().join("remote dir");
    std::fs::create_dir_all(&remote).unwrap();
    // A bare remote made with the same client's executable.
    let exe = h.client.executable().path.clone();
    let run = |cwd: &Path, args: &[&str]| {
        let status = std::process::Command::new(&exe)
            .args(args)
            .current_dir(cwd)
            .status()
            .unwrap();
        assert!(status.success(), "{args:?}");
    };
    run(&remote, &["init", "--bare", "-q"]);
    run(
        &h.root,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    let branch = h.client.status(&h.root).unwrap().branch.unwrap();
    run(&h.root, &["push", "-u", "-q", "origin", &branch]);

    write(&h.root, "b.txt", "b\n");
    h.client.stage_all(&h.root).unwrap();
    h.client.commit(&h.root, "second").unwrap();
    let status = h.client.status(&h.root).unwrap();
    assert_eq!((status.ahead, status.behind), (1, 0));

    h.client.push(&h.root).unwrap();
    assert_eq!(h.client.status(&h.root).unwrap().ahead, 0);
    h.client.fetch(&h.root).unwrap();
    h.client.pull(&h.root).unwrap();
}

#[test]
fn every_command_is_logged_without_the_commit_message() {
    let Some(h) = harness() else { return };
    ready(&h);
    write(&h.root, "a.txt", "x");
    h.client.stage(&h.root, &["a.txt".into()]).unwrap();
    h.client.commit(&h.root, "top secret message").unwrap();
    let log = h.log.lock().unwrap();
    assert!(log.iter().any(|entry| entry.label == "git add -- 1 path"));
    let commit = log
        .iter()
        .find(|entry| entry.label.starts_with("git commit"))
        .unwrap();
    assert_eq!(commit.label, "git commit -m <message>");
    assert_eq!(commit.code, Some(0));
    assert!(commit.cwd.contains("my project"));
    assert!(log.iter().all(|entry| !entry.label.contains("secret")));
}

fn raw(h: &Harness, cwd: &Path, args: &[&str]) {
    let status = std::process::Command::new(&h.client.executable().path)
        .args(args)
        .current_dir(cwd)
        .status()
        .unwrap();
    assert!(status.success(), "{args:?}");
}

#[test]
fn clone_from_a_local_bare_repository_into_a_folder_with_spaces() {
    let Some(h) = harness() else { return };
    ready(&h);
    commit_file(&h, "a.txt", "a\n");
    let bare = h._temp.path().join("bare repo.git");
    raw(
        &h,
        h._temp.path(),
        &[
            "clone",
            "--bare",
            "-q",
            h.root.to_str().unwrap(),
            bare.to_str().unwrap(),
        ],
    );

    let parent = h._temp.path().join("clones here");
    std::fs::create_dir_all(&parent).unwrap();
    let cloned = h
        .client
        .clone_repository(bare.to_str().unwrap(), &parent, "my clone")
        .unwrap();
    assert_eq!(cloned, parent.join("my clone"));
    assert_eq!(read(&cloned, "a.txt"), "a\n");
    assert!(h.client.find_root(&cloned).is_ok());

    // Not overwritten, and nothing was run for bad input.
    let before = h.log.lock().unwrap().len();
    let again = h
        .client
        .clone_repository(bare.to_str().unwrap(), &parent, "my clone")
        .unwrap_err();
    assert!(again.to_string().contains("not empty"), "{again}");
    assert!(h.client.clone_repository("", &parent, "x").is_err());
    assert!(h
        .client
        .clone_repository("--upload-pack=calc", &parent, "x")
        .is_err());
    assert!(h
        .client
        .clone_repository(bare.to_str().unwrap(), &parent.join("missing"), "x")
        .is_err());
    assert_eq!(h.log.lock().unwrap().len(), before);
    assert_eq!(read(&cloned, "a.txt"), "a\n");

    let logged = h.log.lock().unwrap();
    assert!(logged
        .iter()
        .any(|entry| entry.label.starts_with("git clone --progress --")));
}

#[test]
fn cloning_something_that_is_not_a_repository_reports_gits_error() {
    let Some(h) = harness() else { return };
    let parent = h._temp.path().join("p");
    std::fs::create_dir_all(&parent).unwrap();
    let missing = h._temp.path().join("nothing here");
    let error = h
        .client
        .clone_repository(missing.to_str().unwrap(), &parent, "c")
        .unwrap_err();
    assert!(matches!(error, GitError::Failed(_)), "{error}");
    assert!(!parent.join("c").join(".git").exists());
}

#[test]
fn history_lists_commits_newest_first_with_their_files_and_diffs() {
    let Some(h) = harness() else { return };
    ready(&h);
    assert!(h.client.history(&h.root, 50).unwrap().is_empty());
    commit_file(&h, "first file.txt", "one\n");
    write(&h.root, "first file.txt", "one\ntwo\n");
    write(&h.root, "second.txt", "s\n");
    h.client.stage_all(&h.root).unwrap();
    h.client.commit(&h.root, "second: change and add").unwrap();

    let commits = h.client.history(&h.root, 50).unwrap();
    assert_eq!(commits.len(), 2);
    assert_eq!(commits[0].subject, "second: change and add");
    assert_eq!(commits[0].author, "Test User");
    assert!(commits[0].hash.starts_with(&commits[0].short_hash));
    assert_eq!(h.client.history(&h.root, 1).unwrap().len(), 1);

    let files = h.client.commit_files(&h.root, &commits[0].hash).unwrap();
    let statuses: Vec<(&str, &str)> = files
        .iter()
        .map(|f| (f.path.as_str(), f.status.as_str()))
        .collect();
    assert!(statuses.contains(&("first file.txt", "M")), "{statuses:?}");
    assert!(statuses.contains(&("second.txt", "A")), "{statuses:?}");

    let modified = files.iter().find(|f| f.path == "first file.txt").unwrap();
    let sides = h
        .client
        .commit_diff_sides(&h.root, &commits[0].hash, modified)
        .unwrap();
    assert_eq!(sides.original.unwrap().replace("\r\n", "\n"), "one\n");
    assert_eq!(sides.modified.unwrap().replace("\r\n", "\n"), "one\ntwo\n");
    let added = files.iter().find(|f| f.path == "second.txt").unwrap();
    assert_eq!(
        h.client
            .commit_diff_sides(&h.root, &commits[0].hash, added)
            .unwrap()
            .original,
        None
    );

    // The root commit lists its file as added.
    let root_files = h.client.commit_files(&h.root, &commits[1].hash).unwrap();
    assert_eq!(root_files.len(), 1);
    assert_eq!(root_files[0].status, "A");

    assert!(matches!(
        h.client.commit_files(&h.root, "--output=x"),
        Err(GitError::InvalidCommit(_))
    ));
}

#[test]
fn blame_attributes_lines_and_explains_what_can_not_be_blamed() {
    let Some(h) = harness() else { return };
    ready(&h);
    commit_file(&h, "f g.txt", "one\ntwo\n");
    write(&h.root, "f g.txt", "one\ntwo\nthree\n");
    h.client.stage_all(&h.root).unwrap();
    h.client.commit(&h.root, "add three").unwrap();
    write(&h.root, "f g.txt", "one\ntwo\nthree\nuncommitted\n");

    let lines = h.client.blame(&h.root, "f g.txt").unwrap();
    assert_eq!(lines.len(), 4);
    assert_eq!(lines[0].summary, "add file");
    assert_eq!(lines[2].summary, "add three");
    assert_eq!(lines[0].author, "Test User");
    assert!(!lines[3].committed);
    assert_eq!(lines[3].content, "uncommitted");

    // An absolute path inside the repository works too; outside does not.
    let absolute = h.root.join("f g.txt");
    assert_eq!(
        h.client
            .blame(&h.root, absolute.to_str().unwrap())
            .unwrap()
            .len(),
        4
    );
    assert!(h.client.blame(&h.root, "C:/somewhere/else.txt").is_err());

    write(&h.root, "new.txt", "x\n");
    let untracked = h.client.blame(&h.root, "new.txt").unwrap_err();
    assert!(untracked.to_string().contains("untracked"), "{untracked}");

    std::fs::write(h.root.join("blob.bin"), [0u8, 1, 2, 0]).unwrap();
    h.client.stage(&h.root, &["blob.bin".into()]).unwrap();
    h.client.commit(&h.root, "binary").unwrap();
    let binary = h.client.blame(&h.root, "blob.bin").unwrap_err();
    assert!(binary.to_string().contains("Binary"), "{binary}");

    // Staged but not committed: every line is "not committed yet".
    h.client.stage(&h.root, &["new.txt".into()]).unwrap();
    let staged = h.client.blame(&h.root, "new.txt").unwrap();
    assert!(staged.iter().all(|line| !line.committed));
}

#[test]
fn blame_in_a_repository_without_commits_says_to_commit_first() {
    let Some(h) = harness() else { return };
    ready(&h);
    write(
        &h.root, "n.txt", "x
",
    );
    h.client.stage(&h.root, &["n.txt".into()]).unwrap();
    let error = h.client.blame(&h.root, "n.txt").unwrap_err();
    assert!(error.to_string().contains("no commits yet"), "{error}");
}

#[test]
fn stash_push_list_apply_pop_and_drop() {
    let Some(h) = harness() else { return };
    ready(&h);
    commit_file(&h, "a.txt", "base\n");

    // Nothing to stash.
    assert!(h.client.stash_push(&h.root, "x", false).is_err());
    assert!(h.client.stash_list(&h.root).unwrap().is_empty());

    write(&h.root, "a.txt", "edited\n");
    h.client.stash_push(&h.root, "my work", false).unwrap();
    assert!(h.client.status(&h.root).unwrap().changes.is_empty());
    assert_eq!(read(&h.root, "a.txt"), "base\n");
    let stashes = h.client.stash_list(&h.root).unwrap();
    assert_eq!(stashes.len(), 1);
    assert_eq!(stashes[0].message.as_deref(), Some("my work"));

    // Apply keeps the stash.
    h.client.stash_apply(&h.root, 0).unwrap();
    assert_eq!(read(&h.root, "a.txt"), "edited\n");
    assert_eq!(h.client.stash_list(&h.root).unwrap().len(), 1);
    h.client.discard(&h.root, &["a.txt".into()], true).unwrap();

    // Pop removes it.
    h.client.stash_pop(&h.root, 0).unwrap();
    assert_eq!(read(&h.root, "a.txt"), "edited\n");
    assert!(h.client.stash_list(&h.root).unwrap().is_empty());

    // Drop needs confirmation.
    h.client.stash_push(&h.root, "", false).unwrap();
    assert_eq!(
        h.client.stash_drop(&h.root, 0, false),
        Err(GitError::NotConfirmed("Dropping a stash"))
    );
    assert_eq!(h.client.stash_list(&h.root).unwrap().len(), 1);
    h.client.stash_drop(&h.root, 0, true).unwrap();
    assert!(h.client.stash_list(&h.root).unwrap().is_empty());
    assert!(h.client.stash_drop(&h.root, 5, true).is_err());
}

#[test]
fn stash_of_untracked_files_needs_the_option_and_bad_messages_are_refused() {
    let Some(h) = harness() else { return };
    ready(&h);
    commit_file(&h, "a.txt", "base\n");
    write(&h.root, "only new.txt", "n\n");
    let hint = h.client.stash_push(&h.root, "", false).unwrap_err();
    assert!(hint.to_string().contains("Include untracked"), "{hint}");
    h.client
        .stash_push(&h.root, "with untracked", true)
        .unwrap();
    assert!(!h.root.join("only new.txt").exists());
    h.client.stash_pop(&h.root, 0).unwrap();
    assert!(h.root.join("only new.txt").exists());
    write(&h.root, "a.txt", "e\n");
    assert!(h.client.stash_push(&h.root, "two\nlines", false).is_err());
}

#[test]
fn a_conflicting_stash_pop_is_reported_and_the_stash_is_kept() {
    let Some(h) = harness() else { return };
    ready(&h);
    commit_file(&h, "a.txt", "base\n");
    write(&h.root, "a.txt", "stashed change\n");
    h.client.stash_push(&h.root, "conflict me", false).unwrap();
    write(&h.root, "a.txt", "different change\n");
    h.client.stage_all(&h.root).unwrap();
    h.client.commit(&h.root, "diverge").unwrap();

    let error = h.client.stash_pop(&h.root, 0).unwrap_err().to_string();
    assert!(error.to_lowercase().contains("conflict"), "{error}");
    assert_eq!(
        h.client.stash_list(&h.root).unwrap().len(),
        1,
        "the stash must survive a conflict"
    );
    let status = h.client.status(&h.root).unwrap();
    assert!(status.changes.iter().any(|change| change.conflicted));
}

#[test]
fn a_renamed_file_is_reported_as_a_rename_with_its_old_name_and_a_safe_diff() {
    let Some(h) = harness() else { return };
    ready(&h);
    commit_file(
        &h,
        "old name.txt",
        "some content that is long enough to be recognised as the same file\n",
    );
    raw(&h, &h.root, &["mv", "old name.txt", "new name.txt"]);

    let status = h.client.status(&h.root).unwrap();
    let renamed = status
        .changes
        .iter()
        .find(|change| change.path == "new name.txt")
        .expect("rename in status");
    assert_eq!(renamed.index, ChangeKind::Renamed);
    assert_eq!(renamed.orig_path.as_deref(), Some("old name.txt"));
    assert_eq!(status.changes.len(), 1, "{:?}", status.changes);

    let sides = h.client.diff_sides(&h.root, "new name.txt", true).unwrap();
    assert!(sides.original.unwrap().contains("some content"));
    assert!(sides.modified.unwrap().contains("some content"));

    // Unstaging the rename puts both halves back as separate changes.
    h.client
        .unstage(&h.root, &["new name.txt".into(), "old name.txt".into()])
        .unwrap();
    let after = h.client.status(&h.root).unwrap();
    assert!(after
        .changes
        .iter()
        .any(|c| c.path == "old name.txt" && c.worktree == ChangeKind::Deleted));
    assert!(after
        .changes
        .iter()
        .any(|c| c.path == "new name.txt" && c.is_untracked()));
}

#[cfg(windows)]
#[test]
fn stopping_all_kills_a_running_git_command_and_what_it_started() {
    let Some(h) = harness() else { return };
    let registry = GitRegistry::default();
    let exe = h.client.executable().path.clone();
    let cwd = h.root.clone();
    let runner_registry = registry.clone();
    // An alias that runs a long `ping` through Git's shell: git.exe plus a grandchild.
    let worker = std::thread::spawn(move || {
        openmind_git::exec::run(
            &exe,
            &cwd,
            &[
                "-c".to_string(),
                "alias.slow=!ping -n 40 127.0.0.1".to_string(),
                "slow".to_string(),
            ],
            std::time::Duration::from_secs(60),
            &runner_registry,
        )
    });
    let started = std::time::Instant::now();
    while registry.active() == 0 && started.elapsed() < std::time::Duration::from_secs(10) {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert_eq!(
        registry.active(),
        1,
        "the command should be registered while it runs"
    );
    std::thread::sleep(std::time::Duration::from_millis(800));
    registry.stop_all();
    let result = worker.join().unwrap();
    assert!(
        started.elapsed() < std::time::Duration::from_secs(20),
        "stop_all must end it quickly"
    );
    assert!(result.map(|output| !output.success()).unwrap_or(true));
    assert_eq!(registry.active(), 0);
}
