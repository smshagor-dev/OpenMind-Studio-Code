//! The per-file Git operations against a real `git` (skipped on a machine without one), in a repository with a
//! rename, a branch, a tag, two remotes and a detached HEAD — so every result is known in advance.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use openmind_git::{find_system, resolve, GitClient, GitError, GitRegistry, RefKind};

struct Repo {
    client: GitClient,
    _temp: tempfile::TempDir,
    root: PathBuf,
}

fn git_in(client: &GitClient, root: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new(&client.executable().path)
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn git(repo: &Repo, args: &[&str]) -> String {
    git_in(&repo.client, &repo.root, args)
}

fn write(root: &Path, name: &str, text: &str) {
    let path = root.join(name);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn commit(repo: &Repo, message: &str, date: &str) -> String {
    git(repo, &["add", "-A"]);
    git(repo, &["commit", "-q", "-m", message, "--date", date]);
    git(repo, &["rev-parse", "HEAD"])
}

fn client() -> Option<GitClient> {
    let path = std::env::var_os("PATH");
    find_system(path.clone())?;
    let exe = resolve(&[], true, path).ok()?;
    Some(GitClient::new(
        exe,
        Arc::new(|_| {}),
        GitRegistry::default(),
    ))
}

/// Two commits of `docs/old näme.txt`, an unrelated one, then a rename to `src/new name.txt` with an added line.
fn repo() -> Option<(Repo, Vec<String>)> {
    let client = client()?;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("my repo ü");
    std::fs::create_dir_all(&root).unwrap();
    let repo = Repo {
        client,
        _temp: temp,
        root,
    };
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "user.name", "Test User"]);
    git(&repo, &["config", "user.email", "test@example.com"]);
    git(&repo, &["config", "core.autocrlf", "false"]);
    let mut hashes = Vec::new();
    write(&repo.root, "docs/old näme.txt", "one\n");
    hashes.push(commit(&repo, "first", "2026-01-01T00:00:00+00:00"));
    write(&repo.root, "docs/old näme.txt", "one\ntwo\n");
    write(&repo.root, "other.txt", "x\n");
    hashes.push(commit(
        &repo,
        "second: add two",
        "2026-01-02T00:00:00+00:00",
    ));
    write(&repo.root, "other.txt", "y\n");
    commit(&repo, "unrelated", "2026-01-03T00:00:00+00:00");
    std::fs::create_dir_all(repo.root.join("src")).unwrap();
    git(&repo, &["mv", "docs/old näme.txt", "src/new name.txt"]);
    write(&repo.root, "src/new name.txt", "one\ntwo\nthree\n");
    hashes.push(commit(
        &repo,
        "rename and extend",
        "2026-01-04T00:00:00+00:00",
    ));
    Some((repo, hashes))
}

#[test]
fn file_history_follows_the_rename_newest_first_with_counts() {
    let Some((repo, hashes)) = repo() else { return };
    let page = repo
        .client
        .file_log(&repo.root, "src/new name.txt", 0, 50)
        .unwrap();
    assert!(!page.more);
    let found: Vec<&str> = page.commits.iter().map(|c| c.hash.as_str()).collect();
    assert_eq!(
        found,
        vec![hashes[2].as_str(), hashes[1].as_str(), hashes[0].as_str()]
    );
    assert_eq!(page.commits[0].path.as_deref(), Some("src/new name.txt"));
    assert_eq!(
        page.commits[1].path.as_deref(),
        Some("docs/old näme.txt"),
        "unicode names are not quoted"
    );
    assert_eq!(page.commits[1].additions, Some(1));
    assert_eq!(page.commits[0].subject, "rename and extend");
    assert_eq!(page.commits[0].author, "Test User");
    assert!(page.commits[0].author_time > 0);
}

