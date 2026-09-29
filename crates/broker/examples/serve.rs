//! Runs the package gateway with the real Download Manager client until the process is stopped, and prints the
//! process-local settings a terminal would get. A developer tool for checking real pip/npm/git/go runs by hand:
//! `cargo run -p openmind-broker --example serve -- <staging folder>`.

use std::sync::Arc;

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
                "event {} {:?} {} {}/{:?}",
                event.id, event.phase, event.artifact, event.bytes, event.total
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
    println!("PIP_INDEX_URL={}/pypi/simple/", gateway.base());
    println!(
        "NPM_CONFIG_REGISTRY=http://127.0.0.1:{}/",
        gateway.npm_port()
    );
    println!("BASE={}", gateway.base());
    println!("GOPROXY={}/go", gateway.base());
    println!("GIT_INSTEAD_OF={}/git/https/", gateway.base());
    println!(
        "CARGO_HTTP_PROXY=http://cargo:{}@127.0.0.1:{}",
        gateway.token(),
        gateway.port()
    );
    loop {
        std::thread::park();
    }
}
