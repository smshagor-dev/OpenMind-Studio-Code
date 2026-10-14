//! The provisioning half of the Network Deployment Test (see `checks.rs`): is there something this computer can
//! install or use, is it intact and signed, would provisioning go ahead, does the shortcut start the right program, and
//! are runtimes reused instead of downloaded again.

use std::path::Path;
use std::sync::atomic::AtomicBool;

use openmind_deploy::advert::{DeploymentKind, PackageEntry, PackageKind};
use openmind_deploy::client;
use openmind_deploy::package::{verify_file, Verifier};
use openmind_deploy::provision::{choose_package, plan_package, Destination};

use super::super::local::{RuntimeStore, ThisCopy};
use super::super::service::{share_program, DeployService, DeploymentView};
use super::{blocked, fail, not_tested, pass, Check};

pub(super) fn provisioning(
    copy: &ThisCopy,
    service: &DeployService,
    chosen: Option<&DeploymentView>,
    download_package: bool,
    verifier: Verifier,
) -> Vec<Check> {
    let Some(deployment) = chosen else {
        let mut checks: Vec<Check> = [
            "packageAvailability",
            "packageIntegrity",
            "provisioningReadiness",
        ]
        .into_iter()
        .map(|id| blocked(id, "no deployment to provision from"))
        .collect();
        checks.push(shortcut(copy));
        checks.push(runtime_reuse(copy, None));
        return checks;
    };
    let package = choose_package(
        &deployment.manifest.packages,
        copy.os_arch,
        PackageKind::Installer,
    )
    .or_else(|_| {
        choose_package(
            &deployment.manifest.packages,
            copy.os_arch,
            PackageKind::Portable,
        )
    })
    .ok()
    .cloned();
    let share = deployment.manifest.kind == DeploymentKind::NetworkShare;
    let availability = match (&package, share) {
        (Some(p), _) => pass(
            "packageAvailability",
            format!("{} ({} bytes)", p.name, p.size),
        ),
        (None, true) => pass(
            "packageAvailability",
            "none needed: the shared installation is used where it is",
        ),
        (None, false) => fail(
            "packageAvailability",
            deployment.manifest_error.clone().unwrap_or_else(|| {
                format!(
                    "no package this computer's Windows ({}) can run",
                    copy.os_arch.label()
                )
            }),
        ),
    };
    let integrity = match &package {
        None => blocked("packageIntegrity", "no package to verify"),
        Some(_) if !download_package => not_tested(
            "packageIntegrity",
            "not downloaded (run the test with package verification)",
        ),
        Some(p) => integrity(copy, service, deployment, p, verifier),
    };
    vec![
        availability,
        integrity,
        readiness(copy, deployment, package.as_ref()),
        shortcut(copy),
        runtime_reuse(copy, Some(deployment)),
    ]
}

/// Downloads the package into this computer's temporary folder, verifies it the way provisioning would, deletes it.
fn integrity(
    copy: &ThisCopy,
    service: &DeployService,
    deployment: &DeploymentView,
    package: &PackageEntry,
    verifier: Verifier,
) -> Check {
    let server = match service.provisioning_source(&deployment.id) {
        Ok((_, Some(server))) => server,
        Ok((_, None)) => return blocked("packageIntegrity", "no source serves the package"),
        Err(err) => return blocked("packageIntegrity", err),
    };
    let file = copy.temp_dir.join("deploy-test").join(&package.name);
    let cancel = AtomicBool::new(false);
    let downloaded = client::download(
        server,
        package,
        &file,
        std::time::Duration::from_secs(60),
        &mut |_, _| {},
        &cancel,
    );
    let check = match downloaded {
        Err(err) => fail("packageIntegrity", format!("download from {server} failed: {err}")),
        Ok(()) => match verify_file(&file, package, verifier) {
            Ok(()) => pass(
                "packageIntegrity",
                format!("downloaded from {server}: size, SHA-256 and the release signature for {} verified", package.version),
            ),
            Err(reason) => fail("packageIntegrity", format!("REFUSED: {reason}")),
        },
    };
    let _ = std::fs::remove_file(&file);
    let _ = std::fs::remove_dir(file.parent().unwrap_or(Path::new("")));
    check
}

/// Readiness, and whether this computer trusts the deployment yet (provisioning asks for that first).
fn readiness(
    copy: &ThisCopy,
    deployment: &DeploymentView,
    package: Option<&PackageEntry>,
) -> Check {
    let check = readiness_of(copy, deployment, package);
    if check.status == super::Status::Pass && !deployment.trusted {
        return blocked(
            "provisioningReadiness",
            format!(
                "UNTRUSTED DEPLOYMENT: {} — not trusted on this computer yet; provisioning asks the user to trust it first",
                check.detail
            ),
        );
    }
    check
}

