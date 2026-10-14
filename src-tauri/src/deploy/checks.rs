//! The **Network Deployment Test**: twenty checks, each `pass`, `fail` or `blocked` (it couldn't be checked, with the
//! reason), covering this computer (identity, program, data, database, runtimes), the network (interfaces, the discovery
//! socket), discovery (what answered, protocol, platform, architecture, version) and provisioning (packages, their
//! integrity, readiness, the shortcut, runtime reuse).
//!
//! It only reads, except two things done to learn the truth and undone at once: it opens (and closes) UDP sockets, and
//! — when asked — downloads the chosen package into this computer's temporary folder, verifies it and deletes it.
//! Nothing secret is shown: the machine identity is a hash, the database is a path.

use openmind_deploy::advert::DeploymentKind;
use openmind_deploy::discover::{local_ipv4_networks, Options, Outcome};
use openmind_deploy::package::Verifier;
use openmind_deploy::PROTOCOL;
use serde::Serialize;

use super::local::{scan_runtimes, RuntimeStore, ThisCopy};
use super::service::{incompatibility, DeployService, DeploymentView, SearchView};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Pass,
    Fail,
    /// It couldn't be checked: something it depends on is missing or refused (the reason says what).
    Blocked,
    /// Not checked in this run (not applicable here, or not asked for): neither a pass nor a failure.
    #[serde(rename = "notTested")]
    NotTested,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub id: &'static str,
    pub status: Status,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestReport {
    pub checks: Vec<Check>,
    pub passed: usize,
    pub failed: usize,
    pub blocked: usize,
    pub not_tested: usize,
    pub search: SearchView,
    /// The deployment the provisioning checks looked at.
    pub deployment: Option<String>,
}

fn check(id: &'static str, status: Status, detail: impl Into<String>) -> Check {
    Check {
        id,
        status,
        detail: detail.into(),
    }
}

fn pass(id: &'static str, detail: impl Into<String>) -> Check {
    check(id, Status::Pass, detail)
}

fn fail(id: &'static str, detail: impl Into<String>) -> Check {
    check(id, Status::Fail, detail)
}

fn not_tested(id: &'static str, detail: impl Into<String>) -> Check {
    check(id, Status::NotTested, detail)
}

fn blocked(id: &'static str, detail: impl Into<String>) -> Check {
    check(id, Status::Blocked, detail)
}

/// Runs the whole test (blocking: the search takes a few seconds; a package download as long as it takes).
pub fn run(
    copy: &ThisCopy,
    service: &DeployService,
    options: &Options,
    download_package: bool,
    verifier: Verifier,
) -> TestReport {
    let mut checks = this_computer(copy);
    checks.extend(network(options.port));
    let (search, deployments) = service.search(options, copy);
    checks.extend(discovery(&search, &deployments));
    let chosen = choose(copy, &deployments);
    checks.extend(compatibility(copy, chosen));
    checks.extend(provisioning(
        copy,
        service,
        chosen,
        download_package,
        verifier,
    ));
    let count = |status| checks.iter().filter(|c| c.status == status).count();
    TestReport {
        passed: count(Status::Pass),
        failed: count(Status::Fail),
        blocked: count(Status::Blocked),
        not_tested: count(Status::NotTested),
        deployment: chosen.map(|d| d.id.clone()),
        checks,
        search,
    }
}

/// The deployment the provisioning checks use: one this computer can use, preferring a shared installation.
fn choose<'a>(copy: &ThisCopy, deployments: &'a [DeploymentView]) -> Option<&'a DeploymentView> {
    deployments
        .iter()
        .filter(|d| d.incompatible.is_none())
        .max_by_key(|d| {
            (
                d.manifest.kind == DeploymentKind::NetworkShare,
                d.sources.len(),
            )
        })
        .or_else(|| deployments.first())
        .filter(|_| !copy.version.is_empty())
}

