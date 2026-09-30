//! Runs the package gateway with the real Download Manager client until the process is stopped, and writes the
//! process-local settings an OpenMind terminal would get (one `NAME=value` per line) to `<staging>/env.txt`. A developer
//! tool for checking real pip/npm/pnpm/yarn/git/go/cargo/rustup runs by hand:
//! `cargo run -p openmind-broker --example serve -- <staging folder>`.

use std::sync::Arc;

use openmind_broker::env::{npm_rc_text, process_env, Endpoints, Inherited};
use openmind_broker::gateway::UreqUpstream;
use openmind_broker::{Broker, BrokerEvent, Gateway, GatewayConfig, Staging};
use openmind_runtime_manager::UreqClient;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter("openmind_broker=debug")
        .init();
    let folder = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "gateway-staging".into());
    let staging = Staging::new(&folder);
    let report = staging.recover(
        openmind_broker::staging::now_secs(),
        openmind_broker::staging::PARTIAL_MAX_AGE,
    );
    println!("staging {folder}: {report:?}");
    let broker = Broker::new(
        staging,
        Arc::new(UreqClient::new()),
        Arc::new(|event: &BrokerEvent| {
            println!(
                "event {} {:?} {:?} {} {}/{:?}",
                event.id, event.provider, event.phase, event.artifact, event.bytes, event.total
            );
        }),
    );
    let gateway = match Gateway::start(
        Arc::new(broker),
        Arc::new(UreqUpstream),
        GatewayConfig::default(),
    ) {
        Ok(gateway) => gateway,
        Err(err) => {
            eprintln!("the gateway could not start: {err}");
            std::process::exit(1);
        }
    };
    let mut endpoints = Endpoints {
        port: gateway.port(),
        npm_port: gateway.npm_port(),
        token: gateway.token().to_string(),
        npm_rc: None,
    };
    let rc = std::path::Path::new(&folder).join("config").join("npmrc");
    let written = std::fs::create_dir_all(rc.parent().unwrap_or(std::path::Path::new(".")))
        .and_then(|()| std::fs::write(&rc, npm_rc_text(&endpoints)));
    if written.is_ok() {
        endpoints.npm_rc = Some(rc);
    }
    let env = process_env(&endpoints, &Inherited::current());
    let lines: String = env
        .vars
        .iter()
        .map(|(name, value)| format!("{name}={value}\n"))
        .collect();
    let file = std::path::Path::new(&folder).join("env.txt");
    if let Err(err) = std::fs::write(&file, lines) {
        eprintln!("env.txt not written: {err}");
    }
    println!("ENV_FILE={}", file.display());
    println!("BASE={}", gateway.base());
    for skipped in &env.skipped {
        println!("SKIPPED {}: {}", skipped.tool, skipped.reason);
    }
    loop {
        std::thread::park();
    }
}
