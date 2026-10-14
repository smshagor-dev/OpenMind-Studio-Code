//! Carrying out a provisioning [`Plan`] on this computer.
//!
//! - **a shared installation**: check the program in the share can be read, add this user's Desktop shortcut to it (its
//!   network path), and say where this computer's own data will be — nothing is copied;
//! - **a package**: one provisioning per destination at a time (an operating-system lock next to the folder — also
//!   across computers when the folder is on a share); never while the copy there runs on this computer; download from
//!   the source into this computer's temporary folder; verify size, SHA-256 and the release signature (anything that
//!   fails is deleted); then
//!   - the **setup** runs silently into the chosen folder (`/S /D=<folder>`): it detects an existing installation and
//!     updates or repairs it in place, keeping its data, and refuses a downgrade or a copy in use (exit code 3);
//!   - the **portable ZIP** is unpacked safely beside the folder and renamed into place (new), or swapped in item by
//!     item with the updater's all-or-nothing swap (upgrade, repair) — `data/`, `settings/`, `runtimes/` and the rest of
//!     the user's things are never touched;
//! - finally the Desktop shortcut points at the program in the chosen folder.
//!
//! The destination is any folder the user chose; nothing assumes a drive.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use openmind_deploy::advert::{Manifest, PackageEntry, PackageKind};
use openmind_deploy::client;
use openmind_deploy::package::{verify_bytes, Verifier};
use openmind_deploy::provision::{plan_package, plan_share, Destination, Plan};
use serde::Serialize;

use super::inspect::{self, PROGRAM};
use super::local::os_arch;

/// How long the silent setup may take.
const SETUP_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);

/// What the user asked for.
#[derive(Debug, Clone)]
pub struct Request {
    pub manifest: Manifest,
    /// The source's package server (`None` for a share used as it is).
    pub source: Option<SocketAddr>,
    /// `None`: use the shared installation itself (only a shortcut).
    pub kind: Option<PackageKind>,
    pub destination: Option<PathBuf>,
}

/// What was done.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    /// `shortcut`, `install`, `upgrade`, `repair`.
    pub action: String,
    pub program: PathBuf,
    pub version: String,
    pub shortcut: Option<String>,
    /// Where the provisioned copy keeps this computer's data.
    pub data_location: String,
    pub steps: Vec<String>,
}

/// The app's side effects, injected so tests never touch the user's Desktop or start programs.
pub struct Effects<'a> {
    pub verifier: Verifier<'a>,
    /// Creates or repairs this user's Desktop shortcut to a program.
    pub shortcut: &'a dyn Fn(&Path) -> Result<String, String>,
    /// Runs a setup with its arguments, returning its exit code.
    pub run_setup: &'a dyn Fn(&Path, &Path) -> Result<i32, String>,
    /// This computer's temporary folder for downloads (each provisioning gets its own folder inside).
    pub temp_dir: PathBuf,
    /// This computer's folder for the provisioning lock of a destination on its own disks.
    pub lock_dir: PathBuf,
    /// Whether this computer's user trusted the deployment (see `trust.rs`); nothing is provisioned otherwise.
    pub trusted: &'a dyn Fn(&Manifest) -> bool,
    /// The oldest version a package may have: this program's own. An older release, even correctly signed, is
    /// refused — a forged source can't roll a computer back to a version with problems fixed since.
    pub minimum_version: &'a str,
    pub cancel: &'a AtomicBool,
}

