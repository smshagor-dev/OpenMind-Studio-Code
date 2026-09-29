//! What the Network window tells the user about the proxy settings: an address that is ignored and why, a PAC
//! script or automatic detection OpenMind can't evaluate, a SOCKS proxy some tools can't use, credentials that are
//! missing or unreadable. Pure: built from the resolved proxy, so the backend and the UI agree on what is ignored.

use serde::Serialize;

use crate::proxy::{ProxyProblem, ResolvedProxy};

/// One thing about the proxy settings the user should know. The UI turns it into a sentence in its language.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum Diagnostic {
    /// An address in the settings (or the environment) is not used, and why.
    IgnoredField {
        field: String,
        problem: ProxyProblem,
    },
    /// Windows uses a proxy auto-configuration script; OpenMind doesn't run PAC scripts.
    PacNotEvaluated { url: String },
    /// Windows is set to detect the proxy automatically (WPAD); OpenMind doesn't do that lookup.
    AutoDetectNotEvaluated,
    /// Only a SOCKS proxy is set: tools that read HTTP_PROXY/HTTPS_PROXY (pip, npm, Cargo) won't use it.
    SocksOnly,
    /// A proxy is in force but no user name and password are saved (fine unless the proxy answers 407).
    NoCredentials,
    /// Saved credentials exist but can't be read (another Windows user, or damaged). `in_use`: a proxy is in force, so
    /// requests go without them (a warning); otherwise it's only worth knowing.
    CredentialsUnreadable { in_use: bool },
}

impl Diagnostic {
    /// `warning`: something is ignored or can't work; `info`: worth knowing.
    pub fn severity(&self) -> &'static str {
        match self {
            Diagnostic::NoCredentials | Diagnostic::CredentialsUnreadable { in_use: false } => {
                "info"
            }
            _ => "warning",
        }
    }
}

/// Everything worth telling about `proxy`, most important first.
pub fn diagnose_settings(
    proxy: &ResolvedProxy,
    has_credentials: bool,
    credentials_unreadable: bool,
) -> Vec<Diagnostic> {
    let mut out: Vec<Diagnostic> = proxy
        .problems
        .iter()
        .map(|(field, problem)| Diagnostic::IgnoredField {
            field: field.clone(),
            problem: *problem,
        })
        .collect();
    if credentials_unreadable {
        out.push(Diagnostic::CredentialsUnreadable {
            in_use: proxy.active(),
        });
    }
    if let Some(url) = &proxy.pac_url {
        out.push(Diagnostic::PacNotEvaluated { url: url.clone() });
    }
    if proxy.auto_detect {
        out.push(Diagnostic::AutoDetectNotEvaluated);
    }
    if proxy.socks.is_some() && proxy.http.is_none() && proxy.https.is_none() {
        out.push(Diagnostic::SocksOnly);
    }
    if proxy.active() && !has_credentials && !credentials_unreadable {
        out.push(Diagnostic::NoCredentials);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy::{resolve_manual, ProxySettings};

    #[test]
    fn an_address_with_credentials_in_settings_json_is_reported_as_ignored() {
        // What a hand-edited settings.json can hold: the backend never uses it, and says so.
        let proxy = resolve_manual(&ProxySettings {
            http: "proxy.uni:3128".into(),
            https: "http://ivan:s3cret@proxy.uni:3128".into(),
            ..ProxySettings::default()
        });
        let found = diagnose_settings(&proxy, true, false);
        assert_eq!(
            found,
            vec![Diagnostic::IgnoredField {
                field: "https".into(),
                problem: ProxyProblem::CredentialsInAddress
            }]
        );
        let json = serde_json::to_string(&found).expect("json");
        assert_eq!(
            json,
            r#"[{"kind":"ignoredField","field":"https","problem":"credentialsInAddress"}]"#
        );
        assert!(
            !json.contains("s3cret"),
            "a diagnostic never carries the address itself"
        );
    }

    #[test]
    fn scheme_port_pac_autodetect_socks_and_credentials_are_all_reported() {
        let proxy = resolve_manual(&ProxySettings {
            http: "ftp://p:21".into(),
            https: "p:99999".into(),
            socks: "socks5://s:1080".into(),
            ..ProxySettings::default()
        });
        let found = diagnose_settings(&proxy, false, false);
        assert!(found.contains(&Diagnostic::IgnoredField {
            field: "http".into(),
            problem: ProxyProblem::UnsupportedScheme
        }));
        assert!(found.contains(&Diagnostic::IgnoredField {
            field: "https".into(),
            problem: ProxyProblem::BadPort
        }));
        assert!(found.contains(&Diagnostic::SocksOnly));
        assert!(found.contains(&Diagnostic::NoCredentials));
        let mut system = ResolvedProxy::off();
        system.pac_url = Some("http://wpad/wpad.dat".into());
        system.auto_detect = true;
        assert_eq!(
            diagnose_settings(&system, false, true),
            vec![
                Diagnostic::CredentialsUnreadable { in_use: false },
                Diagnostic::PacNotEvaluated {
                    url: "http://wpad/wpad.dat".into()
                },
                Diagnostic::AutoDetectNotEvaluated,
            ]
        );
        // Nothing to say about a working proxy with saved credentials, or no proxy at all.
        let fine = resolve_manual(&ProxySettings {
            http: "proxy:3128".into(),
            ..ProxySettings::default()
        });
        assert!(diagnose_settings(&fine, true, false).is_empty());
        assert!(diagnose_settings(&ResolvedProxy::off(), false, false).is_empty());
        assert_eq!(Diagnostic::NoCredentials.severity(), "info");
        assert_eq!(Diagnostic::SocksOnly.severity(), "warning");
        // Unreadable credentials matter when a proxy is in force (requests go without them), not in No Proxy mode.
        assert_eq!(
            diagnose_settings(&fine, false, true),
            vec![Diagnostic::CredentialsUnreadable { in_use: true }]
        );
        assert_eq!(
            Diagnostic::CredentialsUnreadable { in_use: true }.severity(),
            "warning"
        );
        assert_eq!(
            Diagnostic::CredentialsUnreadable { in_use: false }.severity(),
            "info"
        );
    }
}
