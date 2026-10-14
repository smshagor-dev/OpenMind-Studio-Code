//! What provisioning one computer from one deployment means, decided from facts only (no I/O): the deployment's
//! manifest, this computer's platform and architecture, and what the folder the user chose holds. The app gathers the
//! facts and carries the [`Plan`] out; a [`Refusal`] carries its reason in words.
//!
//! - a **shared network installation** is never copied: this computer only gets a shortcut to the program in the share
//!   (its database, settings and caches are created locally at its first start) — [`Plan::UseShare`];
//! - a **package** is chosen for this computer: the requested kind, an architecture this computer's Windows runs —
//!   preferring its own — and the newest version;
//! - the destination decides between [`Plan::Install`] (missing or empty), [`Plan::Upgrade`] (an older OpenMind Studio
//!   of the same kind), [`Plan::Repair`] (the same version) and a refusal: a newer copy is never downgraded, a folder
//!   holding something else is never written into, a setup installation is never overwritten by a portable package or
//!   the other way round.
//!
//! **Any drive, any folder**: the destination is whatever path the user chose; nothing here knows a drive letter.

use std::cmp::Ordering;

use crate::advert::{DeploymentKind, Manifest, PackageEntry, PackageKind};
use crate::{version, Arch};

/// What is in the folder the user chose.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Destination {
    /// Not there yet (it will be created).
    Missing,
    Empty,
    /// An OpenMind Studio copy: its version and how it was installed.
    Installed {
        version: String,
        kind: PackageKind,
    },
    /// Files that aren't an OpenMind Studio copy.
    NotOurs,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    /// Point a shortcut at the shared program; nothing is copied.
    UseShare {
        exe: String,
    },
    Install {
        package: PackageEntry,
    },
    Upgrade {
        from: String,
        package: PackageEntry,
    },
    Repair {
        package: PackageEntry,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Refusal {
    #[error("this deployment is for {offered}, and this computer runs {this}")]
    Platform { offered: String, this: String },
    #[error("this deployment offers no package this computer's Windows ({os}) can run")]
    Architecture { os: String },
    #[error("this deployment offers no {0} package")]
    NoPackage(String),
    #[error("the folder already has OpenMind Studio {installed}, newer than the offered {offered}; it is never downgraded")]
    Downgrade { installed: String, offered: String },
    #[error(
        "the folder already holds other files that aren't OpenMind Studio; choose an empty folder"
    )]
    NotOurs,
    #[error(
        "the folder holds an OpenMind Studio {installed} copy; use a {installed} package for it"
    )]
    KindMismatch { installed: String },
    #[error("the deployment has no network path to use")]
    NoSharePath,
}

fn kind_label(kind: PackageKind) -> &'static str {
    match kind {
        PackageKind::Installer => "setup",
        PackageKind::Portable => "portable",
    }
}

/// The package for this computer (see the module text).
pub fn choose_package(
    packages: &[PackageEntry],
    os: Arch,
    kind: PackageKind,
) -> Result<&PackageEntry, Refusal> {
    let of_kind: Vec<&PackageEntry> = packages.iter().filter(|p| p.kind == kind).collect();
    if of_kind.is_empty() {
        return Err(Refusal::NoPackage(kind_label(kind).into()));
    }
    of_kind
        .into_iter()
        .filter(|p| os.runs(p.arch))
        .max_by(|a, b| {
            (a.arch == os)
                .cmp(&(b.arch == os))
                .then_with(|| version::compare(&a.version, &b.version))
        })
        .ok_or_else(|| Refusal::Architecture {
            os: os.label().into(),
        })
}

fn same_platform(manifest: &Manifest, platform: &str) -> Result<(), Refusal> {
    if manifest.platform == platform {
        Ok(())
    } else {
        Err(Refusal::Platform {
            offered: manifest.platform.clone(),
            this: platform.into(),
        })
    }
}

/// Provisioning from a shared network installation.
pub fn plan_share(manifest: &Manifest, platform: &str, os: Arch) -> Result<Plan, Refusal> {
    same_platform(manifest, platform)?;
    if !os.runs(manifest.arch) {
        return Err(Refusal::Architecture {
            os: os.label().into(),
        });
    }
    let share = manifest
        .share_path
        .as_deref()
        .filter(|_| manifest.kind == DeploymentKind::NetworkShare)
        .ok_or(Refusal::NoSharePath)?;
    Ok(Plan::UseShare {
        exe: format!(r"{}\OpenMindStudio.exe", share.trim_end_matches('\\')),
    })
}

