//! Names of ZIP entries written without the UTF-8 flag. The ZIP format says such names are code page 437, and the
//! `zip` crate decodes them that way, but archives made on a Russian Windows store them in the OEM code page 866
//! (PascalABC.NET's `PABCNETC.zip` has `Lib/Мозаика.pcu`). A manifest names the encoding of its artifact; names
//! that carry the UTF-8 flag, and plain ASCII names, are never changed.

use serde::{Deserialize, Serialize};

/// The code page of an artifact's non-UTF-8 entry names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NameEncoding {
    /// DOS Cyrillic (OEM code page of Russian Windows).
    Cp866,
}

/// Bytes 0x80-0xFF of code page 866 (the lower half is ASCII).
const CP866_HIGH: &str = "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмноп░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀рстуфхцчшщъыьэюяЁёЄєЇїЎў°∙·√№¤■\u{00a0}";

fn decode(encoding: NameEncoding, raw: &[u8]) -> String {
    match encoding {
        NameEncoding::Cp866 => raw
            .iter()
            .map(|&byte| match byte {
                0..=0x7f => char::from(byte),
                high => CP866_HIGH
                    .chars()
                    .nth(usize::from(high - 0x80))
                    .unwrap_or(char::REPLACEMENT_CHARACTER),
            })
            .collect(),
    }
}

/// The name to extract an entry under: `decoded` (what the `zip` crate made of it) unless the artifact names an
/// encoding and the raw bytes are neither ASCII nor the entry's UTF-8 name.
pub fn entry_name(encoding: Option<NameEncoding>, raw: &[u8], decoded: &str) -> String {
    let Some(encoding) = encoding else {
        return decoded.to_owned();
    };
    if raw.is_ascii() || std::str::from_utf8(raw) == Ok(decoded) {
        return decoded.to_owned();
    }
    decode(encoding, raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_covers_the_whole_upper_half() {
        assert_eq!(CP866_HIGH.chars().count(), 128);
    }

    #[test]
    fn a_cp866_name_is_decoded_like_windows_does() {
        // The real entry of PABCNETC.zip 4.0.0.3883: "Lib/Мозаика.pcu" in code page 866.
        let raw = b"Lib/\x8c\xae\xa7\xa0\xa8\xaa\xa0.pcu";
        assert_eq!(
            entry_name(Some(NameEncoding::Cp866), raw, "garbled"),
            "Lib/Мозаика.pcu"
        );
        assert_eq!(decode(NameEncoding::Cp866, b"\xf0\xf1\xff"), "Ёё\u{a0}");
    }

    #[test]
    fn ascii_utf8_and_unencoded_names_are_left_alone() {
        assert_eq!(
            entry_name(
                Some(NameEncoding::Cp866),
                b"Lib/PABCSystem.pcu",
                "Lib/PABCSystem.pcu"
            ),
            "Lib/PABCSystem.pcu"
        );
        let utf8 = "Lib/Мозаика.pcu";
        assert_eq!(
            entry_name(Some(NameEncoding::Cp866), utf8.as_bytes(), utf8),
            utf8
        );
        assert_eq!(entry_name(None, b"\x8c.pcu", "Ì.pcu"), "Ì.pcu");
    }

    fn crc32(data: &[u8]) -> u32 {
        let mut crc = !0u32;
        for &byte in data {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 {
                    (crc >> 1) ^ 0xEDB8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    /// A stored ZIP with one entry and no UTF-8 flag, its name `central` in the central directory and `local` in
    /// the local header, the way PABCNETC.zip was written.
    fn legacy_zip(central: &[u8], local: &[u8], data: &[u8]) -> Vec<u8> {
        let size = u32::try_from(data.len()).expect("small");
        let crc = crc32(data);
        let mut zip = Vec::new();
        let u16_of = |n: usize| u16::try_from(n).expect("small").to_le_bytes();
        zip.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        zip.extend_from_slice(&[20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        zip.extend_from_slice(&crc.to_le_bytes());
        zip.extend_from_slice(&size.to_le_bytes());
        zip.extend_from_slice(&size.to_le_bytes());
        zip.extend_from_slice(&u16_of(local.len()));
        zip.extend_from_slice(&[0, 0]);
        zip.extend_from_slice(local);
        zip.extend_from_slice(data);
        let directory_at = zip.len();
        zip.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        zip.extend_from_slice(&[20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        zip.extend_from_slice(&crc.to_le_bytes());
        zip.extend_from_slice(&size.to_le_bytes());
        zip.extend_from_slice(&size.to_le_bytes());
        zip.extend_from_slice(&u16_of(central.len()));
        zip.extend_from_slice(&[0; 12]);
        zip.extend_from_slice(&0u32.to_le_bytes());
        zip.extend_from_slice(central);
        let directory_size = zip.len() - directory_at;
        zip.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        zip.extend_from_slice(&[0, 0, 0, 0, 1, 0, 1, 0]);
        zip.extend_from_slice(&u32::try_from(directory_size).expect("small").to_le_bytes());
        zip.extend_from_slice(&u32::try_from(directory_at).expect("small").to_le_bytes());
        zip.extend_from_slice(&[0, 0]);
        zip
    }

    #[test]
    fn a_legacy_cyrillic_entry_is_extracted_under_its_real_name() {
        let dir = tempfile::tempdir().expect("tempdir");
        let archive = dir.path().join("PABCNETC.zip");
        let zip = legacy_zip(
            b"Lib/\x8c\xae\xa7\xa0\xa8\xaa\xa0.pcu",
            b"Lib/\xcc\xee\xe7\xe0\xe8\xea\xe0.pcu",
            b"unit",
        );
        std::fs::write(&archive, zip).expect("write");
        let selection = crate::extract::ExtractSelection {
            name_encoding: Some(NameEncoding::Cp866),
            ..Default::default()
        };

        crate::extract::extract_zip(&archive, &dir.path().join("out"), selection, &mut |_, _| {})
            .expect("extract");

        let unit = dir.path().join("out").join("Lib").join("Мозаика.pcu");
        assert_eq!(std::fs::read(unit).expect("unit"), b"unit");
    }
}
