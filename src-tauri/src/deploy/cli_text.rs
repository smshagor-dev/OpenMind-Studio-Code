//! Plain-text output of `--deploy` (see `cli.rs`): what a person reads in a console.

use super::checks::{Status, TestReport};
use super::exec::Outcome;
use super::service::{DeploymentView, OfferView, SearchView};

pub fn search(search: &SearchView, deployments: &[DeploymentView]) -> String {
    let mut lines = vec![format!(
        "Search: {:?} — {} queries to {} address(es) in {} ms",
        search.outcome,
        search.sent,
        search.targets.len(),
        search.elapsed_ms
    )];
    lines.extend(
        search
            .send_errors
            .iter()
            .map(|e| format!("  could not send: {e}")),
    );
    lines.extend(
        search
            .socket_error
            .iter()
            .map(|e| format!("  no socket: {e}")),
    );
    lines.extend(
        search
            .incompatible
            .iter()
            .map(|e| format!("  incompatible: {e}")),
    );
    if deployments.is_empty() {
        lines.push("No deployment found.".into());
    }
    for d in deployments {
        let m = &d.manifest;
        lines.push(format!(
            "{}  {:?}  OpenMind Studio {} ({} {})",
            d.id,
            m.kind,
            m.app_version,
            m.platform,
            m.arch.label()
        ));
        if let Some(share) = &m.share_path {
            lines.push(format!("    shared installation: {share}"));
        }
        for p in &m.packages {
            lines.push(format!("    package: {} ({} bytes)", p.name, p.size));
        }
        if !m.runtimes.is_empty() {
            let names: Vec<String> = m
                .runtimes
                .iter()
                .map(|r| format!("{} {}", r.kind, r.version))
                .collect();
            lines.push(format!("    ready runtimes: {}", names.join(", ")));
        }
        for s in &d.sources {
            lines.push(format!(
                "    source: {} (OpenMind Studio {}, {} s ago)",
                s.address, s.app_version, s.seconds_ago
            ));
        }
        lines.extend(
            d.incompatible
                .iter()
                .map(|r| format!("    can't be used here: {r}")),
        );
        lines.extend(d.manifest_error.iter().map(|r| format!("    {r}")));
    }
    lines.join("\n")
}

pub fn report(report: &TestReport) -> String {
    let mut lines = vec!["OpenMind Studio — Network Deployment Test".to_string()];
    for check in &report.checks {
        let status = match check.status {
            Status::Pass => "PASS   ",
            Status::Fail => "FAIL   ",
            Status::Blocked => "BLOCKED",
        };
        lines.push(format!("  {status}  {:<26} {}", check.id, check.detail));
    }
    lines.push(format!(
        "{} passed, {} failed, {} blocked",
        report.passed, report.failed, report.blocked
    ));
    lines.join("\n")
}

pub fn offer(offer: &OfferView) -> String {
    let mut lines = vec![format!(
        "Offering {:?} {} on {}",
        offer.kind,
        offer.deployment_id.as_deref().unwrap_or("-"),
        offer.discovery_address.as_deref().unwrap_or("-")
    )];
    if let Some(address) = &offer.package_address {
        lines.push(format!(
            "  packages served on {address}: {}",
            offer.packages.join(", ")
        ));
    }
    lines.push(format!("  ready runtimes announced: {}", offer.runtimes));
    lines.extend(offer.problems.iter().map(|p| format!("  left out: {p}")));
    lines.join("\n")
}

pub fn outcome(outcome: &Outcome) -> String {
    let mut lines = vec![format!(
        "Done: {} — {} {}",
        outcome.action,
        outcome.program.display(),
        outcome.version
    )];
    lines.extend(outcome.steps.iter().map(|s| format!("  {s}")));
    if let Some(shortcut) = &outcome.shortcut {
        lines.push(format!("  shortcut: {shortcut}"));
    }
    lines.push(format!("  this computer's data: {}", outcome.data_location));
    lines.join("\n")
}
