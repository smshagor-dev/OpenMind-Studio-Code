//! Tests of the extension store (install, list, enable/disable, uninstall, grants, Run Anyway).
use super::*;
use crate::permissions::Permission;

struct Rig {
    _dir: tempfile::TempDir,
    store: ExtensionStore,
    root: PathBuf,
}

fn rig() -> Rig {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("My App").join("extensions");
    let store = ExtensionStore::new(ExtensionPaths::new(&root));
    store.paths().ensure().expect("layout");
    Rig {
        _dir: dir,
        store,
        root,
    }
}

fn make_vsix(root: &Path, name: &str, version: &str, extra: &str) -> PathBuf {
    let source = root.join(format!("src-{name}-{version}"));
    fs::create_dir_all(&source).expect("mkdir");
    fs::write(
        source.join("package.json"),
        format!(
            r#"{{"name":"{name}","version":"{version}","publisher":"acme","displayName":"{name} ext","main":"./extension.js"{extra}}}"#
        ),
    )
    .expect("manifest");
    fs::write(source.join("extension.js"), "exports.activate = () => {};").expect("code");
    fs::write(source.join("theme.json"), r#"{"colors":{}}"#).expect("theme");
    let out = root.join(format!("{name}-{version}.vsix"));
    vsix::pack(&source, &out).expect("packed");
    out
}

#[test]
fn install_puts_the_extension_under_installed_and_lists_it() {
    let r = rig();
    let vsix = make_vsix(&r.root, "hello", "1.0.0", "");
    let installed = r.store.install(&vsix, false).expect("installed");
    assert_eq!(installed.id, "acme.hello");
    assert!(installed.enabled);
    assert_eq!(
        installed.path,
        r.root.join("installed").join("acme.hello-1.0.0")
    );
    assert!(installed.path.join("extension.js").is_file());
    assert_eq!(
        installed.runtime_requirement.as_deref(),
        Some(NODE_REQUIRED)
    );
    let listing = r.store.list();
    assert_eq!(listing.extensions.len(), 1);
    assert!(listing.broken.is_empty());
    assert!(
        fs::read_dir(&r.store.paths().staging)
            .map(|d| d.count())
            .unwrap_or(0)
            == 0,
        "staging is cleaned"
    );
}

#[test]
fn installing_the_same_extension_again_is_refused_unless_replacing() {
    let r = rig();
    r.store
        .install(&make_vsix(&r.root, "hello", "1.0.0", ""), false)
        .expect("first");
    let again = r
        .store
        .install(&make_vsix(&r.root, "hello", "1.0.0", ""), false);
    assert!(
        matches!(again, Err(ExtensionError::AlreadyInstalled(ref id)) if id == "acme.hello 1.0.0")
    );
    let update = r
        .store
        .install(&make_vsix(&r.root, "hello", "1.1.0", ""), true)
        .expect("update");
    assert_eq!(update.manifest.version, "1.1.0");
    let listing = r.store.list();
    assert_eq!(listing.extensions.len(), 1, "the old version is gone");
    assert!(!r.root.join("installed").join("acme.hello-1.0.0").exists());
}

#[test]
fn a_bad_archive_installs_nothing_and_leaves_no_staging_folder() {
    let r = rig();
    let bad = r.root.join("bad.vsix");
    fs::write(&bad, "nope").expect("write");
    assert!(r.store.install(&bad, false).is_err());
    assert!(r.store.list().extensions.is_empty());
    assert!(
        fs::read_dir(&r.store.paths().staging)
            .map(|d| d.count())
            .unwrap_or(0)
            == 0
    );
}

#[test]
fn disabling_moves_the_folder_and_the_state_survives_a_new_store() {
    let r = rig();
    r.store
        .install(&make_vsix(&r.root, "hello", "1.0.0", ""), false)
        .expect("installed");

    let disabled = r.store.set_enabled("acme.hello", false).expect("disabled");
    assert!(!disabled.enabled);
    assert!(r.root.join("disabled").join("acme.hello-1.0.0").is_dir());
    assert!(!r.root.join("installed").join("acme.hello-1.0.0").exists());

    // A different store over the same folders (a restart) sees the same state.
    let restarted = ExtensionStore::new(ExtensionPaths::new(&r.root));
    assert!(!restarted.find("acme.hello").expect("found").enabled);

    let enabled = restarted.set_enabled("ACME.Hello", true).expect("enabled");
    assert!(enabled.enabled);
    assert!(r.root.join("installed").join("acme.hello-1.0.0").is_dir());
    // Enabling an enabled extension is a no-op.
    assert!(
        restarted
            .set_enabled("acme.hello", true)
            .expect("noop")
            .enabled
    );
}

#[test]
fn a_disabled_extension_stays_disabled_when_it_is_updated() {
    let r = rig();
    r.store
        .install(&make_vsix(&r.root, "hello", "1.0.0", ""), false)
        .expect("installed");
    r.store.set_enabled("acme.hello", false).expect("disabled");
    let updated = r
        .store
        .install(&make_vsix(&r.root, "hello", "2.0.0", ""), true)
        .expect("update");
    assert!(!updated.enabled);
    assert!(r.root.join("disabled").join("acme.hello-2.0.0").is_dir());
}

#[test]
fn uninstall_removes_only_that_extensions_folder() {
    let r = rig();
    r.store
        .install(&make_vsix(&r.root, "hello", "1.0.0", ""), false)
        .expect("a");
    r.store
        .install(&make_vsix(&r.root, "other", "1.0.0", ""), false)
        .expect("b");
    // An unrelated file next to them must survive.
    fs::write(r.root.join("installed").join("keep.txt"), "x").expect("keep");

    r.store.uninstall("acme.hello").expect("uninstalled");

    assert!(!r.root.join("installed").join("acme.hello-1.0.0").exists());
    assert!(r.root.join("installed").join("acme.other-1.0.0").is_dir());
    assert!(r.root.join("installed").join("keep.txt").is_file());
    assert!(matches!(
        r.store.uninstall("acme.hello"),
        Err(ExtensionError::NotInstalled(_))
    ));
}

#[test]
fn a_disabled_extension_can_be_uninstalled_too() {
    let r = rig();
    r.store
        .install(&make_vsix(&r.root, "hello", "1.0.0", ""), false)
        .expect("a");
    r.store.set_enabled("acme.hello", false).expect("disabled");
    r.store.uninstall("acme.hello").expect("uninstalled");
    assert!(r.store.list().extensions.is_empty());
    assert!(fs::read_dir(r.root.join("disabled")).expect("dir").count() == 0);
}

#[test]
fn ensure_inside_refuses_paths_outside_the_base() {
    let r = rig();
    let outside = r.root.parent().expect("parent").to_path_buf();
    assert!(ensure_inside(&r.root.join("installed"), &outside).is_err());
    assert!(
        ensure_inside(&r.root.join("installed"), &r.root.join("installed")).is_err(),
        "the base itself is not deletable"
    );
    assert!(ensure_inside(
        &r.root.join("installed"),
        &r.root.join("installed").join("nope")
    )
    .is_err());
}

#[test]
fn broken_folders_are_reported_not_hidden_and_do_not_break_the_list() {
    let r = rig();
    r.store
        .install(&make_vsix(&r.root, "hello", "1.0.0", ""), false)
        .expect("a");
    fs::create_dir_all(r.root.join("installed").join("junk.folder-1.0.0")).expect("mkdir");
    fs::create_dir_all(r.root.join("disabled").join("bad.json-1.0.0")).expect("mkdir");
    fs::write(
        r.root
            .join("disabled")
            .join("bad.json-1.0.0")
            .join("package.json"),
        "{ nope",
    )
    .expect("write");
    let listing = r.store.list();
    assert_eq!(listing.extensions.len(), 1);
    assert_eq!(listing.broken.len(), 2);
    assert!(listing
        .broken
        .iter()
        .any(|b| b.folder == "bad.json-1.0.0" && !b.enabled && b.error.contains("not valid JSON")));
    assert!(listing
        .broken
        .iter()
        .any(|b| b.folder == "junk.folder-1.0.0" && b.error.contains("can't be read")));
}

#[test]
fn read_text_reads_only_inside_the_extension_folder() {
    let r = rig();
    r.store
        .install(&make_vsix(&r.root, "hello", "1.0.0", ""), false)
        .expect("a");
    assert_eq!(
        r.store
            .read_text("acme.hello", "./theme.json")
            .expect("read"),
        r#"{"colors":{}}"#
    );
    assert!(r
        .store
        .read_text("acme.hello", "../../installed/keep")
        .is_err());
    assert!(r.store.read_text("acme.hello", "missing.json").is_err());
    assert!(r.store.read_text("acme.nothing", "theme.json").is_err());
    assert!(r
        .store
        .read_text("acme.hello", "C:/Windows/win.ini")
        .is_err());
}

#[test]
fn warnings_and_unsupported_points_are_reported() {
    let r = rig();
    let extra = r#","browser":"./web.js","activationEvents":["*","onDebug"],"extensionDependencies":["acme.base"],"contributes":{"grammars":[{"language":"x","scopeName":"s","path":"p"}],"commands":[{"command":"a.b","title":"B"}]}"#;
    let installed = r
        .store
        .install(&make_vsix(&r.root, "hello", "1.0.0", extra), false)
        .expect("a");
    let listing = r.store.list();
    let warnings = &listing.extensions[0].warnings;
    assert!(warnings.iter().any(|w| w.contains("every start-up")));
    assert!(warnings
        .iter()
        .any(|w| w.contains("\"onDebug\" isn't supported")));
    assert!(warnings.iter().any(|w| w.contains("Requires acme.base")));
    assert!(installed
        .points
        .iter()
        .any(|p| p.point == "grammars" && p.support == Support::Unsupported));
    assert_eq!(supported_points(&installed), ["commands"]);
    assert!(installed
        .activation_events
        .contains(&"onCommand:a.b".to_string()));
}

#[test]
fn an_extension_without_code_has_no_runtime_requirement() {
    let r = rig();
    let source = r.root.join("themeonly");
    fs::create_dir_all(&source).expect("mkdir");
    fs::write(
        source.join("package.json"),
        r#"{"name":"tonly","version":"1.0.0","publisher":"acme"}"#,
    )
    .expect("w");
    let vsix = r.root.join("t.vsix");
    vsix::pack(&source, &vsix).expect("packed");
    assert_eq!(
        r.store
            .install(&vsix, false)
            .expect("ok")
            .runtime_requirement,
        None
    );
}

fn listing_ids(r: &Rig) -> Vec<String> {
    r.store
        .list()
        .extensions
        .into_iter()
        .map(|e| e.id)
        .collect()
}

#[test]
fn permissions_are_shown_before_installing_and_stored_when_installed() {
    let r = rig();
    let vsix = make_vsix(
        &r.root,
        "perm",
        "1.0.0",
        r#","openmindPermissions":["network"],"contributes":{"commands":[{"command":"perm.run","title":"Run"}]}"#,
    );
    let preview = super::preview(vsix::inspect(&vsix).expect("inspected").manifest);
    assert_eq!(preview.permissions.requested, vec![Permission::Network]);
    assert_eq!(preview.permissions.inferred, vec![Permission::Commands]);
    assert_eq!(preview.permissions.high_risk, vec![Permission::Network]);
    let installed = r.store.install(&vsix, false).expect("installed");
    assert_eq!(
        installed.permissions.accepted,
        vec![Permission::Commands, Permission::Network]
    );
    assert!(installed.path.join(permissions::ACCEPTED_FILE).is_file());
}

#[test]
fn an_unknown_permission_is_refused_and_nothing_is_installed() {
    let r = rig();
    // Not even a package can be built with one; a hand-made archive is refused when it is read.
    let source = r.root.join("src-wild");
    fs::create_dir_all(&source).expect("mkdir");
    fs::write(
        source.join("package.json"),
        r#"{"name":"wild","version":"1.0.0","openmindPermissions":["root"]}"#,
    )
    .expect("manifest");
    assert!(vsix::pack(&source, &r.root.join("wild.vsix")).is_err());
    assert!(listing_ids(&r).is_empty());
}

#[test]
fn an_oversized_or_overfull_package_is_refused_before_anything_is_written() {
    let r = rig();
    let vsix = make_vsix(&r.root, "big", "1.0.0", "");
    let tiny_archive = Limits {
        max_archive_bytes: 10,
        ..Limits::default()
    };
    let err = r
        .store
        .clone()
        .with_limits(tiny_archive)
        .install(&vsix, false)
        .expect_err("archive limit");
    assert!(err.to_string().contains("limit"), "{err}");
    let tiny_total = Limits {
        max_total_bytes: 10,
        ..Limits::default()
    };
    let err = r
        .store
        .clone()
        .with_limits(tiny_total)
        .install(&vsix, false)
        .expect_err("size limit");
    assert!(err.to_string().contains("extract to more than"), "{err}");
    let few_files = Limits {
        max_entries: 1,
        ..Limits::default()
    };
    let err = r
        .store
        .clone()
        .with_limits(few_files)
        .install(&vsix, false)
        .expect_err("count limit");
    assert!(err.to_string().contains("more than 1 files"), "{err}");
    let small_manifest = Limits {
        max_manifest_bytes: 5,
        ..Limits::default()
    };
    let err = r
        .store
        .clone()
        .with_limits(small_manifest)
        .install(&vsix, false)
        .expect_err("manifest limit");
    assert!(err.to_string().contains("unreasonably large"), "{err}");
    assert!(listing_ids(&r).is_empty());
    assert!(!r.store.paths().installed.join("acme.big-1.0.0").exists());
}

#[test]
fn ids_with_path_characters_are_refused() {
    for (name, publisher) in [
        ("a/b", "acme"),
        ("..", "acme"),
        ("ok", "a\\b"),
        ("a b", "acme"),
        ("c:x", "acme"),
    ] {
        let text = format!(r#"{{"name":"{name}","version":"1.0.0","publisher":"{publisher}"}}"#);
        assert!(Manifest::parse(&text).is_err(), "{name} / {publisher}");
    }
}

#[test]
fn a_manifest_missing_required_fields_is_refused() {
    for text in [
        r#"{"version":"1.0.0"}"#,
        r#"{"name":"x"}"#,
        r#"{"name":"x","version":"one"}"#,
        "[]",
        "not json",
    ] {
        assert!(Manifest::parse(text).is_err(), "{text}");
    }
}

#[test]
fn contribution_mistakes_are_refused_with_a_clear_message() {
    let base = |contributes: &str| {
        format!(r#"{{"name":"x","version":"1.0.0","contributes":{contributes}}}"#)
    };
    let no_title =
        Manifest::parse(&base(r#"{"commands":[{"command":"x.run"}]}"#)).expect_err("title");
    assert!(no_title.to_string().contains("has no title"), "{no_title}");
    let twice = Manifest::parse(&base(
        r#"{"commands":[{"command":"x.run","title":"A"},{"command":"x.run","title":"B"}]}"#,
    ))
    .expect_err("duplicate");
    assert!(twice.to_string().contains("twice"), "{twice}");
    let default = Manifest::parse(&base(
        r#"{"configuration":{"properties":{"x.n":{"type":"integer","default":"many"}}}}"#,
    ))
    .expect_err("default");
    assert!(
        default.to_string().contains("default of setting \"x.n\""),
        "{default}"
    );
    let enum_default = Manifest::parse(&base(
        r#"{"configuration":{"properties":{"x.m":{"type":"string","enum":["a","b"],"default":"c"}}}}"#,
    ))
    .expect_err("enum default");
    assert!(
        enum_default.to_string().contains("invalid"),
        "{enum_default}"
    );
}

#[test]
fn a_manifest_pointing_at_a_missing_file_is_refused_and_leaves_no_trace() {
    let r = rig();
    let vsix = make_vsix(
        &r.root,
        "gone",
        "1.0.0",
        r#","contributes":{"themes":[{"label":"T","uiTheme":"vs-dark","path":"./missing.json"}]}"#,
    );
    let err = r.store.install(&vsix, false).expect_err("missing theme");
    assert!(err.to_string().contains("theme file"), "{err}");
    let vsix = make_vsix(
        &r.root,
        "gone2",
        "1.0.0",
        r#","contributes":{"snippets":[{"language":"x","path":"./nope.json"}]}"#,
    );
    let err = r.store.install(&vsix, false).expect_err("missing snippets");
    assert!(err.to_string().contains("snippets file"), "{err}");
    assert!(listing_ids(&r).is_empty());
    assert!(
        fs::read_dir(&r.store.paths().staging)
            .map(|d| d.count())
            .unwrap_or(0)
            == 0
    );
}

#[test]
fn a_failed_install_leaves_the_other_extensions_intact() {
    let r = rig();
    let good = make_vsix(&r.root, "good", "1.0.0", "");
    r.store.install(&good, false).expect("installed");
    let bad = make_vsix(
        &r.root,
        "bad",
        "1.0.0",
        r#","contributes":{"themes":[{"label":"T","path":"./missing.json"}]}"#,
    );
    assert!(r.store.install(&bad, false).is_err());
    assert!(r
        .store
        .install(&r.root.join("missing.vsix"), false)
        .is_err());
    assert_eq!(listing_ids(&r), vec!["acme.good".to_string()]);
    assert!(r.store.list().broken.is_empty());
}

#[test]
fn two_extensions_contributing_one_command_are_reported() {
    let r = rig();
    let contributes = r#","contributes":{"commands":[{"command":"shared.run","title":"Run"}]}"#;
    r.store
        .install(&make_vsix(&r.root, "aaa", "1.0.0", contributes), false)
        .expect("a");
    r.store
        .install(&make_vsix(&r.root, "bbb", "1.0.0", contributes), false)
        .expect("b");
    let listing = r.store.list();
    let first = listing
        .extensions
        .iter()
        .find(|e| e.id == "acme.aaa")
        .expect("aaa");
    let second = listing
        .extensions
        .iter()
        .find(|e| e.id == "acme.bbb")
        .expect("bbb");
    assert!(first.warnings.iter().all(|w| !w.contains("shared.run")));
    assert!(
        second
            .warnings
            .iter()
            .any(|w| w.contains("shared.run") && w.contains("acme.aaa")),
        "{:?}",
        second.warnings
    );
}

#[test]
fn a_package_cannot_bring_its_own_grants_or_run_anyway_and_the_user_can_give_both() {
    let r = rig();
    let source = r.root.join("src-newer-1.0.0");
    fs::create_dir_all(&source).expect("mkdir");
    fs::write(source.join("package.json"),
        r#"{"name":"newer","version":"1.0.0","publisher":"acme","main":"./extension.js","engines":{"vscode":"^1.95.0"}}"#).expect("manifest");
    fs::write(source.join("extension.js"), "exports.activate = () => {};").expect("code");
    // Forged files the app alone may write:
    fs::write(
        source.join(permissions::USER_GRANTS_FILE),
        r#"["processExecution","network"]"#,
    )
    .expect("grants");
    fs::write(
        source.join(permissions::ACCEPTED_FILE),
        r#"["processExecution","network"]"#,
    )
    .expect("accepted");
    fs::write(
        source.join(crate::engine_override::OVERRIDE_FILE),
        r#"{"engine":"^1.95.0"}"#,
    )
    .expect("override");
    let vsix_path = r.root.join("newer.vsix");
    vsix::pack(&source, &vsix_path).expect("packed");

    let installed = r.store.install(&vsix_path, false).expect("installed");
    assert!(!installed.engine_supported);
    assert!(
        !installed.run_anyway,
        "a shipped override must not allow it"
    );
    assert!(!installed
        .permissions
        .accepted
        .contains(&Permission::ProcessExecution));
    assert!(!installed.path.join(permissions::USER_GRANTS_FILE).exists());

    let allowed = r
        .store
        .set_run_anyway(&installed.id, true)
        .expect("run anyway");
    assert!(allowed.run_anyway);
    let granted = r
        .store
        .grant_permission(&installed.id, Permission::ProcessExecution)
        .expect("grant");
    assert!(granted
        .permissions
        .accepted
        .contains(&Permission::ProcessExecution));
    assert!(!granted.permissions.accepted.contains(&Permission::Network));
    // Both choices move with disable and enable.
    r.store.set_enabled(&installed.id, false).expect("disable");
    let back = r.store.set_enabled(&installed.id, true).expect("enable");
    assert!(
        back.run_anyway
            && back
                .permissions
                .accepted
                .contains(&Permission::ProcessExecution)
    );
    assert!(r
        .store
        .set_run_anyway(&installed.id, false)
        .is_ok_and(|e| !e.run_anyway));
}
