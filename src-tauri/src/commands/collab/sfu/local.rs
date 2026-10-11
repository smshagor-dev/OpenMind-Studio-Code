//! A classroom media server on this computer (phase 11): the LiveKit server the Runtime Manager installed (runtime
//! `livekit`, downloaded only on request, checksum-verified — never part of the installer), run as this app's child
//! for an offline classroom LAN. No Internet, Redis, service or administrator rights involved.
//!
//! - **Credentials**: a fresh API key and secret per run, generated here, handed to the server only in its own
//!   environment (`LIVEKIT_KEYS`; never on its command line, in its config file or in a log) and kept in memory.
//! - **Exposure**: HTTP/WebSocket and the UDP media port bind to the one address chosen (the LAN interface members
//!   reach, or loopback); the TCP media fallback is off, because LiveKit would listen for it on every interface.
//! - **Life**: in a Job Object, so closing the app (or a crash) ends it; stopped explicitly on Stop and app shutdown.

use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use openmind_collab::sfu::ApiKey;
use serde::Serialize;

/// The WebSocket/API port, and the single UDP port all media goes through.
pub const HTTP_PORT: u16 = 7880;
pub const UDP_PORT: u16 = 7882;
/// The program inside the runtime's folder.
pub const PROGRAM: &str = "livekit-server.exe";
const START_LIMIT: Duration = Duration::from_secs(15);

/// A running local media server.
pub struct LocalSfu {
    child: Child,
    #[cfg(windows)]
    _tree: Option<openmind_process::ProcessTree>,
    pub bind: IpAddr,
    pub api: ApiKey,
    /// The configuration written for this run (no credentials; removed when the server stops).
    config: PathBuf,
}

/// What the Owner's UI shows about it (no key or secret).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatus {
    pub running: bool,
    pub bind: Option<String>,
    /// The address members connect to.
    pub url: Option<String>,
    pub http_port: u16,
    pub udp_port: u16,
}

fn random_text(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf)
        .map_err(|_| "no randomness for the media server's credentials".to_string())?;
    Ok(hex::encode(buf))
}

/// The server's configuration (no credentials: those go in its environment).
pub fn config_yaml(bind: IpAddr) -> String {
    format!(
        "port: {HTTP_PORT}\n\
         bind_addresses:\n  - {bind}\n\
         rtc:\n  udp_port: {UDP_PORT}\n  tcp_port: 0\n  use_external_ip: false\n  node_ip: {bind}\n  \
         ips:\n    includes:\n      - {bind}/32\n\
         room:\n  empty_timeout: 300\n  max_participants: {max}\n\
         logging:\n  level: warn\n",
        max = openmind_collab::voice::MAX_SFU_VOICE_MEMBERS,
    )
}

impl LocalSfu {
    pub fn url(&self) -> String {
        format!("ws://{}", SocketAddr::new(self.bind, HTTP_PORT))
    }

    pub fn status(&self) -> LocalStatus {
        LocalStatus {
            running: true,
            bind: Some(self.bind.to_string()),
            url: Some(self.url()),
            http_port: HTTP_PORT,
            udp_port: UDP_PORT,
        }
    }

    /// Starts the server from `runtime_dir` on `bind`; returns once it accepts connections.
    pub fn start(
        runtime_dir: &Path,
        work_dir: &Path,
        log: &Path,
        bind: IpAddr,
    ) -> Result<Self, String> {
        let program = runtime_dir.join(PROGRAM);
        if !program.is_file() {
            return Err(
                "The classroom voice server isn't installed. Install it from the Runtime Manager."
                    .into(),
            );
        }
        ports_free(bind)?;
        std::fs::create_dir_all(work_dir).map_err(|e| e.to_string())?;
        let config = work_dir.join("classroom-voice.yaml");
        std::fs::write(&config, config_yaml(bind)).map_err(|e| e.to_string())?;
        let api = ApiKey {
            key: format!("OM{}", random_text(8)?),
            secret: random_text(32)?,
        };
        let log_file = std::fs::File::create(log).map_err(|e| e.to_string())?;
        let mut command = Command::new(&program);
        command
            .arg("--config")
            .arg(&config)
            .env("LIVEKIT_KEYS", format!("{}: {}", api.key, api.secret))
            .current_dir(work_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::from(
                log_file.try_clone().map_err(|e| e.to_string())?,
            ))
            .stderr(Stdio::from(log_file));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let child = command
            .spawn()
            .map_err(|e| {
                format!(
                    "The classroom voice server couldn't start ({e}). Its program may be damaged: repair it \
                     in the Runtime Manager."
                )
            })?;
        #[cfg(windows)]
        let tree = {
            use std::os::windows::io::AsRawHandle;
            let tree = openmind_process::ProcessTree::new().ok();
            if let Some(tree) = &tree {
                let _ = tree.assign(child.as_raw_handle());
            }
            tree
        };
        let mut server = Self {
            child,
            #[cfg(windows)]
            _tree: tree,
            bind,
            api,
            config,
        };
        server.wait_ready()?;
        Ok(server)
    }