/// Carries out the request (see the module text).
pub fn provision(request: &Request, effects: &Effects) -> Result<Outcome, String> {
    let platform = openmind_deploy::this_platform();
    if !(effects.trusted)(&request.manifest) {
        return Err(super::trust::untrusted_message(&request.manifest));
    }
    match (&request.kind, &request.destination) {
        (None, _) => {
            let plan =
                plan_share(&request.manifest, platform, os_arch()).map_err(|r| r.to_string())?;
            let Plan::UseShare { exe } = plan else {
                return Err("unexpected plan".into());
            };
            use_share(Path::new(&exe), &request.manifest.app_version, effects)
        }
        (Some(_), None) => Err("Choose the folder to install OpenMind Studio into.".into()),
        (Some(kind), Some(dest)) => {
            if !dest.is_absolute() {
                return Err(format!("{} is not a full folder path.", dest.display()));
            }
            let source = request
                .source
                .ok_or("This deployment has no package server to download from.")?;
            provision_package(&request.manifest, source, *kind, dest, effects)
        }
    }
}

fn use_share(exe: &Path, version: &str, effects: &Effects) -> Result<Outcome, String> {
    let meta = std::fs::metadata(exe).map_err(|err| {
        format!(
            "{} can't be reached from this computer ({err}). Check the network connection and that this Windows user \
             may read the share.",
            exe.display()
        )
    })?;
    if !meta.is_file() {
        return Err(format!("{} is not the program.", exe.display()));
    }
    let shortcut = (effects.shortcut)(exe)?;
    let dir = exe.parent().unwrap_or(exe);
    let data_location = openmind_core::install::local_install_dir(dir).map_or_else(
        || "this computer's local application data folder".to_string(),
        |local| local.display().to_string(),
    );
    Ok(Outcome {
        action: "shortcut".into(),
        program: exe.to_path_buf(),
        version: version.to_string(),
        shortcut: Some(shortcut),
        data_location,
        steps: vec![
            format!("{} is readable from this computer", exe.display()),
            "nothing was copied: the shared installation is used as it is".into(),
        ],
    })
}

/// The provisioning lock of `dest`. A folder on a network share is locked next to it
/// (`<parent>/.<name>.openmind-provision.lock`), so two computers provisioning one shared folder exclude each other; a
/// folder on this computer is locked in this computer's own lock folder, so no lock file is left beside the user's
/// folders (a drive's root, say).
fn lock_file(dest: &Path, lock_dir: &Path) -> PathBuf {
    if openmind_core::install::is_remote_path(dest) {
        let name = dest
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "openmind".into());
        return dest.with_file_name(format!(".{name}.openmind-provision.lock"));
    }
    lock_dir.join(format!(
        "{}.lock",
        openmind_core::install::install_key(dest)
    ))
}

fn provision_package(
    manifest: &Manifest,
    source: SocketAddr,
    kind: PackageKind,
    dest: &Path,
    effects: &Effects,
) -> Result<Outcome, String> {
    let parent = dest
        .parent()
        .ok_or_else(|| format!("{} has no parent folder.", dest.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|err| format!("{} can't be created or written: {err}", parent.display()))?;
    let _lock = openmind_core::profile_lock::ProfileLock::acquire_file(
        &lock_file(dest, &effects.lock_dir),
        Duration::from_secs(2),
    )
    .map_err(|_| {
        format!(
            "{} is being provisioned right now (on this or another computer). Try again when it has finished.",
            dest.display()
        )
    })?;
    let destination = inspect::destination(dest);
    let plan = plan_package(
        manifest,
        openmind_deploy::this_platform(),
        os_arch(),
        kind,
        &destination,
    )
    .map_err(|refusal| refusal.to_string())?;
    if matches!(destination, Destination::Installed { .. }) && inspect::running(&dest.join(PROGRAM))
    {
        return Err(format!(
            "OpenMind Studio is running from {} on this computer. Close it first.",
            dest.display()
        ));
    }
    let (action, package) = match &plan {
        Plan::Install { package } => ("install", package),
        Plan::Upgrade { package, .. } => ("upgrade", package),
        Plan::Repair { package } => ("repair", package),
        Plan::UseShare { .. } => return Err("unexpected plan".into()),
    };
    if openmind_deploy::version::compare(&package.version, effects.minimum_version)
        == std::cmp::Ordering::Less
    {
        return Err(format!(
            "The offered package is OpenMind Studio {}, older than this computer's {}. An older release is never \
             installed from the network.",
            package.version, effects.minimum_version
        ));
    }
    let mut steps = vec![format!(
        "{action}: {} into {}",
        package.name,
        dest.display()
    )];
    let download_dir = effects
        .temp_dir
        .join("deploy")
        .join(openmind_deploy::random_hex(8));
    let fetched = fetch(source, package, &download_dir, effects, &mut steps);
    let installed = fetched.and_then(|(downloaded, held)| {
        let outcome = match kind {
            PackageKind::Installer => run_setup(&downloaded, dest, effects, &mut steps),
            PackageKind::Portable => place_portable(&downloaded, dest, package, &plan, &mut steps),
        };
        // Only now may the file change: it was used exactly as it was verified.
        drop(held);
        outcome
    });
    let _ = std::fs::remove_dir_all(&download_dir);
    installed?;
    finish(dest, package, action, effects, steps)
}

/// Opens a downloaded package so that nothing else can change or delete it while the handle lives (others may still
/// read and run it): the bytes verified are the bytes installed.
pub(crate) fn open_held(file: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_SHARE_READ only: no writer, no delete or rename while held.
        options.share_mode(0x0000_0001);
    }
    options.open(file)
}

