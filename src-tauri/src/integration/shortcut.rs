//! Desktop shortcuts, written with Windows' own `IShellLinkW` (the same object Explorer uses).
//!
//! The shortcut's target is the program's **universal** path: when OpenMind Studio runs from a network drive letter
//! (`Z:\OpenMind Studio`), the shortcut points at `\\server\share\OpenMind Studio` instead, so it works on a computer that
//! maps the share to another letter or not at all. A shortcut that already points at this program is left alone; one
//! that points elsewhere (an older location, another copy) is repaired only when it is OpenMind's own shortcut name.

use std::ffi::OsStr;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::ptr;

use winapi::shared::minwindef::MAX_PATH;
use winapi::shared::winerror::{FAILED, S_FALSE};
use winapi::shared::wtypesbase::CLSCTX_INPROC_SERVER;
use winapi::um::combaseapi::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize};
use winapi::um::knownfolders::{FOLDERID_Desktop, FOLDERID_PublicDesktop};
use winapi::um::objbase::COINIT_APARTMENTTHREADED;
use winapi::um::objidl::IPersistFile;
use winapi::um::shlobj::SHGetKnownFolderPath;
use winapi::um::shobjidl_core::{IShellLinkW, ShellLink};
use winapi::um::unknwnbase::IUnknown;
use winapi::{Class, Interface};

use super::deploy::ShortcutOutcome;

fn wide(text: &OsStr) -> Vec<u16> {
    text.encode_wide().chain(Some(0)).collect()
}

fn from_wide(buffer: &[u16]) -> PathBuf {
    let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    PathBuf::from(std::ffi::OsString::from_wide(&buffer[..end]))
}

/// The user's Desktop, or the Public Desktop every user sees (`all_users`; writing there needs administrator rights).
pub fn desktop_dir(all_users: bool) -> Result<PathBuf, String> {
    let folder = if all_users {
        &FOLDERID_PublicDesktop
    } else {
        &FOLDERID_Desktop
    };
    let mut raw: *mut u16 = ptr::null_mut();
    // SAFETY: `folder` is a valid GUID; on success `raw` is a NUL-terminated string we free with CoTaskMemFree.
    let hr = unsafe { SHGetKnownFolderPath(folder, 0, ptr::null_mut(), &mut raw) };
    if FAILED(hr) || raw.is_null() {
        return Err(format!("the Desktop folder is unknown (0x{hr:08x})"));
    }
    // SAFETY: `raw` points at a NUL-terminated UTF-16 string owned by COM until freed below.
    let path = unsafe {
        let len = (0..).take_while(|&i| *raw.add(i) != 0).count();
        let slice = std::slice::from_raw_parts(raw, len);
        let path = PathBuf::from(std::ffi::OsString::from_wide(slice));
        CoTaskMemFree(raw.cast());
        path
    };
    Ok(path)
}

/// `Z:\dir\file` -> `\\server\share\dir\file` when `Z:` is a network drive; any other path as it is.
pub fn universal_path(path: &Path) -> PathBuf {
    openmind_core::install::universal_path(path)
}

/// COM for this thread, released when dropped.
struct Com(bool);

impl Com {
    fn init() -> Result<Self, String> {
        // SAFETY: plain COM initialisation of the calling thread.
        let hr = unsafe { CoInitializeEx(ptr::null_mut(), COINIT_APARTMENTTHREADED) };
        if FAILED(hr) {
            // RPC_E_CHANGED_MODE: COM is already on in another mode; it can still be used, just not released by us.
            return Ok(Self(false));
        }
        Ok(Self(hr == 0 || hr == S_FALSE))
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            // SAFETY: balanced with the successful CoInitializeEx above.
            unsafe { CoUninitialize() };
        }
    }
}

/// An owned COM interface pointer, released when dropped.
struct Owned<T: Interface>(*mut T);

impl<T: Interface> Drop for Owned<T> {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: every COM interface starts with IUnknown; we own one reference.
            unsafe { (*(self.0 as *mut IUnknown)).Release() };
        }
    }
}

/// `E_ACCESSDENIED` as a COM result (`HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED)`).
const E_ACCESS_DENIED: i32 = 0x8007_0005_u32 as i32;