fn readiness_of(
    copy: &ThisCopy,
    deployment: &DeploymentView,
    package: Option<&PackageEntry>,
) -> Check {
    if let Some(reason) = &deployment.incompatible {
        return fail("provisioningReadiness", reason.clone());
    }
    if deployment.manifest.kind == DeploymentKind::NetworkShare {
        let Some(program) = share_program(&deployment.manifest) else {
            return fail(
                "provisioningReadiness",
                "the shared installation announced no network path",
            );
        };
        return match std::fs::metadata(&program) {
            Ok(meta) if meta.is_file() => pass(
                "provisioningReadiness",
                format!("{} is readable from this computer: a shortcut to it is all this computer needs", program.display()),
            ),
            Ok(_) => fail("provisioningReadiness", format!("{} is not the program", program.display())),
            Err(err) => fail(
                "provisioningReadiness",
                format!("{} can't be reached from this computer ({err}): check the network and this user's read access to the share", program.display()),
            ),
        };
    }
    let Some(package) = package else {
        return blocked("provisioningReadiness", "no package to provision");
    };
    match plan_package(
        &deployment.manifest,
        openmind_deploy::this_platform(),
        copy.os_arch,
        package.kind,
        &Destination::Missing,
    ) {
        Ok(_) => pass(
            "provisioningReadiness",
            format!(
                "ready: {} can be installed into any folder this user chooses, on any drive",
                package.name
            ),
        ),
        Err(refusal) => fail("provisioningReadiness", refusal.to_string()),
    }
}

#[cfg(windows)]
fn shortcut(copy: &ThisCopy) -> Check {
    use crate::integration::check::ShortcutState;
    let report = crate::integration::check::gather(&copy.exe);
    let installed = copy.layout != openmind_core::InstallLayout::Portable;
    match report.shortcut {
        ShortcutState::Correct(lnk) => pass(
            "shortcutValidity",
            format!("{} starts this program", lnk.display()),
        ),
        ShortcutState::DriveLetter(lnk) => fail(
            "shortcutValidity",
            format!(
                "{} starts this program through a drive letter other computers may not have: use Create or Repair Desktop Shortcut",
                lnk.display()
            ),
        ),
        // A portable (or test) copy is never given the Desktop shortcut: the one there belongs to another copy, and
        // leaving it alone is how copies stay apart.
        ShortcutState::OtherProgram(lnk, target) if !installed => not_tested(
            "shortcutValidity",
            format!(
                "a portable copy gets no Desktop shortcut; {} belongs to another OpenMind Studio copy ({}) and was left alone",
                lnk.display(),
                target.display()
            ),
        ),
        ShortcutState::OtherProgram(lnk, target) => fail(
            "shortcutValidity",
            format!(
                "{} starts {}, not this installation: use Create or Repair Desktop Shortcut",
                lnk.display(),
                target.display()
            ),
        ),
        ShortcutState::Missing => match report.public_shortcut {
            Some(public) => pass(
                "shortcutValidity",
                format!("{} (Public Desktop) starts this program", public.display()),
            ),
            None if !installed => not_tested(
                "shortcutValidity",
                "a portable copy gets no Desktop shortcut (start it from its folder)",
            ),
            None => fail(
                "shortcutValidity",
                "no Desktop shortcut starts this installation: use Create or Repair Desktop Shortcut",
            ),
        },
    }
}

#[cfg(not(windows))]
fn shortcut(_copy: &ThisCopy) -> Check {
    not_tested(
        "shortcutValidity",
        "Desktop shortcuts are checked on Windows only",
    )
}

fn runtime_reuse(copy: &ThisCopy, deployment: Option<&DeploymentView>) -> Check {
    let offered = deployment.map_or(0, |d| d.manifest.runtimes.len());
    match copy.runtime_store {
        RuntimeStore::Shared => pass(
            "runtimeReuse",
            format!(
                "runtimes in {} are shared: one installed by any computer is used by every other without a download \
                 (one computer installs while the others wait for it)",
                copy.runtimes_dir.display()
            ),
        ),
        RuntimeStore::Local if offered > 0 => pass(
            "runtimeReuse",
            format!("the shared installation holds {offered} ready runtime(s); this copy keeps its own store"),
        ),
        RuntimeStore::Local => pass("runtimeReuse", "this copy keeps its own runtimes (not a shared installation)"),
    }
}
