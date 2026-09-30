//! Removing proxy credentials from anything that is shown, logged or copied.

use crate::proxy::Credentials;

/// `https://user:pw@host/path?token=x#y` -> `https://host/path`.
pub fn log_url(address: &str) -> String {
    let (scheme, rest) = match address.split_once("://") {
        Some((scheme, rest)) => (Some(scheme), rest),
        None => (None, address),
    };
    let rest = rest.split(['?', '#']).next().unwrap_or_default();
    let (authority, path) = match rest.find('/') {
        Some(index) => rest.split_at(index),
        None => (rest, ""),
    };
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    match scheme {
        Some(scheme) => format!("{scheme}://{host}{path}"),
        None => format!("{host}{path}"),
    }
}

/// Every `http://` / `https://` address inside `text` cleaned like [`log_url`].
pub fn log_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        let next = ["https://", "http://"]
            .iter()
            .filter_map(|scheme| rest.find(scheme))
            .min();
        let Some(start) = next else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let end = tail
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ')' | '>' | '<' | ','))
            .unwrap_or(tail.len());
        out.push_str(&log_url(&tail[..end]));
        rest = &tail[end..];
    }
}

/// Replaces the password of every `scheme://user:password@host` in `text` with `****`, and every literal occurrence
/// of the known password (and its percent-encoded form) too.
pub fn redact(text: &str, credentials: Option<&Credentials>) -> String {
    let mut out = redact_userinfo(text);
    if let Some(creds) = credentials.filter(|c| !c.password.is_empty()) {
        out = out.replace(&creds.password, "****");
        let encoded: String = creds
            .password
            .bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect();
        out = out.replace(&encoded, "****");
    }
    out
}

fn redact_userinfo(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("://") {
        let (head, tail) = rest.split_at(at + 3);
        out.push_str(head);
        let end = tail
            .find(|c: char| c.is_whitespace() || matches!(c, '/' | '"' | '\'' | ',' | ';'))
            .unwrap_or(tail.len());
        let authority = &tail[..end];
        match authority.rsplit_once('@') {
            Some((userinfo, host)) => {
                let user = userinfo.split_once(':').map_or(userinfo, |(user, _)| user);
                out.push_str(&format!("{user}:****@{host}"));
            }
            None => out.push_str(authority),
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

/// The environment as shown to the user (Show Current Terminal Proxy Environment): passwords replaced.
pub fn redact_env(
    vars: &[(String, String)],
    credentials: Option<&Credentials>,
) -> Vec<(String, String)> {
    vars.iter()
        .map(|(name, value)| (name.clone(), redact(value, credentials)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_lose_their_passwords_but_keep_the_user_and_host() {
        assert_eq!(
            redact(
                "HTTPS_PROXY=http://ivan:s3cret@proxy:3128 and ftp://x",
                None
            ),
            "HTTPS_PROXY=http://ivan:****@proxy:3128 and ftp://x"
        );
        assert_eq!(
            redact("http://proxy:3128/path", None),
            "http://proxy:3128/path"
        );
        assert_eq!(redact("no url here", None), "no url here");
    }

    #[test]
    fn the_known_password_is_removed_anywhere_in_plain_and_encoded_form() {
        let creds = Credentials {
            username: "ivan".into(),
            password: "p@ss w".into(),
        };
        let text = "error: proxy said 407 for p@ss w (sent p%40ss%20w)";
        let out = redact(text, Some(&creds));
        assert!(
            !out.contains("p@ss w") && !out.contains("p%40ss%20w"),
            "{out}"
        );
        let vars = redact_env(
            &[("HTTP_PROXY".into(), "http://ivan:p%40ss%20w@p:1".into())],
            Some(&creds),
        );
        assert_eq!(vars[0].1, "http://ivan:****@p:1");
    }
}