fn this_computer(copy: &ThisCopy) -> Vec<Check> {
    let mut checks = Vec::new();
    checks.push(if copy.profile_id.is_empty() {
        fail("machineIdentity", "this computer has no identity")
    } else {
        pass(
            "machineIdentity",
            format!(
                "{} ({}, user {}) — profile {}",
                copy.hostname,
                copy.os_arch.label(),
                copy.user,
                copy.profile_id
            ),
        )
    });
    checks.push(if copy.exe.is_file() {
        pass(
            "installation",
            format!(
                "OpenMind Studio {} ({}), layout {}",
                copy.version,
                copy.build_arch.label(),
                copy.layout.label()
            ),
        )
    } else {
        fail("installation", format!("{} is missing", copy.exe.display()))
    });
    checks.push(pass("executablePath", {
        let mut text = copy.exe.display().to_string();
        if copy.universal_dir != copy.install_dir {
            text.push_str(&format!(" (network path {})", copy.universal_dir.display()));
        }
        text
    }));
    checks.push(if copy.install_dir.is_dir() {
        pass(
            "installDestination",
            format!(
                "{} ({}) — the folder the program was installed into, used as it is",
                copy.install_dir.display(),
                if copy.on_network {
                    "on a network share"
                } else {
                    "on this computer"
                }
            ),
        )
    } else {
        fail(
            "installDestination",
            format!("{} can't be read", copy.install_dir.display()),
        )
    });
    checks.push(local_data(copy));
    checks.push(database(copy));
    checks.push(runtime_store(copy));
    checks
}

fn local_data(copy: &ThisCopy) -> Check {
    let remote = openmind_core::install::is_remote_path(&copy.data_root);
    if remote && copy.layout.local_state() {
        return fail(
            "localData",
            format!(
                "{} is on a network drive: this computer's data must be on its own disk (is %LOCALAPPDATA% redirected?)",
                copy.data_root.display()
            ),
        );
    }
    pass(
        "localData",
        format!(
            "{} (logs {}, temporary files {})",
            copy.data_root.display(),
            copy.logs_dir.display(),
            copy.temp_dir.display()
        ),
    )
}

fn database(copy: &ThisCopy) -> Check {
    let shared_program = copy.layout == openmind_core::InstallLayout::Network;
    if shared_program && copy.db_path.starts_with(&copy.install_dir) {
        return fail(
            "databaseIsolation",
            format!(
                "{} is inside the shared installation",
                copy.db_path.display()
            ),
        );
    }
    if openmind_core::install::is_remote_path(&copy.db_path)
        && copy.data_scope != openmind_core::DataScope::PerMachine
    {
        return fail(
            "databaseIsolation",
            format!(
                "{} is on a network drive: SQLite must not be shared between computers",
                copy.db_path.display()
            ),
        );
    }
    let state = if copy.db_path.is_file() {
        "exists"
    } else {
        "created at the first start"
    };
    pass(
        "databaseIsolation",
        format!(
            "this computer's own database: {} ({state}); profile {}",
            copy.db_path.display(),
            copy.profile_id
        ),
    )
}

fn runtime_store(copy: &ThisCopy) -> Check {
    if !copy.runtimes_dir.is_dir() {
        return not_tested(
            "runtimeStore",
            format!(
                "{} doesn't exist yet (no runtime installed)",
                copy.runtimes_dir.display()
            ),
        );
    }
    let ready = scan_runtimes(&copy.runtimes_dir).len();
    let kind = match copy.runtime_store {
        RuntimeStore::Shared => "shared with other computers: each runtime is installed once",
        RuntimeStore::Local => "this computer's own",
    };
    pass(
        "runtimeStore",
        format!("{} — {kind}; {ready} ready", copy.runtimes_dir.display()),
    )
}

fn network(port: u16) -> Vec<Check> {
    let networks = local_ipv4_networks();
    let interfaces = if networks.is_empty() {
        fail("networkInterface", "no IPv4 network is up on this computer")
    } else {
        pass(
            "networkInterface",
            networks
                .iter()
                .map(|(ip, prefix)| format!("{ip}/{prefix}"))
                .collect::<Vec<_>>()
                .join(", "),
        )
    };
    let any = std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED);
    let socket = match openmind_deploy::responder::shared_socket(any, port) {
        Ok(socket) => pass(
            "discoverySocket",
            format!("UDP {} can be opened (with broadcast)", socket.local_addr().map(|a| a.to_string()).unwrap_or_default()),
        ),
        Err(err) => match std::net::UdpSocket::bind((std::net::Ipv4Addr::UNSPECIFIED, 0)) {
            Ok(_) => blocked(
                "discoverySocket",
                format!("UDP port {port} can't be opened ({err}): this computer can search but can't answer; another program or a policy holds it"),
            ),
            Err(other) => fail("discoverySocket", format!("no UDP socket can be opened: {other}")),
        },
    };
    vec![interfaces, socket]
}

