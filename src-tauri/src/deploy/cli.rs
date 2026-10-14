//! `OpenMindStudio.exe --deploy <action>`: deployment on the local network from a console (an IT administrator, a
//! logon script, the university test procedure). Handled before anything else starts — no window, no database.
//!
//! - `status` — this copy: program, layout, this computer's data and database, runtime store;
//! - `discover [--target <address>]... [--json]` — search the LAN (and the given addresses) and list what answered;
//! - `test [--target <address>]... [--no-download] [--json]` — the Network Deployment Test (exit code 1 when a check
//!   fails);
//! - `serve [--packages <folder>]` — offer this installation (and the signed packages in the folder) until the console
//!   is closed or Ctrl+C;
//! - `provision <deployment id | first> [--kind share|setup|portable] [--to <folder>] [--target <address>]...
//!   [--no-shortcut] [--trust]` — provision this computer from a deployment found on the network (`--no-shortcut`:
//!   leave this user's Desktop alone, e.g. when a script or Group Policy places shortcuts). A deployment this computer's
//!   user hasn't trusted is refused unless `--trust` is given, which records that trust (with `first`, only when exactly
//!   one compatible deployment answered);
//! - `untrust <deployment id>` — withdraw that trust.
//!
//! Exit codes: 0 done, 1 failed, 2 usage.

use std::net::{SocketAddr, ToSocketAddrs};
use std::path::PathBuf;

use openmind_deploy::advert::{DeploymentKind, PackageKind};
use openmind_deploy::discover::Options;

use super::exec::{self, Request};
use super::local::ThisCopy;
use super::service::DeployService;

pub const USAGE: &str = "usage: OpenMindStudio.exe --deploy status | discover [--target <host[:port]>]... [--json] | \
test [--target <host[:port]>]... [--no-download] [--json] | serve [--packages <folder>] | \
provision <deployment id|first> [--kind share|setup|portable] [--to <folder>] [--target <host[:port]>]... [--no-shortcut] [--trust] | untrust <deployment id>";

#[derive(Debug, Default, PartialEq, Eq)]
struct Args {
    action: String,
    targets: Vec<SocketAddr>,
    json: bool,
    download: bool,
    packages: Option<PathBuf>,
    deployment: Option<String>,
    kind: Option<String>,
    to: Option<PathBuf>,
    no_shortcut: bool,
    trust: bool,
}

fn target(text: &str) -> Result<SocketAddr, String> {
    let with_port = if text.contains(':') && !text.starts_with('[') {
        text.to_string()
    } else {
        format!("{text}:{}", openmind_deploy::DISCOVERY_PORT)
    };
    with_port
        .to_socket_addrs()
        .map_err(|err| format!("{text}: {err}"))?
        .find(SocketAddr::is_ipv4)
        .ok_or_else(|| format!("{text} has no IPv4 address"))
}

fn parse(words: &[String]) -> Result<Args, String> {
    let mut args = Args {
        action: words.first().cloned().ok_or(USAGE)?,
        download: true,
        ..Args::default()
    };
    let mut rest = words.iter().skip(1);
    while let Some(word) = rest.next() {
        let mut value = || {
            rest.next()
                .cloned()
                .ok_or_else(|| format!("{word} needs a value"))
        };
        match word.as_str() {
            "--target" => args.targets.push(target(&value()?)?),
            "--json" => args.json = true,
            "--no-download" => args.download = false,
            "--no-shortcut" => args.no_shortcut = true,
            "--trust" => args.trust = true,
            "--packages" => args.packages = Some(PathBuf::from(value()?)),
            "--kind" => args.kind = Some(value()?),
            "--to" => args.to = Some(PathBuf::from(value()?)),
            other if !other.starts_with("--") && args.deployment.is_none() => {
                args.deployment = Some(other.to_string());
            }
            other => return Err(format!("unknown option {other}\n{USAGE}")),
        }
    }
    Ok(args)
}

/// `--deploy ...` as the first argument: runs it and returns the exit code; `None` for an ordinary launch.
pub fn run_cli() -> Option<i32> {
    let mut all = std::env::args_os().skip(1);
    if all.next()? != "--deploy" {
        return None;
    }
    let words: Vec<String> = all.map(|a| a.to_string_lossy().into_owned()).collect();
    crate::commands::integration::attach_console();
    let args = match parse(&words) {
        Ok(args) => args,
        Err(err) => {
            eprintln!("{err}");
            return Some(2);
        }
    };
    let copy = match crate::data_scope::paths_readonly() {
        Ok(paths) => ThisCopy::from_paths(&paths),
        Err(err) => {
            eprintln!("This copy's folders can't be found: {err}");
            return Some(1);
        }
    };
    Some(match run(&args, copy) {
        Ok(code) => code,
        Err(err) => {
            eprintln!("{err}");
            1
        }
    })
}

fn options(args: &Args) -> Options {
    Options {
        targets: args.targets.clone(),
        ..Options::default()
    }
}

fn print_json(value: &impl serde::Serialize) {
    println!(
        "{}",
        serde_json::to_string_pretty(value).unwrap_or_default()
    );
}

