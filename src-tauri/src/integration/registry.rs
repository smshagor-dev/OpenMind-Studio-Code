//! [`Store`] over the current user's Registry (`HKCU` only — never `HKLM`). The one place in the app that writes the
//! Registry, and only for an explicit shell-integration request (see the module above).

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::ptr::null_mut;

use winapi::shared::minwindef::{DWORD, HKEY, LPARAM};
use winapi::shared::winerror::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
use winapi::um::processenv::ExpandEnvironmentStringsW;
use winapi::um::winnt::{
    KEY_QUERY_VALUE, KEY_SET_VALUE, REG_EXPAND_SZ, REG_OPTION_NON_VOLATILE, REG_SZ,
};
use winapi::um::winreg::{
    RegCloseKey, RegCreateKeyExW, RegDeleteKeyW, RegDeleteTreeW, RegDeleteValueW, RegOpenKeyExW,
    RegQueryInfoKeyW, RegQueryValueExW, RegSetValueExW, HKEY_CURRENT_USER,
};
use winapi::um::winuser::{
    SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
};

use super::Store;

/// Where Windows keeps the user's own environment variables.
const ENVIRONMENT: &str = "Environment";

fn wide(text: &str) -> Vec<u16> {
    OsStr::new(text).encode_wide().chain(Some(0)).collect()
}

fn failed(what: &str, code: i32) -> String {
    format!("{what} failed: {}", std::io::Error::from_raw_os_error(code))
}

/// An open key, closed when dropped.
struct Key(HKEY);

impl Drop for Key {
    fn drop(&mut self) {
        // SAFETY: the handle came from RegOpenKeyExW/RegCreateKeyExW and is closed once.
        unsafe { RegCloseKey(self.0) };
    }
}

fn open(path: &str, access: DWORD) -> Result<Option<Key>, String> {
    let mut key: HKEY = null_mut();
    // SAFETY: valid NUL-terminated wide string, out-pointer to a local.
    let code =
        unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, wide(path).as_ptr(), 0, access, &mut key) };
    match code as u32 {
        ERROR_SUCCESS => Ok(Some(Key(key))),
        ERROR_FILE_NOT_FOUND => Ok(None),
        _ => Err(failed(&format!(r"Opening HKCU\{path}"), code)),
    }
}

fn create(path: &str) -> Result<Key, String> {
    let mut key: HKEY = null_mut();
    // SAFETY: valid wide strings, default security, out-pointers to locals.
    let code = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            wide(path).as_ptr(),
            0,
            null_mut(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE | KEY_QUERY_VALUE,
            null_mut(),
            &mut key,
            null_mut(),
        )
    };
    if code as u32 == ERROR_SUCCESS {
        Ok(Key(key))
    } else {
        Err(failed(&format!(r"Creating HKCU\{path}"), code))
    }
}

/// A string value and whether it is `REG_EXPAND_SZ`; `None` when missing or not a string.
fn read(path: &str, name: &str) -> Result<Option<(String, bool)>, String> {
    let Some(key) = open(path, KEY_QUERY_VALUE)? else {
        return Ok(None);
    };
    let name = wide(name);
    let mut kind: DWORD = 0;
    let mut size: DWORD = 0;
    // SAFETY: size query with a null buffer.
    let code = unsafe {
        RegQueryValueExW(
            key.0,
            name.as_ptr(),
            null_mut(),
            &mut kind,
            null_mut(),
            &mut size,
        )
    };
    if code as u32 == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if code as u32 != ERROR_SUCCESS {
        return Err(failed("Reading a Registry value", code));
    }
    if kind != REG_SZ && kind != REG_EXPAND_SZ {
        return Ok(None);
    }
    let mut buffer = vec![0u16; (size as usize).div_ceil(2) + 1];
    let mut bytes = (buffer.len() * 2) as DWORD;
    // SAFETY: the buffer holds `bytes` bytes.
    let code = unsafe {
        RegQueryValueExW(
            key.0,
            name.as_ptr(),
            null_mut(),
            &mut kind,
            buffer.as_mut_ptr().cast(),
            &mut bytes,
        )
    };
    if code as u32 != ERROR_SUCCESS {
        return Err(failed("Reading a Registry value", code));
    }
    let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    Ok(Some((
        String::from_utf16_lossy(&buffer[..len]),
        kind == REG_EXPAND_SZ,
    )))
}

