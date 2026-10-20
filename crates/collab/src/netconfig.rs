//! Collaboration network settings: the signaling relay, STUN servers and TURN relays (with TURN over TLS and port
//! 443 for networks that only allow web traffic). An empty value means "not configured" here; the network layer then
//! uses its built-in public MQTT brokers for signaling and public STUN servers (`openmind_collab_net`), never a TURN. The TURN password never lives here — the app stores it
//! encrypted and the TURN client asks for it when an allocation starts (`openmind_collab_net::turn::
//! TurnCredentialSource`); a short-lived credential service is another source, without touching the transport.

use serde::Serialize;

/// The parsed settings, plus every value that was ignored and why.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetConfig {
    pub signaling_url: Option<String>,
    pub stun_urls: Vec<String>,
    pub turn_urls: Vec<String>,
    pub turn_username: Option<String>,
    pub issues: Vec<ConfigIssue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigIssue {
    pub setting: &'static str,
    pub value: String,
    pub reason: String,
}

impl NetConfig {
    /// Parses the raw setting values (`stun`/`turn` are comma-separated lists).
    pub fn parse(signaling: &str, stun: &str, turn: &str, turn_username: &str) -> Self {
        let mut issues = Vec::new();
        let signaling_url = match check_signaling(signaling.trim()) {
            Ok(url) => url,
            Err(reason) => {
                issues.push(issue("collaboration.signalingUrl", signaling, reason));
                None
            }
        };
        let stun_urls = list(
            stun,
            &["stun", "stuns"],
            "collaboration.stunUrls",
            &mut issues,
        );
        let turn_urls = list(
            turn,
            &["turn", "turns"],
            "collaboration.turnUrls",
            &mut issues,
        );
        let username = turn_username.trim();
        let turn_username = (!username.is_empty()).then(|| username.to_string());
        if !turn_urls.is_empty() && turn_username.is_none() {
            issues.push(issue(
                "collaboration.turnUsername",
                "",
                "TURN servers need a user name.".into(),
            ));
        }
        Self {
            signaling_url,
            stun_urls,
            turn_urls,
            turn_username,
            issues,
        }
    }

    /// Whether remote rooms can be reached at all (a signaling relay is set).
    pub fn can_connect_remotely(&self) -> bool {
        self.signaling_url.is_some()
    }
}

fn issue(setting: &'static str, value: &str, reason: String) -> ConfigIssue {
    ConfigIssue {
        setting,
        value: value.trim().chars().take(200).collect(),
        reason,
    }
}

fn is_loopback(host: &str) -> bool {
    matches!(
        host.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "[::1]"
    )
}

fn check_host(host: &str) -> Result<(), String> {
    if host.is_empty() {
        return Err("The address has no host.".into());
    }
    if host.contains('@') {
        return Err("Put credentials in their own setting, not in the address.".into());
    }
    if host
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '/' | '\\' | '?' | '#'))
    {
        return Err("The host contains characters an address can't have.".into());
    }
    Ok(())
}

/// Splits `host[:port]` and checks the port.
fn check_authority(authority: &str) -> Result<(), String> {
    let (host, port) = if authority.starts_with('[') {
        match authority.split_once(']') {
            Some((h, rest)) => (format!("{h}]"), rest.strip_prefix(':')),
            None => return Err("An IPv6 address must end with \"]\".".into()),
        }
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), Some(p)),
            None => (authority.to_string(), None),
        }
    };
    check_host(&host)?;
    if let Some(port) = port {
        match port.parse::<u16>() {
            Ok(p) if p > 0 => {}
            _ => return Err(format!("\"{port}\" is not a port number.")),
        }
    }
    Ok(())
}

