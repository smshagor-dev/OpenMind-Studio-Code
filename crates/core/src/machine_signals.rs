//! Reads this computer's identity signals (see [`crate::machine_identity`]): read-only, no administrator rights, no
//! process started on Windows or Linux. Values are returned to the identity resolver only; nothing here logs them.

use crate::machine_identity::MachineSignals;

/// The signals of the computer the app runs on (missing ones are `None`).
pub fn read() -> MachineSignals {
    os::read()
}

/// The SMBIOS "System Information" (type 1) structure's UUID and serial number from a raw SMBIOS table.
/// `version` is `(major, minor)`: from SMBIOS 2.6 the UUID's first three fields are little-endian.
pub fn smbios_system_info(table: &[u8], version: (u8, u8)) -> (Option<String>, Option<String>) {
    let mut at = 0usize;
    while at + 4 <= table.len() {
        let kind = table[at];
        let length = usize::from(table[at + 1]);
        if length < 4 || at + length > table.len() {
            break;
        }
        let formatted = &table[at..at + length];
        let strings_start = at + length;
        let strings_end = strings_end(table, strings_start);
        if kind == 1 {
            let strings = &table[strings_start..strings_end.min(table.len())];
            let serial = formatted
                .get(0x07)
                .and_then(|index| smbios_string(strings, *index));
            let uuid = formatted
                .get(0x08..0x18)
                .map(|bytes| uuid_text(bytes, version));
            return (uuid, serial);
        }
        if kind == 127 {
            break; // end of table
        }
        at = strings_end + 2;
    }
    (None, None)
}

/// Where a structure's string set ends: the first of two NUL bytes in a row.
fn strings_end(table: &[u8], start: usize) -> usize {
    let mut i = start;
    while i + 1 < table.len() {
        if table[i] == 0 && table[i + 1] == 0 {
            return i;
        }
        i += 1;
    }
    table.len()
}

