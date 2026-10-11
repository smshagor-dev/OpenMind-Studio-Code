//! What Windows Firewall will do with other computers' connections to this program — read-only. Participants can only
//! guess "blocked" from a failed connection; the Owner's computer can look at its own rules, so a room hosted on a
//! blocked computer can say so where it is hosted.
//!
//! One PowerShell query (`Get-NetConnectionProfile`, `Get-NetFirewallApplicationFilter -Program <this exe>`,
//! `Get-NetFirewallRule`; no administrator rights, enum names rather than localized text), with a time limit and no
//! window. Nothing is ever changed: no rule is added, enabled or removed, the firewall is never turned off.
//!
//! What it can't see: rules that match by port or service instead of program, and policies the computer's
//! administrator applies centrally; those show as "no rule for this program" (the honest answer from here).

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// The firewall's answer for the networks this computer is on now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FirewallVerdict {
    /// An enabled rule allows inbound connections to this program on every active network.
    Allowed,
    /// An enabled rule blocks it on an active network (a dismissed "allow access" prompt creates such rules).
    Blocked,
    /// No rule for this program covers an active network: Windows asks when it first listens (on a managed computer
    /// it may block without asking).
    NoRule,
    /// Not Windows, or the rules couldn't be read.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirewallStatus {
    pub verdict: FirewallVerdict,
    /// Categories of the connected networks (`public`, `private`, `domain`).
    pub networks: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RuleFacts {
    pub action: String,
    pub enabled: String,
    /// `Any`, or a comma-separated list such as `Private, Public`.
    pub profile: String,
}

fn category(network: &str) -> String {
    match network.to_ascii_lowercase().as_str() {
        "domainauthenticated" | "domain" => "domain".into(),
        "private" => "private".into(),
        _ => "public".into(),
    }
}

fn covers(rule: &RuleFacts, network: &str) -> bool {
    let profiles = rule.profile.to_ascii_lowercase();
    profiles.contains("any") || profiles.split(',').any(|p| p.trim() == network)
}

/// The verdict for inbound rules of this program on the connected networks (Block wins, as in Windows).
pub fn verdict(networks: &[String], rules: &[RuleFacts]) -> FirewallVerdict {
    let enabled: Vec<&RuleFacts> = rules
        .iter()
        .filter(|r| r.enabled.eq_ignore_ascii_case("true"))
        .collect();
    let mut all_allowed = !networks.is_empty();
    for network in networks {
        let matching: Vec<&&RuleFacts> = enabled.iter().filter(|r| covers(r, network)).collect();
        if matching
            .iter()
            .any(|r| r.action.eq_ignore_ascii_case("block"))
        {
            return FirewallVerdict::Blocked;
        }
        all_allowed &= matching
            .iter()
            .any(|r| r.action.eq_ignore_ascii_case("allow"));
    }
    if all_allowed {
        FirewallVerdict::Allowed
    } else {
        FirewallVerdict::NoRule
    }
}

#[derive(Deserialize)]
struct Report {
    #[serde(default)]
    networks: Vec<String>,
    #[serde(default)]
    rules: Vec<RuleFacts>,
}

/// Reads the rules for `program` (blocking, at most `limit`). `Unknown` off Windows or when anything fails.
pub fn check(program: &Path, limit: Duration) -> FirewallStatus {
    let unknown = FirewallStatus {
        verdict: FirewallVerdict::Unknown,
        networks: Vec::new(),
    };
    let Some(output) = query(program, limit) else {
        return unknown;
    };
    let Ok(report) = serde_json::from_str::<Report>(output.trim()) else {
        return unknown;
    };
    let mut networks: Vec<String> = report.networks.iter().map(|n| category(n)).collect();
    networks.sort();
    networks.dedup();
    FirewallStatus {
        verdict: verdict(&networks, &report.rules),
        networks,
    }
}

#[cfg(windows)]
fn query(program: &Path, limit: Duration) -> Option<String> {
    use base64::Engine as _;
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let exe = program.to_string_lossy().replace('\'', "''");
    let script = format!(
        "$ErrorActionPreference='SilentlyContinue'; \
         $n=@(Get-NetConnectionProfile | ForEach-Object {{ $_.NetworkCategory.ToString() }}); \
         $r=@(Get-NetFirewallApplicationFilter -Program '{exe}' | Get-NetFirewallRule | \
              Where-Object {{ $_.Direction.ToString() -eq 'Inbound' }} | \
              ForEach-Object {{ [pscustomobject]@{{ action=$_.Action.ToString(); enabled=$_.Enabled.ToString(); profile=$_.Profile.ToString() }} }}); \
         [pscustomobject]@{{ networks=$n; rules=$r }} | ConvertTo-Json -Compress -Depth 3"
    );
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
    let mut child = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50))
            }
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
    let mut out = String::new();
    std::io::Read::read_to_string(&mut child.stdout.take()?, &mut out).ok()?;
    Some(out)
}

#[cfg(not(windows))]
fn query(_program: &Path, _limit: Duration) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(action: &str, enabled: &str, profile: &str) -> RuleFacts {
        RuleFacts {
            action: action.into(),
            enabled: enabled.into(),
            profile: profile.into(),
        }
    }

    #[test]
    fn block_wins_and_a_private_only_allow_does_not_cover_a_public_network() {
        let public = vec!["public".to_string()];
        assert_eq!(verdict(&public, &[]), FirewallVerdict::NoRule);
        assert_eq!(
            verdict(&public, &[rule("Allow", "True", "Private")]),
            FirewallVerdict::NoRule,
            "allowed on private only"
        );
        assert_eq!(
            verdict(&public, &[rule("Allow", "True", "Private, Public")]),
            FirewallVerdict::Allowed
        );
        assert_eq!(
            verdict(&public, &[rule("Allow", "True", "Any")]),
            FirewallVerdict::Allowed
        );
        assert_eq!(
            verdict(
                &public,
                &[
                    rule("Allow", "True", "Any"),
                    rule("Block", "True", "Public")
                ]
            ),
            FirewallVerdict::Blocked
        );
        assert_eq!(
            verdict(&public, &[rule("Block", "False", "Public")]),
            FirewallVerdict::NoRule,
            "a disabled rule doesn't count"
        );
        let both = vec!["private".to_string(), "public".to_string()];
        assert_eq!(
            verdict(&both, &[rule("Allow", "True", "Private")]),
            FirewallVerdict::NoRule
        );
        assert_eq!(category("DomainAuthenticated"), "domain");
    }

    #[test]
    fn reading_this_computers_rules_never_fails_loudly() {
        let status = check(Path::new("C:/no/such/program.exe"), Duration::from_secs(15));
        // Either the rules were read (no rule for a program that doesn't exist) or they couldn't be (unknown).
        assert!(
            matches!(
                status.verdict,
                FirewallVerdict::NoRule | FirewallVerdict::Unknown | FirewallVerdict::Allowed
            ),
            "{status:?}"
        );
    }
}