fn run(args: &Args, mut copy: ThisCopy) -> Result<i32, String> {
    let service = DeployService::default();
    match args.action.as_str() {
        "status" => {
            print_json(&copy);
            Ok(0)
        }
        "discover" => {
            let (search, deployments) = service.search(&options(args), &copy);
            if args.json {
                print_json(&serde_json::json!({"search": search, "deployments": deployments}));
            } else {
                println!("{}", super::cli_text::search(&search, &deployments));
            }
            Ok(i32::from(deployments.is_empty()))
        }
        "test" => {
            let verifier = super::release_verifier()?;
            let report =
                super::checks::run(&copy, &service, &options(args), args.download, &verifier);
            if args.json {
                print_json(&report);
            } else {
                println!("{}", super::cli_text::report(&report));
            }
            Ok(i32::from(report.failed > 0))
        }
        "serve" => {
            if let Some(folder) = &args.packages {
                copy.packages_dir = folder.clone();
            }
            serve(&service, &copy)
        }
        "provision" => provision(args, &service, &copy),
        "untrust" => {
            let id = args
                .deployment
                .as_deref()
                .filter(|id| openmind_deploy::is_hex(id, 32))
                .ok_or("--deploy untrust needs the deployment id (32 hex digits).")?;
            super::trust::TrustStore::in_dir(&copy.data_root)
                .forget(id)
                .map_err(|err| format!("The trust record couldn't be saved: {err}"))?;
            println!("Deployment {id} is no longer trusted on this computer.");
            Ok(0)
        }
        _ => Err(USAGE.into()),
    }
}

fn serve(service: &DeployService, copy: &ThisCopy) -> Result<i32, String> {
    let offer = service.set_offering(copy, true, openmind_deploy::DISCOVERY_PORT);
    if let Some(error) = offer.error {
        return Err(error);
    }
    println!("{}", super::cli_text::offer(&offer));
    println!("Offering until this console is closed (Ctrl+C).");
    loop {
        std::thread::park();
    }
}

fn provision(args: &Args, service: &DeployService, copy: &ThisCopy) -> Result<i32, String> {
    let (_, deployments) = service.search(&options(args), copy);
    let wanted = args.deployment.as_deref().unwrap_or("first");
    let deployment = deployments
        .iter()
        .find(|d| d.id == wanted || (wanted == "first" && d.incompatible.is_none()))
        .ok_or_else(|| format!("No deployment {wanted} answered on the network."))?;
    let (manifest, source) = service.provisioning_source(&deployment.id)?;
    let kind = match args.kind.as_deref() {
        Some("share") => None,
        Some("setup") => Some(PackageKind::Installer),
        Some("portable") => Some(PackageKind::Portable),
        None if manifest.kind == DeploymentKind::NetworkShare && args.to.is_none() => None,
        None => Some(PackageKind::Installer),
        Some(other) => return Err(format!("--kind {other}: use share, setup or portable")),
    };
    let trust = super::trust::TrustStore::in_dir(&copy.data_root);
    if !trust.is_trusted(&manifest) {
        if !args.trust {
            return Err(format!(
                "{}\nRun again with --trust to trust deployment {} on this computer.",
                super::trust::untrusted_message(&manifest),
                manifest.deployment_id
            ));
        }
        let compatible = deployments
            .iter()
            .filter(|d| d.incompatible.is_none())
            .count();
        if wanted == "first" && compatible > 1 {
            return Err(format!(
                "{compatible} deployments answered: name the one to trust by its id (--deploy discover lists them)."
            ));
        }
        trust
            .trust(&manifest)
            .map_err(|err| format!("The trust record couldn't be saved: {err}"))?;
        println!(
            "Trusted deployment {}{}",
            manifest.deployment_id,
            manifest
                .share_path
                .as_deref()
                .map(|path| format!(" ({path})"))
                .unwrap_or_default()
        );
    }
    let outcome = super::live::with_live_effects(copy, !args.no_shortcut, |effects| {
        exec::provision(
            &Request {
                manifest,
                source,
                kind,
                destination: args.to.clone(),
            },
            effects,
        )
    })??;
    println!("{}", super::cli_text::outcome(&outcome));
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(text: &str) -> Vec<String> {
        text.split(' ').map(str::to_string).collect()
    }

    #[test]
    fn the_command_line_is_read_strictly() {
        let args = parse(&words("test --target 127.0.0.1 --no-download --json")).expect("args");
        assert_eq!(args.action, "test");
        assert_eq!(args.targets, vec!["127.0.0.1:47741".parse().expect("addr")]);
        assert!(args.json && !args.download);
        let args = parse(&words("provision first --kind portable --to D:\\Apps")).expect("args");
        assert_eq!(args.deployment.as_deref(), Some("first"));
        assert_eq!(args.to, Some(PathBuf::from("D:\\Apps")));
        assert!(parse(&words("test --bogus")).is_err());
        assert!(parse(&words("test --target")).is_err());
        assert!(parse(&[]).is_err());
        let explicit = parse(&words("discover --target 10.0.0.5:5000")).expect("args");
        assert_eq!(explicit.targets[0].port(), 5000);
    }
}