/// String number `index` (1-based) of a structure's string set.
fn smbios_string(strings: &[u8], index: u8) -> Option<String> {
    if index == 0 {
        return None;
    }
    let text = strings.split(|b| *b == 0).nth(usize::from(index) - 1)?;
    let text = String::from_utf8_lossy(text).trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn uuid_text(bytes: &[u8], version: (u8, u8)) -> String {
    let mut b = [0u8; 16];
    b.copy_from_slice(bytes);
    if version >= (2, 6) {
        b[..4].reverse();
        b[4..6].reverse();
        b[6..8].reverse();
    }
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

#[cfg(windows)]
mod os {
    use winapi::shared::minwindef::{DWORD, HKEY};
    use winapi::shared::winerror::ERROR_SUCCESS;
    use winapi::um::sysinfoapi::GetSystemFirmwareTable;
    use winapi::um::winreg::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};

    use crate::machine_identity::MachineSignals;

    /// Read the 64-bit view even from a 32-bit build (the 32-bit view of this key has no MachineGuid).
    const RRF_SUBKEY_WOW6464KEY: DWORD = 0x0001_0000;
    /// `'RSMB'`: the raw SMBIOS firmware table provider (readable by any user).
    const RSMB: DWORD = 0x5253_4D42;

    pub fn read() -> MachineSignals {
        let (hardware_uuid, hardware_serial) = smbios();
        MachineSignals {
            os_id: machine_guid(),
            hardware_uuid,
            hardware_serial,
        }
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`, read only (any user may read it; nothing is written).
    fn machine_guid() -> Option<String> {
        let key = wide(r"SOFTWARE\Microsoft\Cryptography");
        let value = wide("MachineGuid");
        let mut buffer = [0u16; 128];
        let mut size = (buffer.len() * 2) as DWORD;
        // SAFETY: every pointer is valid for the call; `size` is the buffer's length in bytes and is updated to the
        // bytes written (including the terminating NUL).
        let status = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE as HKEY,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if status as u32 != ERROR_SUCCESS {
            return None;
        }
        let chars = (size as usize / 2).min(buffer.len());
        let text = String::from_utf16_lossy(&buffer[..chars]);
        let text = text.trim_end_matches('\0').trim().to_string();
        (!text.is_empty()).then_some(text)
    }

    /// The SMBIOS system UUID and serial (`GetSystemFirmwareTable`, no elevation needed).
    fn smbios() -> (Option<String>, Option<String>) {
        // SAFETY: a null buffer of size 0 asks for the size only.
        let size = unsafe { GetSystemFirmwareTable(RSMB, 0, std::ptr::null_mut(), 0) };
        if !(8..=4 * 1024 * 1024).contains(&size) {
            return (None, None);
        }
        let mut buffer = vec![0u8; size as usize];
        // SAFETY: `buffer` is `size` bytes long.
        let written = unsafe { GetSystemFirmwareTable(RSMB, 0, buffer.as_mut_ptr().cast(), size) };
        if written < 8 || written > size {
            return (None, None);
        }
        // RawSMBIOSData: Used20CallingMethod, MajorVersion, MinorVersion, DmiRevision, Length (u32), then the table.
        let version = (buffer[1], buffer[2]);
        let length = u32::from_le_bytes([buffer[4], buffer[5], buffer[6], buffer[7]]) as usize;
        let end = (8 + length).min(written as usize);
        super::smbios_system_info(&buffer[8..end], version)
    }
}

#[cfg(target_os = "macos")]
mod os {
    use crate::machine_identity::MachineSignals;

    /// `IOPlatformUUID` and `IOPlatformSerialNumber` from `ioreg` (no administrator rights needed).
    pub fn read() -> MachineSignals {
        let text = std::process::Command::new("/usr/sbin/ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
            .ok()
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .unwrap_or_default();
        MachineSignals {
            os_id: None,
            hardware_uuid: super::ioreg_value(&text, "IOPlatformUUID"),
            hardware_serial: super::ioreg_value(&text, "IOPlatformSerialNumber"),
        }
    }
}

#[cfg(all(not(windows), not(target_os = "macos")))]
mod os {
    use crate::machine_identity::MachineSignals;

    /// systemd's `/etc/machine-id` (else D-Bus's copy) and, when this user may read them, the DMI product UUID/serial.
    pub fn read() -> MachineSignals {
        let first = |paths: &[&str]| {
            paths
                .iter()
                .find_map(|path| std::fs::read_to_string(path).ok())
                .map(|text| text.trim().to_string())
                .filter(|text| !text.is_empty())
        };
        MachineSignals {
            os_id: first(&["/etc/machine-id", "/var/lib/dbus/machine-id"]),
            hardware_uuid: first(&["/sys/class/dmi/id/product_uuid"]),
            hardware_serial: first(&["/sys/class/dmi/id/product_serial"]),
        }
    }
}

/// The value of `"<key>" = "<value>"` in `ioreg` output.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn ioreg_value(text: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let line = text.lines().find(|line| line.contains(&needle))?;
    let value = line.split('=').nth(1)?.trim().trim_matches('"').trim();
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A type-0 structure, then type 1 with serial "SN-123" (string 2) and a UUID, then the end marker.
    fn table(uuid: [u8; 16]) -> Vec<u8> {
        let mut t = vec![0, 4, 0, 0];
        t.extend_from_slice(b"BIOS\0\0");
        let mut info = vec![1u8, 0x1b, 1, 0, 1, 0, 0, 2];
        info.extend_from_slice(&uuid);
        info.extend_from_slice(&[6, 0, 0]);
        t.extend_from_slice(&info);
        t.extend_from_slice(b"Maker\0SN-123\0\0");
        t.extend_from_slice(&[127, 4, 2, 0, 0, 0]);
        t
    }

    #[test]
    fn reads_the_system_uuid_and_serial_from_an_smbios_table() {
        let uuid = [
            0x33, 0x22, 0x11, 0x00, 0x55, 0x44, 0x77, 0x66, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd,
            0xee, 0xff,
        ];
        let (found, serial) = smbios_system_info(&table(uuid), (3, 4));
        assert_eq!(
            found.as_deref(),
            Some("00112233-4455-6677-8899-aabbccddeeff")
        );
        assert_eq!(serial.as_deref(), Some("SN-123"));
        let (old, _) = smbios_system_info(&table(uuid), (2, 4));
        assert_eq!(old.as_deref(), Some("33221100-5544-7766-8899-aabbccddeeff"));
    }

    #[test]
    fn a_damaged_or_empty_table_gives_nothing() {
        assert_eq!(smbios_system_info(&[], (3, 0)), (None, None));
        assert_eq!(smbios_system_info(&[1, 200, 0, 0, 1], (3, 0)), (None, None));
        assert_eq!(
            smbios_system_info(&[127, 4, 0, 0, 0, 0], (3, 0)),
            (None, None)
        );
    }

    #[test]
    fn ioreg_values_are_read_by_key() {
        let text = "  \"IOPlatformSerialNumber\" = \"C02XYZ\"\n  \"IOPlatformUUID\" = \"ABCD-1\"\n";
        assert_eq!(
            ioreg_value(text, "IOPlatformUUID").as_deref(),
            Some("ABCD-1")
        );
        assert_eq!(
            ioreg_value(text, "IOPlatformSerialNumber").as_deref(),
            Some("C02XYZ")
        );
        assert_eq!(ioreg_value(text, "Missing"), None);
    }

    #[cfg(windows)]
    #[test]
    fn this_windows_computer_answers_without_administrator_rights() {
        // The test suite runs as an ordinary user: both reads must work (or answer None) without elevation.
        let signals = read();
        assert!(
            signals.os_id.is_some() || signals.hardware_uuid.is_some(),
            "neither MachineGuid nor the SMBIOS UUID could be read: {signals:?}"
        );
        assert!(crate::machine_identity::canonical_tuple(&signals).is_some());
    }
}