fn check(hr: i32, what: &str) -> Result<(), String> {
    if hr == E_ACCESS_DENIED {
        Err(format!(
            "{what} failed: Windows denied access (you may not change that folder, or a policy locks it)"
        ))
    } else if FAILED(hr) {
        Err(format!("{what} failed (0x{hr:08x})"))
    } else {
        Ok(())
    }
}

fn new_link() -> Result<(Owned<IShellLinkW>, Owned<IPersistFile>), String> {
    let mut link: *mut IShellLinkW = ptr::null_mut();
    // SAFETY: standard CoCreateInstance of the ShellLink class for IShellLinkW.
    let hr = unsafe {
        CoCreateInstance(
            &ShellLink::uuidof(),
            ptr::null_mut(),
            CLSCTX_INPROC_SERVER,
            &IShellLinkW::uuidof(),
            (&mut link as *mut *mut IShellLinkW).cast(),
        )
    };
    check(hr, "creating a shortcut object")?;
    let link = Owned(link);
    let mut file: *mut IPersistFile = ptr::null_mut();
    // SAFETY: `link.0` is a live IShellLinkW; QueryInterface for IPersistFile.
    let hr = unsafe {
        (*link.0).QueryInterface(
            &IPersistFile::uuidof(),
            (&mut file as *mut *mut IPersistFile).cast(),
        )
    };
    check(hr, "opening the shortcut object")?;
    Ok((link, Owned(file)))
}

/// The target of an existing shortcut file, if it can be read.
pub fn read_target(lnk: &Path) -> Option<PathBuf> {
    let _com = Com::init().ok()?;
    let (link, file) = new_link().ok()?;
    let name = wide(lnk.as_os_str());
    // SAFETY: live interfaces; `name` is NUL-terminated; `buffer` holds MAX_PATH UTF-16 units.
    unsafe {
        if FAILED((*file.0).Load(name.as_ptr(), 0)) {
            return None;
        }
        let mut buffer = vec![0u16; MAX_PATH * 4];
        if FAILED((*link.0).GetPath(buffer.as_mut_ptr(), buffer.len() as i32, ptr::null_mut(), 0)) {
            return None;
        }
        Some(from_wide(&buffer))
    }
}

/// The shortcuts (`*.lnk`, not in sub-folders) in `dir` with their targets; at most `limit` files are read. A folder
/// that can't be listed has none, and a shortcut that can't be read is left out.
pub fn shortcuts_in(dir: &Path, limit: usize) -> Vec<(PathBuf, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("lnk"))
                && path.is_file()
        })
        .take(limit)
        .filter_map(|lnk| read_target(&lnk).map(|target| (lnk, target)))
        .collect()
}

/// Writes (or repairs) `lnk` so it starts `target` in its own folder with the program's icon.
pub fn write(lnk: &Path, target: &Path, description: &str) -> Result<ShortcutOutcome, String> {
    let existed = lnk.is_file();
    let existing = existed.then(|| read_target(lnk)).flatten();
    if existing
        .as_deref()
        .is_some_and(|current| super::deploy::same_target(current, target))
    {
        return Ok(ShortcutOutcome::AlreadyCorrect);
    }
    let _com = Com::init()?;
    let (link, file) = new_link()?;
    let folder = target.parent().unwrap_or(target);
    let (target_w, folder_w, text_w, lnk_w) = (
        wide(target.as_os_str()),
        wide(folder.as_os_str()),
        wide(OsStr::new(description)),
        wide(lnk.as_os_str()),
    );
    // SAFETY: live interfaces; every string is NUL-terminated and outlives the calls.
    unsafe {
        check(
            (*link.0).SetPath(target_w.as_ptr()),
            "setting the shortcut's target",
        )?;
        check(
            (*link.0).SetWorkingDirectory(folder_w.as_ptr()),
            "setting the shortcut's folder",
        )?;
        check(
            (*link.0).SetDescription(text_w.as_ptr()),
            "setting the shortcut's description",
        )?;
        check(
            (*link.0).SetIconLocation(target_w.as_ptr(), 0),
            "setting the shortcut's icon",
        )?;
        check((*file.0).Save(lnk_w.as_ptr(), 1), "saving the shortcut")?;
    }
    Ok(if existed {
        ShortcutOutcome::Repaired
    } else {
        ShortcutOutcome::Created
    })
}