/// Provisioning a package of `kind` into a destination holding `destination`.
pub fn plan_package(
    manifest: &Manifest,
    platform: &str,
    os: Arch,
    kind: PackageKind,
    destination: &Destination,
) -> Result<Plan, Refusal> {
    same_platform(manifest, platform)?;
    let package = choose_package(&manifest.packages, os, kind)?.clone();
    match destination {
        Destination::Missing | Destination::Empty => Ok(Plan::Install { package }),
        Destination::NotOurs => Err(Refusal::NotOurs),
        Destination::Installed {
            version,
            kind: installed,
        } => {
            if *installed != kind {
                return Err(Refusal::KindMismatch {
                    installed: kind_label(*installed).into(),
                });
            }
            match version::compare(&package.version, version) {
                Ordering::Greater => Ok(Plan::Upgrade {
                    from: version.clone(),
                    package,
                }),
                Ordering::Equal => Ok(Plan::Repair { package }),
                Ordering::Less => Err(Refusal::Downgrade {
                    installed: version.clone(),
                    offered: package.version,
                }),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::advert::tests::{package, source_manifest};

    #[test]
    fn a_64_bit_computer_gets_the_x64_setup_and_a_32_bit_one_the_x86_setup() {
        let manifest = source_manifest();
        let x64 = plan_package(
            &manifest,
            "windows",
            Arch::X64,
            PackageKind::Installer,
            &Destination::Missing,
        );
        assert!(matches!(x64, Ok(Plan::Install { ref package }) if package.arch == Arch::X64));
        let x86 = plan_package(
            &manifest,
            "windows",
            Arch::X86,
            PackageKind::Installer,
            &Destination::Empty,
        );
        assert!(matches!(x86, Ok(Plan::Install { ref package }) if package.arch == Arch::X86));
    }

    #[test]
    fn a_32_bit_computer_is_refused_an_x64_only_package() {
        let manifest = source_manifest();
        assert_eq!(
            plan_package(
                &manifest,
                "windows",
                Arch::X86,
                PackageKind::Portable,
                &Destination::Empty
            ),
            Err(Refusal::Architecture { os: "x86".into() })
        );
        assert_eq!(
            plan_package(
                &manifest,
                "linux",
                Arch::X64,
                PackageKind::Installer,
                &Destination::Empty
            ),
            Err(Refusal::Platform {
                offered: "windows".into(),
                this: "linux".into()
            })
        );
    }

    #[test]
    fn the_destination_decides_install_upgrade_repair_or_refusal() {
        let manifest = source_manifest();
        let plan = |destination: Destination| {
            plan_package(
                &manifest,
                "windows",
                Arch::X64,
                PackageKind::Installer,
                &destination,
            )
        };
        let installed = |version: &str, kind| Destination::Installed {
            version: version.into(),
            kind,
        };
        assert!(matches!(
            plan(installed("1.0.2", PackageKind::Installer)),
            Ok(Plan::Upgrade { ref from, .. }) if from == "1.0.2"
        ));
        assert!(matches!(
            plan(installed("1.0.3", PackageKind::Installer)),
            Ok(Plan::Repair { .. })
        ));
        assert_eq!(
            plan(installed("1.1.0", PackageKind::Installer)),
            Err(Refusal::Downgrade {
                installed: "1.1.0".into(),
                offered: "1.0.3".into()
            })
        );
        assert_eq!(plan(Destination::NotOurs), Err(Refusal::NotOurs));
        assert_eq!(
            plan(installed("1.0.2", PackageKind::Portable)),
            Err(Refusal::KindMismatch {
                installed: "portable".into()
            })
        );
    }

    #[test]
    fn the_newest_runnable_package_wins() {
        let packages = vec![
            package("1.0.2", Arch::X64, PackageKind::Installer),
            package("1.0.10", Arch::X64, PackageKind::Installer),
            package("1.0.11", Arch::X86, PackageKind::Installer),
        ];
        let chosen = choose_package(&packages, Arch::X64, PackageKind::Installer).expect("one");
        assert_eq!(
            (chosen.version.as_str(), chosen.arch),
            ("1.0.10", Arch::X64),
            "native first"
        );
        let on_arm = choose_package(&packages, Arch::Arm64, PackageKind::Installer).expect("one");
        assert_eq!(on_arm.version, "1.0.11");
    }

    #[test]
    fn a_share_is_used_where_it_is_never_copied() {
        let mut manifest = source_manifest();
        manifest.kind = DeploymentKind::NetworkShare;
        manifest.share_path = Some(r"\\server\apps\OpenMind Studio".into());
        assert_eq!(
            plan_share(&manifest, "windows", Arch::X64),
            Ok(Plan::UseShare {
                exe: r"\\server\apps\OpenMind Studio\OpenMindStudio.exe".into()
            })
        );
        manifest.arch = Arch::X64;
        assert!(plan_share(&manifest, "windows", Arch::X86).is_err());
        assert_eq!(
            plan_share(&source_manifest(), "windows", Arch::X64),
            Err(Refusal::NoSharePath)
        );
    }
}
