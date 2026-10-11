//! A two-computer check of local-network collaboration (Milestone 24, phase 5.2), with nothing on the Internet: no
//! signaling server, STUN or TURN is configured on either side, so a session can only ever be `localLan`.
//!
//! ```text
//! PC A:  lan_check host "C:\some\folder"      prints the Room Code once (on screen only) and the local addresses
//! PC B:  lan_check join OM-XXXX-...          finds PC A by mDNS/broadcast and joins
//!        lan_check join OM-XXXX-... --addr 192.168.1.25:47732     (when discovery is blocked)
//! either: lan_check interfaces                which addresses local rooms would use
//! ```
//!
//! It runs the real stack (`LanHost`, discovery, the embedded rendezvous, `str0m`, the Room Code handshake, the
//! manifest, chunked verified transfers, live tree deltas from the real file watcher). The room itself is in memory —
//! the app's database, audit chain and windows are not part of this check; the app's own tests cover those. Nothing
//! printed contains the Room Code except the one line that shows it to the person hosting.

mod owner;
mod session;

fn usage() -> ! {
    eprintln!("usage: lan_check host <folder> | join <ROOM-CODE> [--addr <ip:port>] | interfaces");
    std::process::exit(2);
}

pub fn interfaces() {
    let chosen = openmind_collab_net::lan::netif::current();
    if chosen.is_empty() {
        println!("[lan-check] no usable network interface (only loopback, host-only virtual switches or down adapters)");
    }
    for interface in chosen {
        let kind = match interface.rank {
            0 => "LAN with a router",
            1 => "LAN without a router",
            2 => "VPN / other",
            _ => "link-local only",
        };
        println!(
            "[lan-check] interface {}: {kind}: {:?}",
            interface.index,
            interface.addresses()
        );
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("[lan-check] {err}");
            std::process::exit(1);
        }
    };
    let result = match args.first().map(String::as_str) {
        Some("interfaces") => {
            interfaces();
            Ok(())
        }
        Some("host") => match args.get(1) {
            Some(folder) => runtime.block_on(session::host(std::path::Path::new(folder))),
            None => usage(),
        },
        Some("join") => {
            let Some(code) = args.get(1) else { usage() };
            let addr = args
                .iter()
                .position(|a| a == "--addr")
                .and_then(|i| args.get(i + 1))
                .cloned();
            runtime.block_on(session::join(code, addr.as_deref()))
        }
        _ => usage(),
    };
    if let Err(err) = result {
        eprintln!("[lan-check] FAILED: {err}");
        std::process::exit(1);
    }
}
