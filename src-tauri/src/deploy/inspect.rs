//! What is at the folder the user chose to provision into, read without changing anything: missing, empty, an
//! OpenMind Studio copy (which version, installed by the setup or unzipped) or something else. And whether the copy
//! there is running on this computer right now (it must be closed before it is upgraded or repaired).
//!
//! The folder can be anywhere Windows can write — any drive letter, a folder with spaces or non-Latin letters, a
//! network path; nothing here assumes a drive.

use std::path::Path;

use openmind_deploy::advert::PackageKind;
use openmind_deploy::provision::Destination;

pub const PROGRAM: &str = "OpenMindStudio.exe";

/// See the module text.
pub fn destination(dest: &Path) -> Destination {
    let Ok(meta) = std::fs::symlink_metadata(dest) else {
        return Destination::Missing;
    };
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Destination::NotOurs;
    }
    let Ok(mut entries) = std::fs::read_dir(dest) else {
        return Destination::NotOurs;
    };
    if entries.next().is_none() {
        return Destination::Empty;
    }
    let program = dest.join(PROGRAM);
    if !program.is_file() {
        return Destination::NotOurs;
    }
    let by_setup = dest.join("uninstall.exe").is_file()
        || dest.join(openmind_core::install::INSTALL_FILE).is_file();
    let recorded = match openmind_core::install::read(dest) {
        openmind_core::install::InstallRecord::Found(meta) => Some(meta.app_version),
        _ => None,
    };
    let version = recorded
        .filter(|v| openmind_deploy::version::is_valid(v))
        .or_else(|| exe_version(&program))
        .unwrap_or_else(|| "0.0.0".into());
    Destination::Installed {
        version,
        kind: if by_setup {
            PackageKind::Installer
        } else {
            PackageKind::Portable
        },
    }
}

/// The `MAJOR.MINOR.PATCH` of a program's version resource.
#[cfg(windows)]
pub fn exe_version(program: &Path) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use winapi::um::winver::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
    /// `VS_FIXEDFILEINFO` (verrsrc.h; winapi 0.3 has the functions but not the structure).
    #[repr(C)]
    #[allow(non_snake_case)]
    struct VS_FIXEDFILEINFO {
        dwSignature: u32,
        dwStrucVersion: u32,
        dwFileVersionMS: u32,
        dwFileVersionLS: u32,
        dwProductVersionMS: u32,
        dwProductVersionLS: u32,
        dwFileFlagsMask: u32,
        dwFileFlags: u32,
        dwFileOS: u32,
        dwFileType: u32,
        dwFileSubtype: u32,
        dwFileDateMS: u32,
        dwFileDateLS: u32,
    }
    let wide: Vec<u16> = program.as_os_str().encode_wide().chain(Some(0)).collect();
    let root: Vec<u16> = "\\".encode_utf16().chain(Some(0)).collect();
    // SAFETY: `wide` and `root` are NUL-terminated; `data` holds `size` bytes for GetFileVersionInfoW; VerQueryValueW
    // returns a pointer into `data`, read only while `data` lives, after checking its length.
    unsafe {
        let mut ignored = 0;
        let size = GetFileVersionInfoSizeW(wide.as_ptr(), &mut ignored);
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        if GetFileVersionInfoW(wide.as_ptr(), 0, size, data.as_mut_ptr().cast()) == 0 {
            return None;
        }
        let mut info: *mut winapi::ctypes::c_void = std::ptr::null_mut();
        let mut len = 0u32;
        if VerQueryValueW(data.as_ptr().cast(), root.as_ptr(), &mut info, &mut len) == 0
            || info.is_null()
            || (len as usize) < std::mem::size_of::<VS_FIXEDFILEINFO>()
        {
            return None;
        }
        let fixed = &*(info as *const VS_FIXEDFILEINFO);
        if fixed.dwSignature != 0xFEEF_04BD {
            return None;
        }
        Some(format!(
            "{}.{}.{}",
            fixed.dwFileVersionMS >> 16,
            fixed.dwFileVersionMS & 0xffff,
            fixed.dwFileVersionLS >> 16
        ))
    }
}

#[cfg(not(windows))]
pub fn exe_version(_program: &Path) -> Option<String> {
    None
}

/// Whether a process on this computer runs `program` (compared by full path, case-insensitively).
#[cfg(windows)]
pub fn running(program: &Path) -> bool {
    let wanted = openmind_core::install::normalized_key_path(
        &std::fs::canonicalize(program).unwrap_or_else(|_| program.to_path_buf()),
    );
    process_paths()
        .iter()
        .any(|path| openmind_core::install::normalized_key_path(path) == wanted)
}

#[cfg(windows)]
fn process_paths() -> Vec<std::path::PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::processthreadsapi::OpenProcess;
    use winapi::um::psapi::EnumProcesses;
    use winapi::um::winbase::QueryFullProcessImageNameW;
    use winapi::um::winnt::PROCESS_QUERY_LIMITED_INFORMATION;
    let mut ids = vec![0u32; 4096];
    let mut used = 0u32;
    // SAFETY: `ids` has room for the bytes passed; every handle opened is closed; the name buffer's length is passed.
    unsafe {
        if EnumProcesses(ids.as_mut_ptr(), (ids.len() * 4) as u32, &mut used) == 0 {
            return Vec::new();
        }
        ids.truncate(used as usize / 4);
        let mut paths = Vec::new();
        for id in ids.into_iter().filter(|id| *id != 0) {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, id);
            if handle.is_null() {
                continue;
            }
            let mut buf = vec![0u16; 32768];
            let mut len = buf.len() as u32;
            if QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len) != 0 {
                paths.push(std::path::PathBuf::from(std::ffi::OsString::from_wide(
                    &buf[..len as usize],
                )));
            }
            CloseHandle(handle);
        }
        paths
    }
}

#[cfg(not(windows))]
pub fn running(_program: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_is_read_as_missing_empty_ours_or_not_ours() {
        let dir = tempfile::tempdir().expect("dir");
        let dest = dir.path().join("Apps With Spaces").join("Программы ওপেন");
        assert_eq!(destination(&dest), Destination::Missing);
        std::fs::create_dir_all(&dest).expect("dir");
        assert_eq!(destination(&dest), Destination::Empty);
        std::fs::write(dest.join("notes.txt"), b"mine").expect("file");
        assert_eq!(destination(&dest), Destination::NotOurs);
        std::fs::write(dest.join(PROGRAM), b"not a real program").expect("exe");
        assert_eq!(
            destination(&dest),
            Destination::Installed {
                version: "0.0.0".into(),
                kind: PackageKind::Portable
            }
        );
        openmind_core::install::write(&dest, openmind_core::InstallLayout::PerUser, "1.0.2")
            .expect("install.json");
        assert_eq!(
            destination(&dest),
            Destination::Installed {
                version: "1.0.2".into(),
                kind: PackageKind::Installer
            }
        );
        let file = dir.path().join("a-file");
        std::fs::write(&file, b"x").expect("file");
        assert_eq!(destination(&file), Destination::NotOurs);
    }

    #[cfg(windows)]
    #[test]
    fn this_test_programs_own_version_and_process_are_found() {
        let me = std::env::current_exe().expect("exe");
        assert!(running(&me), "the test program itself is running");
        assert!(!running(&me.with_file_name("no-such-program.exe")));
        let system = std::path::PathBuf::from(std::env::var("SystemRoot").expect("SystemRoot"))
            .join("System32")
            .join("cmd.exe");
        let version = exe_version(&system).expect("cmd.exe has a version");
        assert!(openmind_deploy::version::is_valid(&version), "{version}");
    }
}