fn discovery(search: &SearchView, deployments: &[DeploymentView]) -> Vec<Check> {
    let found = match search.outcome {
        Outcome::Found => pass(
            "deploymentDiscovery",
            format!("{} deployment(s) answered in {} ms ({} queries sent)", deployments.len(), search.elapsed_ms, search.sent),
        ),
        Outcome::NothingFound => fail(
            "deploymentDiscovery",
            format!(
                "NO DEPLOYMENT FOUND: {} queries went out, nothing answered. Check that a computer offers OpenMind Studio \
                 (setting \"Offer This Installation on the Local Network\") and that the network allows UDP {} between \
                 computers (a firewall that drops it looks the same as silence).",
                search.sent,
                openmind_deploy::DISCOVERY_PORT
            ),
        ),
        Outcome::ProtocolIncompatible => fail(
            "deploymentDiscovery",
            format!("PROTOCOL INCOMPATIBLE: only other versions answered: {}", search.incompatible.join("; ")),
        ),
        Outcome::NetworkBlocked => blocked(
            "deploymentDiscovery",
            format!("NETWORK/BIND BLOCKED: no query could be sent ({})", search.send_errors.join("; ")),
        ),
        Outcome::DiscoveryUnavailable => blocked(
            "deploymentDiscovery",
            format!("DISCOVERY UNAVAILABLE: {}", search.socket_error.clone().unwrap_or_default()),
        ),
    };
    let source = deployments
        .iter()
        .find_map(|d| d.sources.first().map(|s| (d, s)))
        .map_or_else(
            || blocked("discoveredSource", "no source answered"),
            |(d, s)| {
                pass(
                    "discoveredSource",
                    format!(
                        "{} at {} (OpenMind Studio {})",
                        d.id, s.address, s.app_version
                    ),
                )
            },
        );
    let protocol = if !search.incompatible.is_empty() && deployments.is_empty() {
        fail("protocolCompatibility", search.incompatible.join("; "))
    } else if deployments.is_empty() {
        blocked("protocolCompatibility", "nothing answered")
    } else {
        pass(
            "protocolCompatibility",
            format!("deployment protocol {PROTOCOL}"),
        )
    };
    vec![found, source, protocol]
}

fn compatibility(copy: &ThisCopy, chosen: Option<&DeploymentView>) -> Vec<Check> {
    let Some(deployment) = chosen else {
        return [
            "platformCompatibility",
            "architectureCompatibility",
            "versionCompatibility",
        ]
        .into_iter()
        .map(|id| blocked(id, "no deployment to check"))
        .collect();
    };
    let manifest = &deployment.manifest;
    let platform = if manifest.platform == openmind_deploy::this_platform() {
        pass("platformCompatibility", manifest.platform.clone())
    } else {
        fail(
            "platformCompatibility",
            format!("it is for {}", manifest.platform),
        )
    };
    let arch = match incompatibility(manifest, copy) {
        None => pass(
            "architectureCompatibility",
            format!(
                "{} program on {} Windows",
                manifest.arch.label(),
                copy.os_arch.label()
            ),
        ),
        Some(reason) => fail("architectureCompatibility", reason),
    };
    let order = openmind_deploy::version::compare(&manifest.app_version, &copy.version);
    let version = match order {
        std::cmp::Ordering::Equal => pass(
            "versionCompatibility",
            format!("{} — the same as this copy", manifest.app_version),
        ),
        std::cmp::Ordering::Greater => pass(
            "versionCompatibility",
            format!(
                "{} — newer than this copy ({})",
                manifest.app_version, copy.version
            ),
        ),
        std::cmp::Ordering::Less if manifest.kind == DeploymentKind::NetworkShare => pass(
            "versionCompatibility",
            format!(
                "{} — older than this copy ({}); a shared installation is used as it is",
                manifest.app_version, copy.version
            ),
        ),
        std::cmp::Ordering::Less => fail(
            "versionCompatibility",
            format!(
                "{} is older than this copy ({}): provisioning it here would be a downgrade",
                manifest.app_version, copy.version
            ),
        ),
    };
    vec![platform, arch, version]
}

#[path = "checks_provisioning.rs"]
mod provisioning_checks;
use provisioning_checks::provisioning;