    fn wait_ready(&mut self) -> Result<(), String> {
        let started = Instant::now();
        while started.elapsed() < START_LIMIT {
            if let Ok(Some(status)) = self.child.try_wait() {
                return Err(format!(
                    "The classroom voice server stopped at once ({status}); see its log."
                ));
            }
            let addr = SocketAddr::new(self.bind, HTTP_PORT);
            if TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        self.stop();
        Err("The classroom voice server didn't start in time; see its log.".into())
    }

    /// Ends the server (and anything it started).
    pub fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        #[cfg(windows)]
        if let Some(tree) = &self._tree {
            tree.terminate();
        }
        let _ = std::fs::remove_file(&self.config);
        if let Some(folder) = self.config.parent() {
            let _ = std::fs::remove_dir(folder); // only when empty
        }
    }
}

impl Drop for LocalSfu {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Both fixed ports are free on `bind`, checked before anything is started: something already answering on the TCP
/// port, or either port that can't be taken (another program holds it, on this address or on all of them). The message
/// names the port; nothing else (the room, code collaboration) is affected.
pub fn ports_free(bind: IpAddr) -> Result<(), String> {
    let busy = |port: u16, proto: &str| {
        format!(
            "{proto} port {port} on {bind} is already in use by another program, so the classroom voice server can't \
             start. Close that program (or choose another address); code collaboration isn't affected."
        )
    };
    let http = SocketAddr::new(bind, HTTP_PORT);
    if TcpStream::connect_timeout(&http, Duration::from_millis(300)).is_ok() {
        return Err(busy(HTTP_PORT, "TCP"));
    }
    // On the chosen address, and on all addresses too: Windows lets a program bind one address while another holds the
    // same port on 0.0.0.0, and then the two would split the traffic.
    let any: IpAddr = if bind.is_ipv4() {
        IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED)
    } else {
        IpAddr::V6(std::net::Ipv6Addr::UNSPECIFIED)
    };
    for ip in [bind, any] {
        drop(
            TcpListener::bind(SocketAddr::new(ip, HTTP_PORT))
                .map_err(|_| busy(HTTP_PORT, "TCP"))?,
        );
        drop(UdpSocket::bind(SocketAddr::new(ip, UDP_PORT)).map_err(|_| busy(UDP_PORT, "UDP"))?);
    }
    Ok(())
}

/// The server's log file and working folder.
pub fn locations(paths: &openmind_core::AppPaths) -> (PathBuf, PathBuf) {
    (
        paths.temp_dir.join("classroom-voice"),
        paths.logs_dir.join("classroom-voice.log"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_configuration_binds_one_address_has_no_tcp_fallback_and_no_credentials() {
        let yaml = config_yaml("192.168.1.20".parse().expect("ip"));
        assert!(yaml.contains("bind_addresses:\n  - 192.168.1.20"));
        assert!(yaml.contains("node_ip: 192.168.1.20") && yaml.contains("- 192.168.1.20/32"));
        assert!(yaml.contains("tcp_port: 0") && yaml.contains("udp_port: 7882"));
        assert!(!yaml.to_lowercase().contains("key") && !yaml.contains("secret"));
        assert!(!yaml.contains("redis"));
    }

    #[test]
    fn a_busy_tcp_or_udp_port_is_reported_before_anything_starts() {
        let ip: IpAddr = "127.0.0.1".parse().expect("ip");
        // Each port held by "another program" (sockets this test holds; skipped when the port is genuinely taken).
        if let Ok(udp) = UdpSocket::bind(SocketAddr::new(ip, UDP_PORT)) {
            let err = ports_free(ip).expect_err("UDP busy");
            assert!(
                err.contains("UDP port 7882") && err.contains("code collaboration isn't affected")
            );
            drop(udp);
        }
        if let Ok(tcp) = TcpListener::bind(SocketAddr::new(ip, HTTP_PORT)) {
            let err = ports_free(ip).expect_err("TCP busy");
            assert!(err.contains("TCP port 7880"));
            drop(tcp);
        }
        // Held on all addresses by another program: still refused for one specific address.
        let any: IpAddr = "0.0.0.0".parse().expect("any");
        if let Ok(udp) = UdpSocket::bind(SocketAddr::new(any, UDP_PORT)) {
            assert!(ports_free(ip)
                .expect_err("UDP busy on 0.0.0.0")
                .contains("UDP port 7882"));
            drop(udp);
        }
    }

    #[test]
    fn a_missing_program_is_explained_and_nothing_is_started() {
        let dir = tempfile::tempdir().expect("dir");
        let err = LocalSfu::start(
            dir.path(),
            dir.path(),
            &dir.path().join("log"),
            "127.0.0.1".parse().expect("ip"),
        )
        .err()
        .expect("refused");
        assert!(err.contains("Runtime Manager"));
    }
}