#[test]
fn file_history_pages_report_whether_more_commits_exist() {
    let Some((repo, hashes)) = repo() else { return };
    let first = repo
        .client
        .file_log(&repo.root, "src/new name.txt", 0, 2)
        .unwrap();
    assert_eq!(first.commits.len(), 2);
    assert!(first.more);
    let second = repo
        .client
        .file_log(&repo.root, "src/new name.txt", 2, 2)
        .unwrap();
    assert_eq!(second.commits.len(), 1);
    assert_eq!(second.commits[0].hash, hashes[0]);
    assert!(!second.more);
}

#[test]
fn a_file_at_a_revision_is_its_text_or_absent() {
    let Some((repo, hashes)) = repo() else { return };
    let old = repo
        .client
        .file_at(&repo.root, &hashes[1], "docs/old näme.txt")
        .unwrap();
    assert_eq!(old.text.as_deref(), Some("one\ntwo\n"));
    let missing = repo
        .client
        .file_at(&repo.root, &hashes[1], "src/new name.txt")
        .unwrap();
    assert_eq!(
        missing.text, None,
        "the new name didn't exist before the rename"
    );
    let head = repo
        .client
        .file_at(&repo.root, "HEAD", "src/new name.txt")
        .unwrap();
    assert_eq!(head.text.as_deref(), Some("one\ntwo\nthree\n"));
    for bad in ["--output=x", "a..b", "HEAD:x"] {
        assert!(matches!(
            repo.client.file_at(&repo.root, bad, "src/new name.txt"),
            Err(GitError::InvalidCommit(_))
        ));
    }
    assert!(repo
        .client
        .file_at(&repo.root, "HEAD", "../outside.txt")
        .is_err());
}

#[test]
fn refs_list_branches_tags_and_resolve_revisions() {
    let Some((repo, hashes)) = repo() else { return };
    git(&repo, &["branch", "feature/a", &hashes[0]]);
    git(&repo, &["tag", "-a", "v1.0", "-m", "release", &hashes[1]]);
    let refs = repo.client.refs(&repo.root).unwrap();
    let main = refs.iter().find(|r| r.name == "main").unwrap();
    assert_eq!(main.kind, RefKind::Branch);
    assert_eq!(main.hash, hashes[2]);
    assert!(refs
        .iter()
        .any(|r| r.name == "feature/a" && r.hash == hashes[0]));
    let tag = refs.iter().find(|r| r.name == "v1.0").unwrap();
    assert_eq!(tag.kind, RefKind::Tag);
    assert_eq!(
        tag.hash, hashes[1],
        "annotated tags are peeled to their commit"
    );
    assert_eq!(
        repo.client
            .resolve_revision(&repo.root, "v1.0")
            .unwrap()
            .as_deref(),
        Some(hashes[1].as_str())
    );
    assert_eq!(
        repo.client.resolve_revision(&repo.root, "nope").unwrap(),
        None
    );
}

#[test]
fn remotes_upstream_and_published_commits() {
    let Some((repo, hashes)) = repo() else { return };
    let info = repo.client.remote_info(&repo.root).unwrap();
    assert!(info.remotes.is_empty());
    assert_eq!(info.branch.as_deref(), Some("main"));
    assert_eq!(info.upstream, None);
    assert_eq!(info.head.as_deref(), Some(hashes[2].as_str()));

    git(
        &repo,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/owner/repo.git",
        ],
    );
    git(
        &repo,
        &[
            "remote",
            "add",
            "mirror",
            "git@gitlab.com:group/sub/repo.git",
        ],
    );
    // A remote-tracking branch as `git fetch` would leave it, without any network.
    git(
        &repo,
        &["update-ref", "refs/remotes/origin/main", &hashes[1]],
    );
    git(&repo, &["branch", "--set-upstream-to=origin/main"]);
    let info = repo.client.remote_info(&repo.root).unwrap();
    assert_eq!(info.remotes.len(), 2);
    assert!(info
        .remotes
        .iter()
        .any(|r| r.url == "https://github.com/owner/repo.git"));
    assert_eq!(info.upstream.as_deref(), Some("origin/main"));
    assert_eq!(
        repo.client
            .remote_branches_containing(&repo.root, &hashes[0])
            .unwrap(),
        vec!["origin/main".to_string()]
    );
    assert!(
        repo.client
            .remote_branches_containing(&repo.root, &hashes[2])
            .unwrap()
            .is_empty(),
        "the newest commit isn't pushed"
    );
}