fn write(path: &str, name: &str, value: &str, expandable: bool) -> Result<(), String> {
    let key = create(path)?;
    let data = wide(value);
    let kind = if expandable { REG_EXPAND_SZ } else { REG_SZ };
    // SAFETY: `data` is a NUL-terminated wide string of the given byte length.
    let code = unsafe {
        RegSetValueExW(
            key.0,
            wide(name).as_ptr(),
            0,
            kind,
            data.as_ptr().cast(),
            (data.len() * 2) as DWORD,
        )
    };
    if code as u32 == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(failed(&format!(r"Writing HKCU\{path}"), code))
    }
}

/// The current user's Registry.
pub struct UserRegistry;

impl Store for UserRegistry {
    fn user_path(&self) -> Result<Option<(String, bool)>, String> {
        read(ENVIRONMENT, "Path")
    }

    fn set_user_path(&mut self, value: &str, expandable: bool) -> Result<(), String> {
        write(ENVIRONMENT, "Path", value, expandable)
    }

    fn value(&self, key: &str, name: &str) -> Result<Option<String>, String> {
        Ok(read(key, name)?.map(|(value, _)| value))
    }

    fn set_value(&mut self, key: &str, name: &str, value: &str) -> Result<(), String> {
        write(key, name, value, false)
    }

    fn delete_value(&mut self, key: &str, name: &str) -> Result<(), String> {
        let Some(key) = open(key, KEY_SET_VALUE)? else {
            return Ok(());
        };
        // SAFETY: open key, valid wide string.
        let code = unsafe { RegDeleteValueW(key.0, wide(name).as_ptr()) };
        match code as u32 {
            ERROR_SUCCESS | ERROR_FILE_NOT_FOUND => Ok(()),
            _ => Err(failed("Deleting a Registry value", code)),
        }
    }

    fn delete_tree(&mut self, key: &str) -> Result<(), String> {
        // SAFETY: valid wide string relative to HKCU.
        let code = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, wide(key).as_ptr()) };
        match code as u32 {
            ERROR_SUCCESS | ERROR_FILE_NOT_FOUND => Ok(()),
            _ => Err(failed(&format!(r"Deleting HKCU\{key}"), code)),
        }
    }

    fn delete_key_if_empty(&mut self, key: &str) -> Result<(), String> {
        let (mut subkeys, mut values): (DWORD, DWORD) = (0, 0);
        {
            let Some(open) = open(key, KEY_QUERY_VALUE)? else {
                return Ok(());
            };
            // SAFETY: open key; only the two counts are asked for, every other out-pointer is null.
            let code = unsafe {
                RegQueryInfoKeyW(
                    open.0,
                    null_mut(),
                    null_mut(),
                    null_mut(),
                    &mut subkeys,
                    null_mut(),
                    null_mut(),
                    &mut values,
                    null_mut(),
                    null_mut(),
                    null_mut(),
                    null_mut(),
                )
            };
            if code as u32 != ERROR_SUCCESS {
                return Err(failed("Reading a Registry key", code));
            }
        }
        if subkeys != 0 || values != 0 {
            return Ok(());
        }
        // SAFETY: valid wide string relative to HKCU; RegDeleteKeyW never deletes a key that has sub-keys.
        let code = unsafe { RegDeleteKeyW(HKEY_CURRENT_USER, wide(key).as_ptr()) };
        match code as u32 {
            ERROR_SUCCESS | ERROR_FILE_NOT_FOUND => Ok(()),
            _ => Err(failed(&format!(r"Deleting HKCU\{key}"), code)),
        }
    }

    fn expand(&self, text: &str) -> String {
        let source = wide(text);
        // SAFETY: size query, then a buffer of the returned length.
        let needed = unsafe { ExpandEnvironmentStringsW(source.as_ptr(), null_mut(), 0) };
        if needed == 0 {
            return text.to_string();
        }
        let mut buffer = vec![0u16; needed as usize];
        let written =
            unsafe { ExpandEnvironmentStringsW(source.as_ptr(), buffer.as_mut_ptr(), needed) };
        if written == 0 || written > needed {
            return text.to_string();
        }
        String::from_utf16_lossy(&buffer[..(written as usize).saturating_sub(1)])
    }

    fn environment_changed(&mut self) {
        let what = wide(ENVIRONMENT);
        let mut result = 0;
        // SAFETY: a broadcast with a NUL-terminated string that outlives the call; a hung window times out.
        unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                what.as_ptr() as LPARAM,
                SMTO_ABORTIFHUNG,
                5000,
                &mut result,
            )
        };
    }
}
