use super::*;

use openmind_runner::RunInfo;

fn info(port: u16, ready: bool) -> ServiceInfo {
    ServiceInfo {
        run: RunInfo {
            run_id: "r".into(),
            file: "f".into(),
            pid: 42,
        },
        port,
        url: None,
        ready,
        version: None,
        php_version: None,
    }
}

#[test]
fn running_needs_a_ready_database_and_phpmyadmin() {
    let db = info(3306, true);
    let pma = info(8081, true);
    assert_eq!(
        derive_state(Phase::Idle, false, Some(&db), Some(&pma), None),
        ("running", None)
    );
    // A spawned but not yet answering MariaDB is not Running.
    let spawned = info(3306, false);
    assert_eq!(
        derive_state(Phase::Idle, false, Some(&spawned), Some(&pma), None).0,
        "starting"
    );
}

#[test]
fn half_a_stack_is_an_error_with_the_reason() {
    let db = info(3306, true);
    let pma = info(8081, true);
    let (word, error) = derive_state(Phase::Idle, false, Some(&db), None, None);
    assert_eq!(word, "error");
    assert!(error
        .as_deref()
        .is_some_and(|e| e.contains("MariaDB is running, but phpMyAdmin isn't")));
    let (word, error) = derive_state(
        Phase::Idle,
        false,
        Some(&db),
        None,
        Some("MariaDB is running, but phpMyAdmin could not start: port in use"),
    );
    assert_eq!(word, "error");
    assert!(error
        .as_deref()
        .is_some_and(|e| e.contains("could not start")));
    // MariaDB ended on its own while phpMyAdmin kept running.
    let (word, error) = derive_state(Phase::Idle, false, None, Some(&pma), None);
    assert_eq!(word, "error");
    assert!(error
        .as_deref()
        .is_some_and(|e| e.contains("MariaDB isn't")));
}

#[test]
fn stopped_not_installed_failed_and_busy_states() {
    assert_eq!(
        derive_state(Phase::Idle, false, None, None, None),
        ("stopped", None)
    );
    assert_eq!(
        derive_state(Phase::Idle, true, None, None, None),
        ("notInstalled", None)
    );
    assert_eq!(
        derive_state(
            Phase::Idle,
            false,
            None,
            None,
            Some("Initializing the database failed")
        ),
        (
            "error",
            Some("Initializing the database failed".to_string())
        )
    );
    for (phase, word) in [
        (Phase::Initializing, "initializing"),
        (Phase::Starting, "starting"),
        (Phase::Stopping, "stopping"),
    ] {
        assert_eq!(derive_state(phase, false, None, None, None).0, word);
    }
}

#[test]
fn a_chosen_port_must_be_free_and_defaults_fall_back_in_order() {
    let free = |port: u16| port != 3306;
    // Nothing chosen: 3306 is taken (another MySQL), so the earlier default 3307.
    assert_eq!(
        choose_port(None, &[3306, 3307], &[], free, "MariaDB"),
        Ok(3307)
    );
    assert_eq!(
        choose_port(None, &[3306, 3307], &[], |_| true, "MariaDB"),
        Ok(3306)
    );
    // The port used last comes first.
    assert_eq!(
        choose_port(None, &[3310, 3306, 3307], &[], |_| true, "MariaDB"),
        Ok(3310)
    );
    // A port the user chose is used or refused, never silently swapped.
    assert_eq!(
        choose_port(Some(3400), &[3306], &[], |_| true, "MariaDB"),
        Ok(3400)
    );
    let busy = choose_port(Some(3306), &[3307], &[], free, "MariaDB").expect_err("busy");
    assert!(
        busy.contains("Port 3306") && busy.contains("already in use"),
        "{busy}"
    );
    // Both parts of the stack never share a port.
    assert_eq!(
        choose_port(None, &[8081, 8082], &[8081], |_| true, "phpMyAdmin"),
        Ok(8082)
    );
    assert!(choose_port(Some(3306), &[], &[3306], |_| true, "phpMyAdmin").is_err());
    let none = choose_port(None, &[8081, 8082], &[], |_| false, "phpMyAdmin").expect_err("none");
    assert!(none.contains("8081, 8082"), "{none}");
}

#[test]
fn the_port_of_the_last_start_is_read_from_my_ini() {
    let tmp = tempfile::tempdir().expect("tmp");
    let paths = MariaDbPaths::new(tmp.path());
    assert_eq!(last_used_port(&paths), None);
    std::fs::create_dir_all(&paths.config_dir).expect("dir");
    std::fs::write(
        &paths.config_file,
        "[mysqld]\r\nbasedir=\"x\"\r\nport=3307\r\nbind-address=127.0.0.1\r\n",
    )
    .expect("ini");
    assert_eq!(last_used_port(&paths), Some(3307));
}

#[test]
fn phpmyadmin_pages_that_show_a_database_problem_are_recognised() {
    assert!(pma_page_problem("<title>phpMyAdmin</title> Server: 127.0.0.1").is_none());
    assert!(pma_page_problem("#1045 - Cannot log in to the MySQL server").is_some());
    assert!(pma_page_problem("mysqli::real_connect(): (HY000/2002)").is_some());
    assert!(pma_page_problem("Access denied for user 'root'@'localhost'").is_some());
    assert_eq!(
        pma_page_problem("The mysqli extension is missing. Please check your PHP configuration."),
        Some("the active PHP lacks the mysqli extension phpMyAdmin needs")
    );
}

#[test]
fn log_tails_skip_blank_lines() {
    let tmp = tempfile::tempdir().expect("tmp");
    let log = tmp.path().join("m.log");
    std::fs::write(&log, "a\n\nb\nc\n").expect("log");
    assert_eq!(log_tail(&log, 2), "b | c");
    assert_eq!(log_tail(&tmp.path().join("none.log"), 3), "");
}
