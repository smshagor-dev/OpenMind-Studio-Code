use encoding_rs::{UTF_16BE, UTF_16LE, WINDOWS_1252};

const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];
const UTF16LE_BOM: [u8; 2] = [0xFF, 0xFE];
const UTF16BE_BOM: [u8; 2] = [0xFE, 0xFF];

/// The text encoding a file was decoded from (or should be re-encoded to).
///
/// Detection is BOM-first: a byte-order mark unambiguously identifies UTF-8
/// (with BOM), UTF-16LE, or UTF-16BE. Without a BOM, content is validated as
/// UTF-8; content containing bytes that aren't valid UTF-8 falls back to
/// Windows-1252 (the conventional "ANSI" default on Windows, the platform
/// this project targets first) rather than attempting full statistical
/// charset detection, which is out of scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TextEncoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    Windows1252,
}

pub struct DecodedText {
    pub text: String,
    pub encoding: TextEncoding,
}

pub fn decode(bytes: &[u8]) -> DecodedText {
    if let Some(rest) = bytes.strip_prefix(&UTF8_BOM) {
        return DecodedText {
            text: String::from_utf8_lossy(rest).into_owned(),
            encoding: TextEncoding::Utf8Bom,
        };
    }
    if let Some(rest) = bytes.strip_prefix(&UTF16LE_BOM) {
        let (text, _, _) = UTF_16LE.decode(rest);
        return DecodedText {
            text: text.into_owned(),
            encoding: TextEncoding::Utf16Le,
        };
    }
    if let Some(rest) = bytes.strip_prefix(&UTF16BE_BOM) {
        let (text, _, _) = UTF_16BE.decode(rest);
        return DecodedText {
            text: text.into_owned(),
            encoding: TextEncoding::Utf16Be,
        };
    }

    match std::str::from_utf8(bytes) {
        Ok(text) => DecodedText {
            text: text.to_owned(),
            encoding: TextEncoding::Utf8,
        },
        Err(_) => {
            let (text, _, _) = WINDOWS_1252.decode(bytes);
            DecodedText {
                text: text.into_owned(),
                encoding: TextEncoding::Windows1252,
            }
        }
    }
}

pub fn encode(text: &str, encoding: TextEncoding) -> Vec<u8> {
    match encoding {
        TextEncoding::Utf8 => text.as_bytes().to_vec(),
        TextEncoding::Utf8Bom => {
            let mut out = Vec::with_capacity(UTF8_BOM.len() + text.len());
            out.extend_from_slice(&UTF8_BOM);
            out.extend_from_slice(text.as_bytes());
            out
        }
        TextEncoding::Utf16Le => encode_utf16(text, true),
        TextEncoding::Utf16Be => encode_utf16(text, false),
        TextEncoding::Windows1252 => {
            let (bytes, _, _) = WINDOWS_1252.encode(text);
            bytes.into_owned()
        }
    }
}

fn encode_utf16(text: &str, little_endian: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(2 + text.len() * 2);
    out.extend_from_slice(if little_endian {
        &UTF16LE_BOM
    } else {
        &UTF16BE_BOM
    });
    for unit in text.encode_utf16() {
        let unit_bytes = if little_endian {
            unit.to_le_bytes()
        } else {
            unit.to_be_bytes()
        };
        out.extend_from_slice(&unit_bytes);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_utf8_bom() {
        let mut bytes = UTF8_BOM.to_vec();
        bytes.extend_from_slice("hello".as_bytes());

        let decoded = decode(&bytes);

        assert_eq!(decoded.encoding, TextEncoding::Utf8Bom);
        assert_eq!(decoded.text, "hello");
    }

    #[test]
    fn detects_plain_utf8_without_bom() {
        let decoded = decode("héllo wörld".as_bytes());

        assert_eq!(decoded.encoding, TextEncoding::Utf8);
        assert_eq!(decoded.text, "héllo wörld");
    }

    #[test]
    fn detects_utf16le_bom() {
        let bytes = encode_utf16("hi", true);

        let decoded = decode(&bytes);

        assert_eq!(decoded.encoding, TextEncoding::Utf16Le);
        assert_eq!(decoded.text, "hi");
    }

    #[test]
    fn detects_utf16be_bom() {
        let bytes = encode_utf16("hi", false);

        let decoded = decode(&bytes);

        assert_eq!(decoded.encoding, TextEncoding::Utf16Be);
        assert_eq!(decoded.text, "hi");
    }

    #[test]
    fn falls_back_to_windows_1252_for_invalid_utf8() {
        // 0x93/0x94 are Windows-1252 "smart quotes", invalid as UTF-8 on
        // their own.
        let bytes = vec![0x93, b'h', b'i', 0x94];

        let decoded = decode(&bytes);

        assert_eq!(decoded.encoding, TextEncoding::Windows1252);
        assert_eq!(decoded.text, "\u{201C}hi\u{201D}");
    }

    #[test]
    fn round_trips_each_encoding() {
        for encoding in [
            TextEncoding::Utf8,
            TextEncoding::Utf8Bom,
            TextEncoding::Utf16Le,
            TextEncoding::Utf16Be,
            TextEncoding::Windows1252,
        ] {
            let original = "café";
            let bytes = encode(original, encoding);
            let decoded = decode(&bytes);

            assert_eq!(decoded.encoding, encoding, "encoding {encoding:?}");
            assert_eq!(decoded.text, original, "encoding {encoding:?}");
        }
    }
}