/// Downloads the package into `dir`, then verifies it through a handle that is kept (see [`open_held`]).
fn fetch(
    source: SocketAddr,
    package: &PackageEntry,
    dir: &Path,
    effects: &Effects,
    steps: &mut Vec<String>,
) -> Result<(PathBuf, std::fs::File), String> {
    let file = dir.join(&package.name);
    client::download(
        source,
        package,
        &file,
        DOWNLOAD_TIMEOUT,
        &mut |_, _| {},
        effects.cancel,
    )
    .map_err(|err| format!("The package couldn't be downloaded from {source}: {err}"))?;
    let refused = |reason: String| {
        let _ = std::fs::remove_file(&file);
        format!(
            "The package from {source} was refused and deleted: {reason}. Nothing was installed."
        )
    };
    let mut held = open_held(&file).map_err(|err| refused(err.to_string()))?;
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut held, &mut bytes).map_err(|err| refused(err.to_string()))?;
    if let Err(reason) = verify_bytes(&bytes, package, effects.verifier) {
        drop(held);
        return Err(refused(reason));
    }
    steps.push(format!(
        "downloaded {} bytes from {source}; size, SHA-256 and release signature verified",
        package.size
    ));
    Ok((file, held))
}

fn run_setup(
    setup: &Path,
    dest: &Path,
    effects: &Effects,
    steps: &mut Vec<String>,
) -> Result<(), String> {
    let code = (effects.run_setup)(setup, dest)?;
    match code {
        0 => {
            steps.push("the setup finished".into());
            Ok(())
        }
        3 => Err(format!(
            "The setup refused to change {} (the copy there is in use, newer, or another setup is running). Nothing was \
             changed.",
            dest.display()
        )),
        1 => Err("The setup was cancelled. Nothing was installed.".into()),
        2 => Err("The setup stopped with an error (exit code 2). Check that you may write to the folder.".into()),
        other => Err(format!("The setup ended with exit code {other}.")),
    }
}

