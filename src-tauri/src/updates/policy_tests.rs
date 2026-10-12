use super::*;

fn v(text: &str) -> Version {
    Version::parse(text).expect("version")
}

#[test]
fn only_a_newer_stable_version_is_installed() {
    let current = v("1.0.2");
    assert!(
        !is_installable_upgrade(&current, &v("1.0.2")),
        "no update available"
    );
    assert!(
        is_installable_upgrade(&current, &v("1.1.0")),
        "a new stable release"
    );
    assert!(
        !is_installable_upgrade(&current, &v("1.1.0-beta.1")),
        "a pre-release is ignored"
    );
    assert!(
        !is_installable_upgrade(&current, &v("1.0.1")),
        "never a downgrade"
    );
    assert!(
        is_installable_upgrade(&v("1.1.0-beta.1"), &v("1.1.0")),
        "a pre-release build moves on to stable"
    );
}

#[test]
fn a_release_can_require_an_update_only_through_its_minimum_version() {
    let raw = serde_json::json!({
        "version": "1.2.0",
        "platforms": {},
        "openmind": { "minimumVersion": "1.1.0", "channel": "stable" }
    });
    let extras = feed_extras(&raw);
    assert_eq!(extras.minimum_version, Some(v("1.1.0")));
    assert_eq!(extras.channel.as_deref(), Some("stable"));
    assert!(is_mandatory(&v("1.0.2"), &extras));
    assert!(!is_mandatory(&v("1.1.0"), &extras));
    // A newer version alone is never an emergency.
    let plain = feed_extras(&serde_json::json!({ "version": "9.0.0", "platforms": {} }));
    assert!(!is_mandatory(&v("1.0.2"), &plain));
    // A damaged minimum is ignored, not treated as mandatory.
    let broken = feed_extras(&serde_json::json!({ "openmind": { "minimumVersion": "soon" } }));
    assert!(!is_mandatory(&v("1.0.2"), &broken));
}

#[test]
fn each_installation_updates_the_way_it_was_installed() {
    assert_eq!(
        self_update(InstallKind::Nsis, InstallLayout::PerUser),
        SelfUpdate::Installer
    );
    assert_eq!(
        self_update(InstallKind::Msi, InstallLayout::PerMachine),
        SelfUpdate::Installer
    );
    assert_eq!(
        self_update(InstallKind::Portable, InstallLayout::Portable),
        SelfUpdate::Portable
    );
    // A shared network installation is never changed from one of its computers, however it was installed.
    for kind in [InstallKind::Nsis, InstallKind::Msi, InstallKind::Portable] {
        assert!(matches!(
            self_update(kind, InstallLayout::Network),
            SelfUpdate::Managed(_)
        ));
    }
}

#[test]
fn failed_checks_are_retried_with_a_growing_pause_of_at_most_an_hour() {
    assert_eq!(backoff(1), Duration::from_secs(60));
    assert_eq!(backoff(2), Duration::from_secs(120));
    assert_eq!(backoff(3), Duration::from_secs(240));
    assert_eq!(backoff(7), Duration::from_secs(3600));
    assert_eq!(backoff(40), Duration::from_secs(3600));
    assert!(FIRST_CHECK_DELAY < CHECK_INTERVAL);
}

#[test]
fn failures_are_told_apart() {
    assert_eq!(
        classify("error sending request: dns error: No such host is known"),
        Failure::Network
    );
    assert_eq!(classify("operation timed out"), Failure::Network);
    assert_eq!(
        classify("update endpoint did not respond with a successful status code (404)"),
        Failure::Feed
    );
    assert_eq!(
        classify("the platform `windows-i686` was not found on the response `platforms` object"),
        Failure::Feed
    );
    assert_eq!(
        classify("minisign: signature verification failed"),
        Failure::Signature
    );
    assert_eq!(classify("Access is denied. (os error 5)"), Failure::Install);
}

#[test]
fn restart_to_update_never_discards_work_and_asks_before_stopping_programs() {
    use super::super::{flow::install_blocker, Activity};
    let idle = Activity {
        unsaved: 0,
        terminals: 2,
        busy_terminals: 0,
        runs: 0,
    };
    assert_eq!(
        install_blocker(idle, false),
        None,
        "idle terminals are just closed, as on a normal close"
    );
    let unsaved = Activity { unsaved: 3, ..idle };
    let reason = install_blocker(unsaved, true).expect("unsaved editors block even when confirmed");
    assert!(reason.contains("3 editor"), "{reason}");
    let building = Activity {
        busy_terminals: 1,
        runs: 1,
        ..idle
    };
    assert!(install_blocker(building, false)
        .expect("asks")
        .contains("confirm"));
    assert_eq!(install_blocker(building, true), None);
}
