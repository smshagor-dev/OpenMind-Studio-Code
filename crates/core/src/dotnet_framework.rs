//! The .NET Framework 4.x that Windows carries, as a dependency of programs built for it (PascalABC.NET's classic
//! compiler targets .NET Framework 4.7.2). Read-only: `HKLM\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full`
//! `Release`, the value Microsoft documents for detecting 4.5 and later. Nothing is installed or changed.

/// `Release` values of the first build of each version (Microsoft's "How to: Determine which .NET Framework versions
/// are installed"), newest first.
const VERSIONS: [(u32, &str); 12] = [
    (533_320, "4.8.1"),
    (528_040, "4.8"),
    (461_808, "4.7.2"),
    (461_308, "4.7.1"),
    (460_798, "4.7"),
    (394_802, "4.6.2"),
    (394_254, "4.6.1"),
    (393_295, "4.6"),
    (379_893, "4.5.2"),
    (378_675, "4.5.1"),
    (378_389, "4.5"),
    (0, "4.x"),
];

/// The lowest `Release` of .NET Framework 4.7.2.
pub const RELEASE_4_7_2: u32 = 461_808;

/// The version name of a `Release` value: "4.8.1", "4.7.2" ... ("4.x" below 4.5).
pub fn version_name(release: u32) -> &'static str {
    VERSIONS
        .iter()
        .find(|(first, _)| release >= *first)
        .map_or("4.x", |(_, name)| name)
}

/// Whether .NET Framework is present and at least `minimum` (a `Release` value).
pub fn satisfies(release: Option<u32>, minimum: u32) -> bool {
    release.is_some_and(|release| release >= minimum)
}

/// This computer's .NET Framework 4.x `Release`, `None` when it isn't installed (or not on Windows).
pub fn installed_release() -> Option<u32> {
    os::release()
}

#[cfg(windows)]
mod os {
    use winapi::shared::minwindef::DWORD;
    use winapi::shared::winerror::ERROR_SUCCESS;
    use winapi::um::winreg::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD};

    /// The 64-bit view: the key exists there whichever bitness this build is.
    const RRF_SUBKEY_WOW6464KEY: DWORD = 0x0001_0000;

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn release() -> Option<u32> {
        let key = wide(r"SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full");
        let value = wide("Release");
        let mut data: DWORD = 0;
        let mut size = std::mem::size_of::<DWORD>() as DWORD;
        // SAFETY: every pointer is valid for the call; `data` is a DWORD and `size` its length in bytes.
        let status = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_DWORD | RRF_SUBKEY_WOW6464KEY,
                std::ptr::null_mut(),
                (&mut data as *mut DWORD).cast(),
                &mut size,
            )
        };
        (status as u32 == ERROR_SUCCESS).then_some(data)
    }
}

#[cfg(not(windows))]
mod os {
    pub fn release() -> Option<u32> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_values_name_their_version() {
        assert_eq!(version_name(533_509), "4.8.1");
        assert_eq!(version_name(528_372), "4.8");
        assert_eq!(version_name(461_808), "4.7.2");
        assert_eq!(version_name(461_807), "4.7.1");
        assert_eq!(version_name(394_806), "4.6.2");
        assert_eq!(version_name(1), "4.x");
    }

    #[test]
    fn the_minimum_is_inclusive_and_missing_never_satisfies() {
        assert!(satisfies(Some(RELEASE_4_7_2), RELEASE_4_7_2));
        assert!(satisfies(Some(533_509), RELEASE_4_7_2));
        assert!(!satisfies(Some(461_308), RELEASE_4_7_2));
        assert!(!satisfies(None, RELEASE_4_7_2));
    }

    #[cfg(windows)]
    #[test]
    fn this_windows_reports_a_release() {
        // Windows 10 1803+ and Windows 11 ship 4.7.2 or later; the build machines run one of them.
        assert!(installed_release().is_some_and(|release| release >= 378_389));
    }
}
