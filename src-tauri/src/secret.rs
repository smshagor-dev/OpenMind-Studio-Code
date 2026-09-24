//! Encrypts the values OpenMind keeps for local services (the MariaDB root
//! password, phpMyAdmin's cookie secret) before they go into SQLite.
//!
//! On Windows this is DPAPI (`CryptProtectData`, current-user scope): the key
//! belongs to the signed-in Windows user, nothing is sent anywhere, no admin
//! rights or Registry writes are needed, and the database file alone (copied
//! to another user or machine) can't be read. A stored value is
//! `dpapi1:<base64>`. A value with no prefix is an older plain-text one: it is
//! still readable and callers re-store it encrypted. Elsewhere there is no
//! equivalent wired up yet, so values are stored as they are.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;

const PREFIX: &str = "dpapi1:";

/// Extra bytes mixed into the encryption so a blob from another application
/// using DPAPI as the same user isn't accepted as ours.
#[cfg(windows)]
const ENTROPY: &[u8] = b"OpenMind Studio local service secret v1";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SecretError {
    #[error("Windows couldn't encrypt the value: error {0}")]
    Encrypt(u32),
    #[error("Windows couldn't decrypt the stored value (it was saved by another Windows user or machine): error {0}")]
    Decrypt(u32),
    #[error("The stored value is damaged.")]
    Damaged,
}

/// Whether `stored` is an encrypted value (as opposed to legacy plain text).
pub fn is_protected(stored: &str) -> bool {
    stored.starts_with(PREFIX)
}

/// The value to put in the database for `plain`.
pub fn protect(plain: &str) -> Result<String, SecretError> {
    #[cfg(windows)]
    {
        let bytes = dpapi::protect(plain.as_bytes(), ENTROPY)?;
        Ok(format!("{PREFIX}{}", BASE64.encode(bytes)))
    }
    #[cfg(not(windows))]
    {
        Ok(plain.to_string())
    }
}

/// The original value for something read from the database.
pub fn unprotect(stored: &str) -> Result<String, SecretError> {
    let Some(encoded) = stored.strip_prefix(PREFIX) else {
        return Ok(stored.to_string());
    };
    #[cfg(windows)]
    {
        let bytes = BASE64.decode(encoded).map_err(|_| SecretError::Damaged)?;
        let plain = dpapi::unprotect(&bytes, ENTROPY)?;
        String::from_utf8(plain).map_err(|_| SecretError::Damaged)
    }
    #[cfg(not(windows))]
    {
        let _ = encoded;
        Err(SecretError::Damaged)
    }
}

#[cfg(windows)]
mod dpapi {
    use std::ptr::{null_mut, slice_from_raw_parts};

    use winapi::shared::minwindef::DWORD;
    use winapi::um::dpapi::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN};
    use winapi::um::errhandlingapi::GetLastError;
    use winapi::um::winbase::LocalFree;
    use winapi::um::wincrypt::DATA_BLOB;

    use super::SecretError;

    fn blob(bytes: &[u8]) -> DATA_BLOB {
        DATA_BLOB {
            cbData: bytes.len() as DWORD,
            pbData: bytes.as_ptr() as *mut u8,
        }
    }

    /// Copies a Windows-allocated output blob and frees it.
    ///
    /// # Safety
    /// `out` must have been filled in by a successful DPAPI call.
    unsafe fn take(out: DATA_BLOB) -> Vec<u8> {
        let copy = (*slice_from_raw_parts(out.pbData, out.cbData as usize)).to_vec();
        LocalFree(out.pbData.cast());
        copy
    }

    pub fn protect(data: &[u8], entropy: &[u8]) -> Result<Vec<u8>, SecretError> {
        let mut input = blob(data);
        let mut extra = blob(entropy);
        let mut out = DATA_BLOB {
            cbData: 0,
            pbData: null_mut(),
        };
        // SAFETY: the blobs point at live slices for the whole call; `out` is
        // only read after the call reports success, then freed by `take`.
        unsafe {
            let ok = CryptProtectData(
                &mut input,
                null_mut(),
                &mut extra,
                null_mut(),
                null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            );
            if ok == 0 {
                return Err(SecretError::Encrypt(GetLastError()));
            }
            Ok(take(out))
        }
    }

    pub fn unprotect(data: &[u8], entropy: &[u8]) -> Result<Vec<u8>, SecretError> {
        let mut input = blob(data);
        let mut extra = blob(entropy);
        let mut out = DATA_BLOB {
            cbData: 0,
            pbData: null_mut(),
        };
        // SAFETY: as in `protect`.
        unsafe {
            let ok = CryptUnprotectData(
                &mut input,
                null_mut(),
                &mut extra,
                null_mut(),
                null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            );
            if ok == 0 {
                return Err(SecretError::Decrypt(GetLastError()));
            }
            Ok(take(out))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_protected_value_is_not_the_plain_text_and_round_trips() {
        let stored = protect("s3cretPassw0rd").unwrap();
        if cfg!(windows) {
            assert!(is_protected(&stored));
            assert!(!stored.contains("s3cretPassw0rd"));
        }
        assert_eq!(unprotect(&stored).unwrap(), "s3cretPassw0rd");
    }

    #[test]
    fn protecting_twice_gives_different_blobs_that_both_open() {
        if !cfg!(windows) {
            return;
        }
        let a = protect("same").unwrap();
        let b = protect("same").unwrap();
        assert_ne!(a, b);
        assert_eq!(unprotect(&a).unwrap(), unprotect(&b).unwrap());
    }

    #[test]
    fn an_old_plain_text_value_is_still_readable_and_reported_as_unprotected() {
        assert!(!is_protected("plainOldPassword"));
        assert_eq!(unprotect("plainOldPassword").unwrap(), "plainOldPassword");
    }

    #[test]
    fn a_damaged_blob_is_an_error_not_a_panic() {
        if !cfg!(windows) {
            return;
        }
        assert_eq!(unprotect("dpapi1:!!!not base64"), Err(SecretError::Damaged));
        assert!(matches!(
            unprotect("dpapi1:AAAA"),
            Err(SecretError::Decrypt(_))
        ));
    }

    #[test]
    fn unicode_survives() {
        let stored = protect("pässwörd✓").unwrap();
        assert_eq!(unprotect(&stored).unwrap(), "pässwörd✓");
    }
}
