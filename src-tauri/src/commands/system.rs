use std::process::Command;

/// Opens an `http(s)` address in the user's default browser. Anything else is
/// refused, and the address is passed to the OS handler as one argument
/// without going through a shell, so it can't be used to run anything.
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let url = validate_external_url(&url)?;
    spawn_browser(&url).map_err(|err| format!("couldn't open the browser: {err}"))
}

/// What may be opened from the app: a web address, or a plain `mailto:` address (no query, no extra headers).
pub fn validate_external_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    if trimmed.to_ascii_lowercase().starts_with("mailto:") {
        let address = &trimmed["mailto:".len()..];
        let ok_char = |c: char| c.is_ascii_alphanumeric() || "._%+-".contains(c);
        let valid = address.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && local.chars().all(ok_char)
                && domain.contains('.')
                && domain
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-.".contains(c))
        }) && address.len() <= 254;
        return if valid {
            Ok(trimmed.to_string())
        } else {
            Err("That email address can't be opened safely.".into())
        };
    }
    validate_web_url(trimmed)
}

/// Accepts only plain `http://` / `https://` URLs made of URL-safe characters.
pub fn validate_web_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("Only http and https addresses can be opened.".into());
    }
    let allowed = |c: char| c.is_ascii_alphanumeric() || "-._~:/?#[]@!$&'()*+,;=%".contains(c);
    if trimmed.len() > 2048 || !trimmed.chars().all(allowed) {
        return Err("That address contains characters that can't be opened safely.".into());
    }
    Ok(trimmed.to_string())
}

#[cfg(windows)]
fn spawn_browser(url: &str) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    // FileProtocolHandler takes the URL as data; no shell parses it.
    Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .spawn()
        .map(drop)
}

#[cfg(target_os = "macos")]
fn spawn_browser(url: &str) -> std::io::Result<()> {
    Command::new("open").arg(url).spawn().map(drop)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_browser(url: &str) -> std::io::Result<()> {
    Command::new("xdg-open").arg(url).spawn().map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_web_addresses_are_accepted() {
        for url in [
            "http://localhost:3000",
            "https://example.com/a/b?x=1&y=2#top",
            "  http://127.0.0.1:8080/  ",
        ] {
            assert!(validate_web_url(url).is_ok(), "{url}");
        }
    }

    #[test]
    fn anything_that_is_not_http_or_could_smuggle_a_command_is_refused() {
        for url in [
            "file:///C:/Windows/System32/cmd.exe",
            "javascript:alert(1)",
            "ftp://example.com",
            "calc.exe",
            "http://x.com/ & calc",
            "http://x.com/\"; calc; \"",
            "http://x.com/\nmalware",
            "http://x.com/|dir",
            "",
        ] {
            assert!(validate_web_url(url).is_err(), "{url:?}");
        }
    }

    #[test]
    fn a_plain_mailto_address_is_accepted_and_anything_else_with_mailto_is_not() {
        assert!(validate_external_url("mailto:smshagor.dev@gmail.com").is_ok());
        for bad in [
            "mailto:",
            "mailto:a@b",
            "mailto:a@b.com?subject=x",
            "mailto:a b@c.com",
            "mailto:a@b.com&calc",
            "mailto:a@b.com
malware",
        ] {
            assert!(validate_external_url(bad).is_err(), "{bad:?}");
        }
        assert!(validate_external_url("https://t.me/smshagor1").is_ok());
        assert!(validate_external_url("file:///C:/x").is_err());
    }
}
