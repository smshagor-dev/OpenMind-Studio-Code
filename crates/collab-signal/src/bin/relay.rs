//! `openmind-collab-signal [--listen 127.0.0.1:8787] [--ttl-secs 600]`: runs the signaling relay until Ctrl+C.
//! It serves plain `ws://`; expose it as `wss://` through a TLS-terminating reverse proxy. If its accepting task ever
//! ends without being asked to (a panic), the process exits with status 1 instead of staying alive and deaf.

use std::net::SocketAddr;
use std::time::Duration;

use openmind_collab_signal::{Relay, RelayConfig};

fn arguments() -> Result<(SocketAddr, RelayConfig), String> {
    let mut listen: SocketAddr = "127.0.0.1:8787"
        .parse()
        .map_err(|_| "bad default address".to_string())?;
    let mut config = RelayConfig::default();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let value = args.next().ok_or_else(|| format!("{arg} needs a value"))?;
        match arg.as_str() {
            "--listen" => {
                listen = value
                    .parse()
                    .map_err(|_| format!("not an address: {value}"))?
            }
            "--ttl-secs" => {
                let secs: u64 = value
                    .parse()
                    .map_err(|_| format!("not a number: {value}"))?;
                config.topic_ttl = Duration::from_secs(secs.clamp(10, 86_400));
            }
            other => return Err(format!("unknown option {other}")),
        }
    }
    Ok((listen, config))
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let (listen, config) = match arguments() {
        Ok(parsed) => parsed,
        Err(problem) => {
            eprintln!("{problem}\nusage: openmind-collab-signal [--listen 127.0.0.1:8787] [--ttl-secs 600]");
            std::process::exit(2);
        }
    };
    let relay = match Relay::start(listen, config).await {
        Ok(relay) => relay,
        Err(err) => {
            eprintln!("can't listen on {listen}: {err}");
            std::process::exit(1);
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => relay.stop().await,
        () = relay.ended() => {
            // Never stay alive without listening: a supervisor (or the person who started it) sees the exit.
            eprintln!("the relay stopped accepting connections unexpectedly; exiting");
            std::process::exit(1);
        }
    }
}