/// Runs the signed setup silently into `dest` and waits for it (the real `Effects::run_setup`).
#[cfg(windows)]
pub fn run_setup_silently(setup: &Path, dest: &Path) -> Result<i32, String> {
    use std::os::windows::process::CommandExt;
    // NSIS reads `/D=` raw and last, spaces included and unquoted.
    let mut child = std::process::Command::new(setup)
        .arg("/S")
        .raw_arg(format!("/D={}", dest.display()))
        .spawn()
        .map_err(|err| match err.raw_os_error() {
            // ERROR_ELEVATION_REQUIRED: never escalated silently.
            Some(740) => "The setup needs administrator rights for this folder. Choose a folder you may write to \
                          (for example under your user profile or another drive), or ask your IT administrator."
                .to_string(),
            _ => format!("The setup couldn't be started: {err}"),
        })?;
    let deadline = std::time::Instant::now() + SETUP_TIMEOUT;
    loop {
        if let Some(status) = child.try_wait().map_err(|err| err.to_string())? {
            return Ok(status.code().unwrap_or(-1));
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            return Err("The setup didn't finish within 15 minutes and was stopped.".into());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

#[cfg(not(windows))]
pub fn run_setup_silently(_setup: &Path, _dest: &Path) -> Result<i32, String> {
    Err("The setup runs on Windows only.".into())
}

fn place_portable(
    zip: &Path,
    dest: &Path,
    package: &PackageEntry,
    plan: &Plan,
    steps: &mut Vec<String>,
) -> Result<(), String> {
    let staging = dest.with_file_name(format!(
        ".{}.provisioning-{}",
        dest.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        openmind_deploy::random_hex(6)
    ));
    let outcome = unpack_and_place(zip, &staging, dest, package, plan, steps);
    let _ = std::fs::remove_dir_all(&staging);
    outcome
}

fn unpack_and_place(
    zip: &Path,
    staging: &Path,
    dest: &Path,
    package: &PackageEntry,
    plan: &Plan,
    steps: &mut Vec<String>,
) -> Result<(), String> {
    std::fs::create_dir_all(staging).map_err(|err| err.to_string())?;
    openmind_runtime_manager::extract::extract_archive(
        openmind_runtime_manager::manifest::ArchiveKind::Zip,
        zip,
        staging,
        openmind_runtime_manager::extract::ExtractSelection {
            strip_components: 0,
            only_under: None,
        },
        &mut |_, _| {},
    )
    .map_err(|err| format!("The portable package couldn't be unpacked safely: {err}"))?;
    let files = [staging.join("OpenMind Studio"), staging.to_path_buf()]
        .into_iter()
        .find(|dir| dir.join(PROGRAM).is_file())
        .ok_or("The portable package doesn't contain OpenMindStudio.exe.")?;
    match plan {
        Plan::Install { .. } => {
            if dest.is_dir() {
                std::fs::remove_dir(dest)
                    .map_err(|err| format!("{} isn't empty any more: {err}", dest.display()))?;
            }
            std::fs::rename(&files, dest).map_err(|err| format!("{}: {err}", dest.display()))?;
            steps.push("unpacked into place".into());
        }
        _ => {
            crate::updates::portable::apply(&crate::updates::portable::Staged {
                version: package.version.clone(),
                files,
                root: dest.to_path_buf(),
            })?;
            steps.push(
                "the program's own files were swapped in; data, settings and runtimes kept".into(),
            );
        }
    }
    Ok(())
}

fn finish(
    dest: &Path,
    package: &PackageEntry,
    action: &str,
    effects: &Effects,
    mut steps: Vec<String>,
) -> Result<Outcome, String> {
    let program = dest.join(PROGRAM);
    if !program.is_file() {
        return Err(format!(
            "{} is missing after the {action}; nothing usable was installed.",
            program.display()
        ));
    }
    let shortcut = match (effects.shortcut)(&program) {
        Ok(line) => Some(line),
        Err(err) => {
            steps.push(format!("the Desktop shortcut couldn't be created: {err}"));
            None
        }
    };
    let data_location = if openmind_core::install::is_remote_path(dest) {
        openmind_core::install::local_install_dir(dest).map_or_else(
            || "this computer's local application data folder".into(),
            |local| local.display().to_string(),
        )
    } else {
        dest.join("data").display().to_string()
    };
    Ok(Outcome {
        action: action.into(),
        program,
        version: package.version.clone(),
        shortcut,
        data_location,
        steps,
    })
}

#[cfg(test)]
#[path = "exec_tests.rs"]
mod tests;