fn check_signaling(text: &str) -> Result<Option<String>, String> {
    if text.is_empty() {
        return Ok(None);
    }
    let lower = text.to_ascii_lowercase();
    let (secure, rest) = if lower.starts_with("wss://") {
        (true, &text[6..])
    } else if lower.starts_with("ws://") {
        (false, &text[5..])
    } else {
        return Err(
            "The signaling address must start with wss:// (or ws:// on this computer).".into(),
        );
    };
    let authority = rest.split(['/', '?']).next().unwrap_or("");
    check_authority(authority)?;
    let host = authority.rsplit_once(':').map_or(authority, |(h, _)| h);
    if !secure && !is_loopback(host) {
        return Err(
            "Unencrypted ws:// is only allowed for a relay on this computer; use wss://.".into(),
        );
    }
    Ok(Some(text.to_string()))
}

fn check_ice(entry: &str, schemes: &[&str]) -> Result<String, String> {
    let (scheme, rest) = entry
        .split_once(':')
        .ok_or_else(|| format!("Expected {}:host[:port].", schemes[0]))?;
    let scheme_lower = scheme.to_ascii_lowercase();
    if !schemes.contains(&scheme_lower.as_str()) {
        return Err(format!("Use {} addresses here.", schemes.join(" or ")));
    }
    let rest = rest.trim_start_matches("//");
    let (authority, query) = rest.split_once('?').unwrap_or((rest, ""));
    check_authority(authority)?;
    if !query.is_empty() {
        let turn = scheme_lower.starts_with("turn");
        if !turn
            || !matches!(
                query.to_ascii_lowercase().as_str(),
                "transport=udp" | "transport=tcp"
            )
        {
            return Err("Only ?transport=udp or ?transport=tcp is allowed (TURN only).".into());
        }
    }
    Ok(format!("{scheme_lower}:{rest}"))
}

fn list(
    text: &str,
    schemes: &[&str],
    setting: &'static str,
    issues: &mut Vec<ConfigIssue>,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for entry in text.split(',').map(str::trim).filter(|e| !e.is_empty()) {
        match check_ice(entry, schemes) {
            Ok(url) if !out.contains(&url) => out.push(url),
            Ok(_) => {}
            Err(reason) => issues.push(issue(setting, entry, reason)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_is_configured_by_default() {
        let config = NetConfig::parse("", "", "", "");
        assert_eq!(config, NetConfig::default());
        assert!(!config.can_connect_remotely());
    }

    #[test]
    fn valid_values_including_turn_over_tls_on_443() {
        let config = NetConfig::parse(
            "wss://signal.example.org/rooms",
            "stun:stun.example.org:3478, stun:stun.example.org:3478",
            "turn:turn.example.org:3478?transport=udp, turns:turn.example.org:443?transport=tcp",
            "classroom",
        );
        assert_eq!(config.issues, vec![]);
        assert_eq!(config.stun_urls.len(), 1, "duplicates collapse");
        assert_eq!(
            config.turn_urls[1],
            "turns:turn.example.org:443?transport=tcp"
        );
        assert!(config.can_connect_remotely());
        let local = NetConfig::parse("ws://127.0.0.1:8787", "", "", "");
        assert_eq!(local.signaling_url.as_deref(), Some("ws://127.0.0.1:8787"));
    }

    #[test]
    fn unsafe_or_malformed_values_are_ignored_with_a_reason() {
        let config = NetConfig::parse(
            "ws://signal.example.org",
            "turn:wrong.example.org, stun:user:pw@host, stun:host:99999, stun:host?transport=tcp",
            "turns:turn.example.org:443?evil=1, http://x",
            "",
        );
        assert!(config.signaling_url.is_none());
        assert!(config.stun_urls.is_empty() && config.turn_urls.is_empty());
        assert_eq!(config.issues.len(), 7);
        let https = NetConfig::parse("https://x", "", "turn:t.example.org", "");
        assert!(https
            .issues
            .iter()
            .any(|i| i.setting == "collaboration.signalingUrl"));
        assert!(https
            .issues
            .iter()
            .any(|i| i.setting == "collaboration.turnUsername"));
    }
}
