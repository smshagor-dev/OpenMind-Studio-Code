//! `file://` URIs — what language servers use instead of paths. Paths with
//! spaces or non-ASCII characters are percent-encoded as UTF-8.

fn is_unreserved(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/')
}

/// `C:\My Site\a.ts` (or `C:/My Site/a.ts`, or `/home/me/a.ts`) → `file:///C:/My%20Site/a.ts`.
pub fn path_to_uri(path: &str) -> String {
    let unified = path.replace('\\', "/");
    let bytes = unified.as_bytes();
    let has_drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    let mut out = String::from("file://");
    if !unified.starts_with('/') {
        out.push('/');
    }
    for (index, byte) in bytes.iter().enumerate() {
        if is_unreserved(*byte) || (has_drive && index == 1 && *byte == b':') {
            out.push(char::from(*byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = text.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `file:///c%3A/My%20Site/a.ts` → `c:/My Site/a.ts` (forward slashes). Anything
/// that isn't a `file://` URI (e.g. `untitled:`) gives `None`.
pub fn uri_to_path(uri: &str) -> Option<String> {
    // Only an empty authority (`file:///...`) is supported, not `file://host/share`.
    let rest = uri.strip_prefix("file://")?;
    if !rest.starts_with('/') {
        return None;
    }
    let decoded = percent_decode(rest)?;
    let bytes = decoded.as_bytes();
    let drive =
        bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b':';
    Some(if drive {
        decoded[1..].to_string()
    } else {
        decoded
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_windows_path_with_spaces_round_trips() {
        let uri = path_to_uri(r"C:\My Site\src\a b.ts");
        assert_eq!(uri, "file:///C:/My%20Site/src/a%20b.ts");
        assert_eq!(uri_to_path(&uri).as_deref(), Some("C:/My Site/src/a b.ts"));
    }

    #[test]
    fn an_encoded_drive_colon_from_a_server_is_understood() {
        assert_eq!(
            uri_to_path("file:///c%3A/My%20Site/x.py").as_deref(),
            Some("c:/My Site/x.py")
        );
    }

    #[test]
    fn non_ascii_is_utf8_percent_encoded() {
        let uri = path_to_uri("C:/proj/ü.php");
        assert_eq!(uri, "file:///C:/proj/%C3%BC.php");
        assert_eq!(uri_to_path(&uri).as_deref(), Some("C:/proj/ü.php"));
    }

    #[test]
    fn unix_paths_keep_their_root() {
        let uri = path_to_uri("/home/me/a.py");
        assert_eq!(uri, "file:///home/me/a.py");
        assert_eq!(uri_to_path(&uri).as_deref(), Some("/home/me/a.py"));
    }

    #[test]
    fn other_schemes_bad_escapes_and_network_shares_are_refused() {
        assert_eq!(uri_to_path("untitled:Untitled-1"), None);
        assert_eq!(uri_to_path("file:///C:/a%zz"), None);
        assert_eq!(uri_to_path("file://server/share/a.ts"), None);
    }
}
