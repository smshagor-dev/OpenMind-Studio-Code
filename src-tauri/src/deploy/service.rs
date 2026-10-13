//! The app's deployment state (one per process, Tauri-managed): whether this computer is offering itself, what the last
//! search found, and provisioning from a found deployment. Searching happens only when the user (or the Network
//! Deployment Test) asks; offering only while `deployment.advertiseOnLan` is on — nothing is sent at start-up.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use openmind_deploy::advert::{Advert, DeploymentKind, Manifest, MANIFEST_FORMAT};
use openmind_deploy::discover::{self, Options, Outcome};
use openmind_deploy::registry::{DiscoveredSet, DEFAULT_TTL};
use openmind_deploy::responder::Responder;
use openmind_deploy::server::{Catalog, PackageServer};
use openmind_deploy::{client, random_hex, PROTOCOL};
use serde::Serialize;

use super::local::{build_offer, ThisCopy};

/// What this computer is offering right now.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfferView {
    pub on: bool,
    pub discovery_address: Option<String>,
    pub package_address: Option<String>,
    pub kind: Option<DeploymentKind>,
    pub deployment_id: Option<String>,
    pub packages: Vec<String>,
    pub runtimes: usize,
    /// Files left out of the offer, and why.
    pub problems: Vec<String>,
    /// Why nothing is offered although it was asked for (nothing to offer, the port can't be bound ...).
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceView {
    pub address: String,
    pub app_version: String,
    pub seconds_ago: u64,
    pub serves_packages: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentView {
    pub id: String,
    pub manifest: Manifest,
    pub sources: Vec<SourceView>,
    /// Why this computer can't use it (another platform, an architecture its Windows can't run), or `None`.
    pub incompatible: Option<String>,
    /// The manifest couldn't be fetched from any source (the package list is then empty).
    pub manifest_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchView {
    pub outcome: Outcome,
    pub found: usize,
    pub targets: Vec<String>,
    pub sent: u32,
    pub send_errors: Vec<String>,
    pub socket_error: Option<String>,
    pub incompatible: Vec<String>,
    pub malformed: u32,
    pub elapsed_ms: u64,
}

struct Offering {
    _responder: Responder,
    _server: Option<PackageServer>,
    view: OfferView,
}

#[derive(Default)]
struct Inner {
    offering: Option<Offering>,
    offer_error: Option<String>,
    known: DiscoveredSet,
    manifests: HashMap<String, (Manifest, Option<String>)>,
    last_search: Option<SearchView>,
}

#[derive(Default)]
pub struct DeployService {
    inner: Mutex<Inner>,
}

const MANIFEST_TIMEOUT: Duration = Duration::from_secs(5);

impl DeployService {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Starts or stops offering this computer (see the module text). Restarting rebuilds the offer (new packages,
    /// another version after an update).
    pub fn set_offering(&self, copy: &ThisCopy, on: bool, port: u16) -> OfferView {
        let mut inner = self.lock();
        inner.offering = None;
        inner.offer_error = None;
        if !on {
            return OfferView::default();
        }
        match start_offering(copy, port) {
            Ok(offering) => {
                let view = offering.view.clone();
                inner.offering = Some(offering);
                view
            }
            Err(error) => {
                tracing::warn!(%error, "this computer can't offer its installation on the local network");
                inner.offer_error = Some(error.clone());
                OfferView {
                    on: true,
                    error: Some(error),
                    ..OfferView::default()
                }
            }
        }
    }

    pub fn offer(&self) -> OfferView {
        let inner = self.lock();
        match (&inner.offering, &inner.offer_error) {
            (Some(offering), _) => offering.view.clone(),
            (None, Some(error)) => OfferView {
                on: true,
                error: Some(error.clone()),
                ..OfferView::default()
            },
            (None, None) => OfferView::default(),
        }
    }

    /// One search on the local network (blocking: a few seconds), then the manifests of what was found.
    pub fn search(&self, options: &Options, copy: &ThisCopy) -> (SearchView, Vec<DeploymentView>) {
        let report = discover::discover(options);
        let now = Instant::now();
        let view = SearchView {
            outcome: report.outcome(),
            found: report.found.len(),
            targets: report.targets.iter().map(ToString::to_string).collect(),
            sent: report.sent,
            send_errors: report.send_errors.clone(),
            socket_error: report.socket_error.clone(),
            incompatible: report
                .incompatible
                .iter()
                .map(|i| {
                    format!(
                        "{} speaks deployment protocol {} (this program: {PROTOCOL}){}",
                        i.from,
                        i.protocol,
                        i.app_version
                            .as_deref()
                            .map(|v| format!(", OpenMind Studio {v}"))
                            .unwrap_or_default()
                    )
                })
                .collect(),
            malformed: report.malformed,
            elapsed_ms: report.elapsed.as_millis() as u64,
        };
        let adverts: Vec<(Advert, SocketAddr)> = report
            .found
            .into_iter()
            .map(|found| (found.advert, found.from))
            .collect();
        {
            let mut inner = self.lock();
            inner.known.prune(now, DEFAULT_TTL);
            for (advert, from) in &adverts {
                inner.known.observe(advert.clone(), *from, now);
            }
            inner.last_search = Some(view.clone());
        }
        // Manifests are fetched outside the lock (network).
        for (advert, from) in adverts {
            let fetched = manifest_of(&advert, from);
            self.lock()
                .manifests
                .insert(advert.deployment_id.clone(), fetched);
        }
        (view, self.deployments(copy))
    }

    pub fn last_search(&self) -> Option<SearchView> {
        self.lock().last_search.clone()
    }

    /// What is known now (stale sources dropped), as the UI shows it.
    pub fn deployments(&self, copy: &ThisCopy) -> Vec<DeploymentView> {
        let mut inner = self.lock();
        let now = Instant::now();
        for gone in inner.known.prune(now, DEFAULT_TTL) {
            inner.manifests.remove(&gone);
        }
        inner
            .known
            .list()
            .into_iter()
            .map(|deployment| {
                let (manifest, manifest_error) = inner
                    .manifests
                    .get(&deployment.advert.deployment_id)
                    .cloned()
                    .unwrap_or_else(|| (manifest_from_advert(&deployment.advert), None));
                DeploymentView {
                    id: deployment.advert.deployment_id.clone(),
                    incompatible: incompatibility(&manifest, copy),
                    manifest,
                    manifest_error,
                    sources: deployment
                        .sources
                        .iter()
                        .map(|s| SourceView {
                            address: s.address.ip().to_string(),
                            app_version: s.app_version.clone(),
                            seconds_ago: now.saturating_duration_since(s.last_seen).as_secs(),
                            serves_packages: s.http_port != 0,
                        })
                        .collect(),
                }
            })
            .collect()
    }

    /// The manifest and the package server to provision `id` from.
    pub fn provisioning_source(&self, id: &str) -> Result<(Manifest, Option<SocketAddr>), String> {
        let inner = self.lock();
        let deployment = inner
            .known
            .get(id)
            .ok_or("That deployment isn't known (any more): search the network again.")?;
        let manifest = inner
            .manifests
            .get(id)
            .map(|(manifest, _)| manifest.clone())
            .unwrap_or_else(|| manifest_from_advert(&deployment.advert));
        let server = deployment
            .best_source()
            .filter(|source| source.http_port != 0)
            .map(|source| SocketAddr::new(source.address.ip(), source.http_port));
        Ok((manifest, server))
    }
}

fn start_offering(copy: &ThisCopy, port: u16) -> Result<Offering, String> {
    let verifier = super::release_verifier()?;
    let offer = build_offer(copy, std::slice::from_ref(&copy.packages_dir), &verifier)?;
    let catalog = (!offer.files.is_empty())
        .then(|| Catalog::new(offer.manifest.clone(), offer.files.clone()))
        .transpose()?;
    let server = catalog
        .map(|catalog| PackageServer::start(SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)), catalog))
        .transpose()
        .map_err(|err| format!("the package server can't listen: {err}"))?;
    let http_port = server.as_ref().map_or(0, |s| s.address().port());
    let advert = offer.advert(&random_hex(8), http_port);
    let responder = Responder::start(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port, advert).map_err(|err| {
        format!(
            "UDP port {port} can't be opened for deployment discovery ({err}). Another program or a security policy \
             may be using or blocking it."
        )
    })?;
    let view = OfferView {
        on: true,
        discovery_address: Some(responder.address().to_string()),
        package_address: server.as_ref().map(|s| s.address().to_string()),
        kind: Some(offer.manifest.kind),
        deployment_id: Some(offer.manifest.deployment_id.clone()),
        packages: offer
            .manifest
            .packages
            .iter()
            .map(|p| p.name.clone())
            .collect(),
        runtimes: offer.manifest.runtimes.len(),
        problems: offer.problems,
        error: None,
    };
    Ok(Offering {
        _responder: responder,
        _server: server,
        view,
    })
}

/// A share that serves no packages has no manifest server: what its announcement says is its manifest.
fn manifest_from_advert(advert: &Advert) -> Manifest {
    Manifest {
        format: MANIFEST_FORMAT.into(),
        protocol: advert.protocol,
        deployment_id: advert.deployment_id.clone(),
        app_version: advert.app_version.clone(),
        platform: advert.platform.clone(),
        arch: advert.arch,
        kind: advert.kind,
        share_path: advert.share_path.clone(),
        packages: Vec::new(),
        runtimes: Vec::new(),
    }
}

fn manifest_of(advert: &Advert, from: SocketAddr) -> (Manifest, Option<String>) {
    if advert.http_port == 0 {
        return (manifest_from_advert(advert), None);
    }
    let server = SocketAddr::new(from.ip(), advert.http_port);
    match client::fetch_manifest(server, MANIFEST_TIMEOUT) {
        Ok(manifest) if manifest.deployment_id == advert.deployment_id => (manifest, None),
        Ok(_) => (
            manifest_from_advert(advert),
            Some(format!(
                "{server} answered with another deployment's manifest"
            )),
        ),
        Err(err) => (
            manifest_from_advert(advert),
            Some(format!(
                "the package list couldn't be read from {server}: {err}"
            )),
        ),
    }
}

/// Why this computer can't use a deployment, or `None`.
pub fn incompatibility(manifest: &Manifest, copy: &ThisCopy) -> Option<String> {
    let platform = openmind_deploy::this_platform();
    if manifest.platform != platform {
        return Some(format!(
            "it is for {}, this computer runs {platform}",
            manifest.platform
        ));
    }
    let runnable = copy.os_arch.runs(manifest.arch)
        || manifest.packages.iter().any(|p| copy.os_arch.runs(p.arch));
    (!runnable).then(|| {
        format!(
            "it is built for {}, which this computer's Windows ({}) can't run",
            manifest.arch.label(),
            copy.os_arch.label()
        )
    })
}

/// Where a share deployment's program is.
pub fn share_program(manifest: &Manifest) -> Option<PathBuf> {
    manifest
        .share_path
        .as_deref()
        .map(|share| PathBuf::from(share).join(super::inspect::PROGRAM))
}