#[test]
fn a_detached_head_has_no_branch_but_a_commit() {
    let Some((repo, hashes)) = repo() else { return };
    git(&repo, &["checkout", "-q", "--detach", &hashes[1]]);
    let info = repo.client.remote_info(&repo.root).unwrap();
    assert_eq!(info.branch, None);
    assert_eq!(info.upstream, None);
    assert_eq!(info.head.as_deref(), Some(hashes[1].as_str()));
    let page = repo
        .client
        .file_log(&repo.root, "docs/old näme.txt", 0, 10)
        .unwrap();
    assert_eq!(page.commits.len(), 2);
}

#[test]
fn commit_details_have_people_message_and_files() {
    let Some((repo, hashes)) = repo() else { return };
    let details = repo.client.commit_details(&repo.root, &hashes[2]).unwrap();
    assert_eq!(details.hash, hashes[2]);
    assert_eq!(details.message, "rename and extend");
    assert_eq!(details.author_email, "test@example.com");
    assert_eq!(details.parents.len(), 1);
    let renamed = details
        .files
        .iter()
        .find(|f| f.path == "src/new name.txt")
        .unwrap();
    assert_eq!(renamed.status, "R");
    assert_eq!(renamed.orig_path.as_deref(), Some("docs/old näme.txt"));
    assert!(matches!(
        repo.client.commit_details(&repo.root, "HEAD"),
        Err(GitError::InvalidCommit(_))
    ));
}

#[test]
fn blame_lines_carry_the_full_commit_id() {
    let Some((repo, hashes)) = repo() else { return };
    let lines = repo.client.blame(&repo.root, "src/new name.txt").unwrap();
    assert_eq!(lines.len(), 3);
    assert_eq!(
        lines[0].hash, hashes[0],
        "blame follows the rename back to the first commit"
    );
    assert_eq!(lines[2].hash, hashes[2]);
}

#[test]
fn a_repository_without_commits_has_an_empty_history_and_no_head() {
    let Some(client) = client() else { return };
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("fresh repo");
    std::fs::create_dir_all(&root).unwrap();
    git_in(&client, &root, &["init", "-q"]);
    write(&root, "a.txt", "a\n");
    let page = client.file_log(&root, "a.txt", 0, 10).unwrap();
    assert!(page.commits.is_empty());
    let info = client.remote_info(&root).unwrap();
    assert_eq!(info.head, None);
}

#[test]
fn a_nested_repository_is_found_from_a_file_inside_it() {
    let Some((repo, _)) = repo() else { return };
    let nested = repo.root.join("vendor lib");
    std::fs::create_dir_all(&nested).unwrap();
    git_in(&repo.client, &nested, &["init", "-q"]);
    let found = repo.client.find_root(&nested).unwrap();
    assert!(found.ends_with("vendor lib"), "{found:?}");
}

#[test]
fn remotes_are_the_configured_addresses_even_when_git_rewrites_them() {
    let Some((repo, _)) = repo() else { return };
    git(
        &repo,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/owner/repo.git",
        ],
    );
    // What the app's download gateway sets for the processes it starts.
    git(
        &repo,
        &[
            "config",
            "url.http://127.0.0.1:9/git/https/github.com/.insteadOf",
            "https://github.com/",
        ],
    );
    let rewritten = git(&repo, &["remote", "-v"]);
    assert!(rewritten.contains("127.0.0.1"), "{rewritten}");
    let info = repo.client.remote_info(&repo.root).unwrap();
    assert_eq!(info.remotes[0].url, "https://github.com/owner/repo.git");
}
