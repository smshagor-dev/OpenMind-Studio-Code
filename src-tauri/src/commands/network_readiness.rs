//! The parts of the network diagnostics that say, per package tool, whether OpenMind routes it and why not — built
//! from the variable *names* an OpenMind terminal gets (their values carry the gateway token and are never written).

use openmind_broker::env::Skipped;
use openmind_broker::{BrokerEvent, Phase};
use serde_json::{json, Value};

/// The variable that shows a tool is routed, per tool (the first one present wins).
const ROUTES: &[(&str, &[&str], &str)] = &[
    ("pip", &["PIP_INDEX_URL"], "gateway /pypi, files through the broker with SHA-256 checks"),
    (
        "npm",
        &["NPM_CONFIG_GLOBALCONFIG"],
        "OpenMind's npm configuration: the gateway's npm port with its token; tarballs through the broker",
    ),
    (
        "pnpm",
        &["NPM_CONFIG_USERCONFIG", "PNPM_CONFIG_HTTPS_PROXY"],
        "OpenMind's npm configuration, or the gateway tunnel when you have your own .npmrc",
    ),
    ("yarn", &["YARN_HTTPS_PROXY"], "gateway tunnel (TLS by Yarn)"),
    ("go", &["GOPROXY"], "gateway /go, module zips through the broker, checksum database through the gateway"),
    ("cargo", &["CARGO_HTTP_PROXY"], "gateway tunnel (TLS by Cargo)"),
    ("rustup", &["RUSTUP_DIST_SERVER"], "gateway /rustup, archives through the broker with SHA-256 checks"),
    (
        "composer",
        &["OPENMIND_COMPOSER_PROXY"],
        "OpenMind's composer launcher: gateway tunnel (TLS by Composer), OpenMind's or your own Composer",
    ),
    (
        "git",
        &["GIT_CONFIG_COUNT"],
        "https remotes through gateway /git (clone, fetch, pull, push); your credential helper answers for the real host",
    ),
];

/// Per tool: `routed` (with how), `skipped` (your own configuration, with the reason), `off` (the setting is off) or
/// `unavailable` (the gateway isn't running). Git over SSH is never routed and is reported under `gitSsh`.
pub fn provider_readiness(
    enabled: bool,
    running: bool,
    vars: &[(String, String)],
    skipped: &[Skipped],
) -> Value {
    let map: serde_json::Map<String, Value> = ROUTES
        .iter()
        .map(|(tool, names, how)| {
            let entry = if !enabled {
                json!({ "state": "off", "reason": "Route Package Downloads Through OpenMind is off" })
            } else if !running {
                json!({ "state": "unavailable", "reason": "the package gateway is not running" })
            } else if let Some(skip) = skipped.iter().find(|s| s.tool == *tool) {
                json!({ "state": "skipped", "reason": skip.reason })
            } else if let Some(name) = names
                .iter()
                .find(|name| vars.iter().any(|(var, _)| var == *name))
            {
                json!({ "state": "routed", "via": name, "how": how })
            } else {
                json!({ "state": "unavailable", "reason": "no route was set for this terminal environment" })
            };
            (tool.to_string(), entry)
        })
        .collect();
    map.into()
}

/// The most recent failed broker operation: tool, category and stage (the message is left out — it's in the log).
pub fn last_failure(recent: &[BrokerEvent]) -> Value {
    recent
        .iter()
        .find(|event| event.phase == Phase::Failed)
        .map_or(Value::Null, |event| {
            json!({
                "provider": event.provider,
                "category": event.failure,
                "artifact": openmind_broker::redact::url(&event.artifact),
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use openmind_broker::{FailureKind, Provider};

    fn vars(names: &[&str]) -> Vec<(String, String)> {
        names
            .iter()
            .map(|name| {
                (
                    name.to_string(),
                    "http://127.0.0.1:1/SECRET-TOKEN/x".to_string(),
                )
            })
            .collect()
    }

    #[test]
    fn readiness_names_the_variable_never_its_value() {
        let skipped = [Skipped {
            tool: "go",
            reason: "GOPROXY is set".into(),
        }];
        let ready = provider_readiness(
            true,
            true,
            &vars(&[
                "PIP_INDEX_URL",
                "GOPROXY",
                "PNPM_CONFIG_HTTPS_PROXY",
                "GIT_CONFIG_COUNT",
            ]),
            &skipped,
        );
        assert_eq!(ready["pip"]["state"], "routed");
        assert_eq!(ready["pip"]["via"], "PIP_INDEX_URL");
        assert_eq!(ready["pnpm"]["via"], "PNPM_CONFIG_HTTPS_PROXY");
        assert_eq!(ready["go"]["state"], "skipped");
        assert_eq!(ready["go"]["reason"], "GOPROXY is set");
        assert_eq!(ready["cargo"]["state"], "unavailable");
        assert_eq!(ready["git"]["state"], "routed");
        assert!(!ready.to_string().contains("SECRET-TOKEN"));
        assert_eq!(
            provider_readiness(false, true, &vars(&["PIP_INDEX_URL"]), &[])["pip"]["state"],
            "off"
        );
        assert_eq!(
            provider_readiness(true, false, &vars(&["PIP_INDEX_URL"]), &[])["pip"]["state"],
            "unavailable"
        );
    }

    #[test]
    fn the_last_failure_is_the_newest_failed_operation_without_its_query() {
        let event = |id, phase, failure| BrokerEvent {
            id,
            provider: Provider::Npm,
            artifact: "https://h.example/a.tgz?sig=SECRET".into(),
            phase,
            bytes: 0,
            total: None,
            speed: 0,
            retry: None,
            failure,
            detail: Some("SECRET detail".into()),
        };
        assert_eq!(last_failure(&[]), Value::Null);
        let recent = [
            event(3, Phase::Complete, None),
            event(2, Phase::Failed, Some(FailureKind::Certificate)),
            event(1, Phase::Failed, Some(FailureKind::Dns)),
        ];
        let last = last_failure(&recent);
        assert_eq!(last["category"], "certificate");
        assert_eq!(last["provider"], "npm");
        assert!(!last.to_string().contains("SECRET"));
    }
}
