//! **How this copy was installed**, and where each computer's writable state goes.
//!
//! The installers own this, never the app's UI: the per-user setup, the per-machine MSI and a shared network installation
//! write `install.json` next to the executable (`OpenMindStudio.exe --integration set-layout <layout>`, or the MSI's own
//! file). The app only reads it. A copy without the file is classified from facts that can't drift (see
//! [`infer_layout`]): an older installer, or the portable ZIP.
//!
//! | Layout | Program | Database, logs, WebView, settings ... | Runtimes, tools, language servers, extensions |
//! | --- | --- | --- | --- |
//! | [`InstallLayout::Portable`] | its folder | next to it (`data/`, or `data/machines/<id>/` per computer — the data scope) | next to it |
//! | [`InstallLayout::PerUser`] | `%LOCALAPPDATA%\OpenMind Studio` (or a folder the user chose) | next to it | next to it |
//! | [`InstallLayout::PerMachine`] | `Program Files` (read-only for users) | this Windows user's local folder | this Windows user's local folder |
//! | [`InstallLayout::Network`] | a shared folder several computers run | this computer's and Windows user's local folder | the shared folder (installed once) |
//!
//! "Local folder" is [`local_install_dir`]: `%LOCALAPPDATA%\OpenMind\Studio\Installations\<install key>`, on the
//! computer's own disk and per Windows user, so two computers — or two users of one computer — never open the same
//! SQLite file, and SQLite never runs its WAL over a network file system.

use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::data_scope::{rfc3339_now, write_atomic};

/// The metadata file, next to the executable.
pub const INSTALL_FILE: &str = "install.json";
/// `install.json`'s `format`.
pub const INSTALL_FORMAT: &str = "openmind-install";
const SCHEMA_VERSION: u32 = 1;
/// The per-install state file inside [`local_install_dir`].
pub const STATE_FILE: &str = "install-state.json";
const STATE_FORMAT: &str = "openmind-install-state";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallLayout {
    /// The ZIP: everything next to the program; the data scope decides one profile or one per computer.
    Portable,
    /// The per-user setup: one Windows user's copy in a folder they can write.
    PerUser,
    /// The MSI in Program Files: the program is read-only for users, so every Windows user keeps their own data.
    PerMachine,
    /// One installation in a shared folder for every connected computer: shared runtimes, local per-computer state.
    Network,
}

impl InstallLayout {
    pub fn label(self) -> &'static str {
        match self {
            Self::Portable => "portable",
            Self::PerUser => "perUser",
            Self::PerMachine => "perMachine",
            Self::Network => "network",
        }
    }

    /// The names the installers pass (`per-user`, `perUser` ... both spellings).
    pub fn parse(text: &str) -> Option<Self> {
        Some(
            match text.trim().to_ascii_lowercase().replace('_', "-").as_str() {
                "portable" => Self::Portable,
                "per-user" | "peruser" => Self::PerUser,
                "per-machine" | "permachine" => Self::PerMachine,
                "network" => Self::Network,
                _ => return None,
            },
        )
    }

    /// Each computer's writable state lives on that computer ([`local_install_dir`]), not next to the program.
    pub fn local_state(self) -> bool {
        matches!(self, Self::PerMachine | Self::Network)
    }

    /// Set by an installer: the first-start data-scope choice never appears.
    pub fn installer_managed(self) -> bool {
        !matches!(self, Self::Portable)
    }
}

/// `install.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallMetadata {
    pub format: String,
    pub schema_version: u32,
    pub layout: InstallLayout,
    pub installed_at: String,
    /// The version that wrote the file (an update rewrites it).
    pub app_version: String,
    /// A network installation gives each Windows user a Desktop shortcut the first time they start it on a computer
    /// (`None` = the layout's default: on for [`InstallLayout::Network`], off otherwise). Set by the installer
    /// (`/NOUSERSHORTCUTS`) or `--integration user-desktop-shortcuts on|off`; kept when the layout is rewritten.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_desktop_shortcuts: Option<bool>,
}

impl InstallMetadata {
    /// Whether each Windows user gets a Desktop shortcut at their first start (see the field).
    pub fn gives_user_desktop_shortcuts(&self) -> bool {
        self.user_desktop_shortcuts
            .unwrap_or(self.layout == InstallLayout::Network)
    }
}

/// What `install.json` says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallRecord {
    Missing,
    Found(InstallMetadata),
    /// There, but damaged or from a newer version: the layout is inferred instead, and the file is left as it is.
    Unreadable(String),
}

pub fn install_file(exe_dir: &Path) -> PathBuf {
    exe_dir.join(INSTALL_FILE)
}

/// How a file read ended after [`read_text_retrying`].
#[derive(Debug)]
pub enum ReadText {
    Missing,
    Text(String),
    /// It couldn't be read even after a few tries (a network share that dropped, a file locked by a virus scanner).
    Failed(std::io::Error),
}

/// Reads a small text file, trying again briefly when it fails for any reason other than "not there": on a shared
/// network folder a read can fail for a moment (a dropped connection, another computer replacing the file, a scanner
/// holding it) and a start-up decision must not be taken on such a moment.
pub fn read_text_retrying(file: &Path, attempts: u32, pause: Duration) -> ReadText {
    let mut last = None;
    for attempt in 0..attempts.max(1) {
        if attempt > 0 {
            std::thread::sleep(pause);
        }
        match std::fs::read_to_string(file) {
            Ok(text) => return ReadText::Text(text),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return ReadText::Missing,
            // Not UTF-8 is a damaged file, not a passing problem.
            Err(err) if err.kind() == std::io::ErrorKind::InvalidData => {
                return ReadText::Failed(err)
            }
            Err(err) => last = Some(err),
        }
    }
    ReadText::Failed(last.unwrap_or_else(|| std::io::Error::other("unknown read failure")))
}

/// The retry policy of start-up reads (about one second at most).
pub const START_READ_ATTEMPTS: u32 = 5;
pub const START_READ_PAUSE: Duration = Duration::from_millis(250);

pub fn read(exe_dir: &Path) -> InstallRecord {
    match read_text_retrying(
        &install_file(exe_dir),
        START_READ_ATTEMPTS,
        START_READ_PAUSE,
    ) {
        ReadText::Missing => InstallRecord::Missing,
        ReadText::Failed(err) => InstallRecord::Unreadable(err.to_string()),
        ReadText::Text(text) => match serde_json::from_str::<InstallMetadata>(&text) {
            Ok(meta) if meta.format != INSTALL_FORMAT => InstallRecord::Unreadable(format!(
                "format \"{}\" is not {INSTALL_FORMAT}",
                meta.format
            )),
            Ok(meta) if meta.schema_version > SCHEMA_VERSION => InstallRecord::Unreadable(format!(
                "schema version {} is newer than this version reads ({SCHEMA_VERSION})",
                meta.schema_version
            )),
            Ok(meta) => InstallRecord::Found(meta),
            Err(err) => InstallRecord::Unreadable(err.to_string()),
        },
    }
}

/// Writes `install.json` (atomically). Only the installers call this, through `--integration set-layout`.
pub fn write(exe_dir: &Path, layout: InstallLayout, app_version: &str) -> std::io::Result<()> {
    let earlier = match read(exe_dir) {
        InstallRecord::Found(meta) => Some(meta),
        _ => None,
    };
    let installed_at = earlier
        .as_ref()
        .filter(|meta| meta.layout == layout)
        .map(|meta| meta.installed_at.clone())
        .unwrap_or_else(rfc3339_now);
    let meta = InstallMetadata {
        format: INSTALL_FORMAT.into(),
        schema_version: SCHEMA_VERSION,
        layout,
        installed_at,
        app_version: app_version.into(),
        // An update rewrites the layout; the administrator's shortcut choice stays.
        user_desktop_shortcuts: earlier.and_then(|meta| meta.user_desktop_shortcuts),
    };
    write_metadata(exe_dir, &meta)
}

/// Records whether each Windows user gets a Desktop shortcut at their first start. Only for a copy whose installer
/// wrote `install.json` (the layout is never guessed here).
pub fn set_user_desktop_shortcuts(exe_dir: &Path, on: bool) -> std::io::Result<InstallMetadata> {
    let mut meta =
        match read(exe_dir) {
            InstallRecord::Found(meta) => meta,
            InstallRecord::Missing => return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "there is no install.json: set the layout first (--integration set-layout network)",
            )),
            InstallRecord::Unreadable(reason) => {
                return Err(std::io::Error::other(format!(
                    "install.json can't be used: {reason}"
                )))
            }
        };
    meta.user_desktop_shortcuts = Some(on);
    write_metadata(exe_dir, &meta)?;
    Ok(meta)
}

fn write_metadata(exe_dir: &Path, meta: &InstallMetadata) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(meta).map_err(std::io::Error::other)?;
    write_atomic(&install_file(exe_dir), text.as_bytes())
}

/// What the program itself knows about how it was installed, when there is no `install.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallerHint {
    /// `uninstall.exe` next to the program (the per-user setup).
    Nsis,
    /// Inside Program Files (the per-machine MSI).
    Msi,
    Portable,
}

/// The layout of a copy without `install.json`. A per-user setup placed in a **network folder** is a network
/// installation: one database next to the program would be opened by every computer at once.
pub fn infer_layout(hint: InstallerHint, remote: bool) -> InstallLayout {
    match hint {
        InstallerHint::Msi => InstallLayout::PerMachine,
        InstallerHint::Nsis if remote => InstallLayout::Network,
        InstallerHint::Nsis => InstallLayout::PerUser,
        InstallerHint::Portable => InstallLayout::Portable,
    }
}

/// A path for comparing and hashing: no `\\?\` prefix, backslashes, no trailing separator, lower case on Windows.
pub fn normalized_key_path(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\");
    let text = if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        text
    };
    let trimmed = text.trim_end_matches('\\');
    let kept = if trimmed.is_empty() || trimmed.ends_with(':') {
        text.as_str()
    } else {
        trimmed
    };
    if cfg!(windows) {
        kept.to_lowercase()
    } else {
        kept.replace('\\', "/")
    }
}

/// 16 hex digits naming one installation folder on this computer (a hash: never a path).
pub fn install_key(install_dir: &Path) -> String {
    let digest = Sha256::digest(format!(
        "openmind-studio:install:v1\n{}",
        normalized_key_path(install_dir)
    ));
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// `%LOCALAPPDATA%\OpenMind\Studio\Installations` (Windows), `~/Library/Application Support/OpenMind Studio/Installations`
/// (macOS), `$XDG_STATE_HOME/openmind-studio/installations` (else `~/.local/state/...`).
pub fn local_installations_root() -> Option<PathBuf> {
    let abs = |name: &str| {
        std::env::var_os(name)
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
    };
    if cfg!(windows) {
        abs("LOCALAPPDATA").map(|dir| dir.join("OpenMind").join("Studio").join("Installations"))
    } else if cfg!(target_os = "macos") {
        abs("HOME").map(|home| {
            home.join("Library")
                .join("Application Support")
                .join("OpenMind Studio")
                .join("Installations")
        })
    } else {
        abs("XDG_STATE_HOME")
            .or_else(|| abs("HOME").map(|home| home.join(".local").join("state")))
            .map(|dir| dir.join("openmind-studio").join("installations"))
    }
}

/// The folder `install_dir` really is: a mapped drive (`Z:\OpenMind Studio`) becomes its `\\server\share` path, a
/// `subst` drive or a junction its target. The same installation then has one key however it was started — from the
/// UNC shortcut or from the mapped drive in Explorer. When the folder can't be resolved for a moment (a network blip
/// while the computer starts the program), a mapped drive is still named by its `\\server\share` path
/// ([`universal_path`]): resolving it as typed would give that start another key — an empty profile, "my settings are
/// gone". Anything else that can't be resolved is used as given.
pub fn resolved_install_dir(install_dir: &Path) -> PathBuf {
    std::fs::canonicalize(install_dir).unwrap_or_else(|_| universal_path(install_dir))
}

/// `Z:\dir` -> `\\server\share\dir` when `Z:` is a network drive (Windows asks its own record of the mapping, so this
/// works while the share is unreachable); any other path as it is.
#[cfg(windows)]
pub fn universal_path(path: &Path) -> PathBuf {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use winapi::um::winnetwk::{
        WNetGetUniversalNameW, UNIVERSAL_NAME_INFOW, UNIVERSAL_NAME_INFO_LEVEL,
    };
    if !is_remote_path(path) || path.to_string_lossy().starts_with(r"\\") {
        return path.to_path_buf();
    }
    let local: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut size: u32 = 2048;
    let mut buffer = vec![0u8; size as usize];
    // SAFETY: `local` is NUL-terminated; `buffer` holds `size` bytes, and on success starts with a UNIVERSAL_NAME_INFOW
    // whose pointer refers into the same buffer.
    let universal = unsafe {
        let status = WNetGetUniversalNameW(
            local.as_ptr(),
            UNIVERSAL_NAME_INFO_LEVEL,
            buffer.as_mut_ptr().cast(),
            &mut size,
        );
        if status != 0 {
            return path.to_path_buf();
        }
        let info = &*(buffer.as_ptr() as *const UNIVERSAL_NAME_INFOW);
        if info.lpUniversalName.is_null() {
            return path.to_path_buf();
        }
        let len = (0..)
            .take_while(|&i| *info.lpUniversalName.add(i) != 0)
            .count();
        std::slice::from_raw_parts(info.lpUniversalName, len).to_vec()
    };
    PathBuf::from(std::ffi::OsString::from_wide(&universal))
}

#[cfg(not(windows))]
pub fn universal_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

/// This installation's folder on this computer for this Windows user (see the module text).
pub fn local_install_dir(install_dir: &Path) -> Option<PathBuf> {
    local_installations_root().map(|root| local_install_dir_in(&root, install_dir))
}

/// [`local_install_dir`] under `root`. The key is taken from the resolved folder; a folder an earlier version made from
/// the path as it was started is still used while it is the only one, so nobody's data moves.
pub fn local_install_dir_in(root: &Path, install_dir: &Path) -> PathBuf {
    let resolved = root.join(install_key(&resolved_install_dir(install_dir)));
    let as_started = root.join(install_key(install_dir));
    if as_started != resolved && !resolved.exists() && as_started.exists() {
        return as_started;
    }
    resolved
}

/// What this computer remembers about one installation (in its [`local_install_dir`]): the data scope that was chosen
/// there, so a moment when the shared `data/data-scope.json` can't be read never brings the setup back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallState {
    pub format: String,
    pub schema_version: u32,
    /// The folder this record belongs to, as the program saw it (shown only; the key is what matches).
    pub install_dir: String,
    pub layout: InstallLayout,
    /// The data scope in force (`personal` / `perMachine`), when the copy has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_scope: Option<crate::DataScope>,
    pub first_started_at: String,
    pub last_started_at: String,
    pub app_version: String,
}

pub fn read_state(local_dir: &Path) -> Option<InstallState> {
    match read_text_retrying(&local_dir.join(STATE_FILE), 2, Duration::from_millis(50)) {
        ReadText::Text(text) => serde_json::from_str::<InstallState>(&text)
            .ok()
            .filter(|state| state.format == STATE_FORMAT && state.schema_version <= SCHEMA_VERSION),
        _ => None,
    }
}

/// Records a successful start (keeps the first start's date).
pub fn record_start(
    local_dir: &Path,
    install_dir: &Path,
    layout: InstallLayout,
    data_scope: Option<crate::DataScope>,
    app_version: &str,
) -> std::io::Result<()> {
    let now = rfc3339_now();
    let first = read_state(local_dir)
        .map(|state| state.first_started_at)
        .unwrap_or_else(|| now.clone());
    let state = InstallState {
        format: STATE_FORMAT.into(),
        schema_version: SCHEMA_VERSION,
        install_dir: install_dir.display().to_string(),
        layout,
        data_scope,
        first_started_at: first,
        last_started_at: now,
        app_version: app_version.into(),
    };
    let text = serde_json::to_string_pretty(&state).map_err(std::io::Error::other)?;
    write_atomic(&local_dir.join(STATE_FILE), text.as_bytes())
}

/// Whether `path` is on another computer: a UNC path (`\\server\share`), or a drive letter Windows maps to a network
/// share. A local path, `\\?\C:\...` and `\\.\` device paths are not.
pub fn is_remote_path(path: &Path) -> bool {
    let text = path.to_string_lossy().replace('/', "\\");
    if text.starts_with(r"\\?\UNC\") {
        return true;
    }
    if text.starts_with(r"\\?\") || text.starts_with(r"\\.\") {
        return drive_is_remote(&text[4..]);
    }
    if text.starts_with(r"\\") {
        return true;
    }
    drive_is_remote(&text)
}

#[cfg(windows)]
fn drive_is_remote(text: &str) -> bool {
    use std::os::windows::ffi::OsStrExt;
    let bytes = text.as_bytes();
    if bytes.len() < 2 || bytes[1] != b':' || !bytes[0].is_ascii_alphabetic() {
        return false;
    }
    let root: Vec<u16> = std::ffi::OsStr::new(&format!("{}:\\", &text[..1]))
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: `root` is a NUL-terminated UTF-16 string that lives across the call.
    let kind = unsafe { winapi::um::fileapi::GetDriveTypeW(root.as_ptr()) };
    kind == winapi::um::winbase::DRIVE_REMOTE
}

#[cfg(not(windows))]
fn drive_is_remote(_text: &str) -> bool {
    false
}

/// Whether the program runs from a temporary folder — Explorer's "open the ZIP and double-click" extracts it to
/// `%TEMP%\Temp1_<name>.zip\` and deletes it afterwards, so every choice and the whole database would be lost.
pub fn runs_from_temporary_folder(exe_dir: &Path, temp_dir: &Path) -> bool {
    let exe = normalized_key_path(exe_dir);
    let temp = normalized_key_path(temp_dir);
    if !temp.is_empty()
        && (exe == temp
            || exe.starts_with(&format!("{temp}\\"))
            || exe.starts_with(&format!("{temp}/")))
    {
        return true;
    }
    Path::new(&exe)
        .components()
        .any(|component| match component {
            Component::Normal(name) => {
                let name = name.to_string_lossy().to_lowercase();
                name.starts_with("temp") && name.contains('_') && name.ends_with(".zip")
            }
            _ => false,
        })
}

#[cfg(test)]
#[path = "install_tests.rs"]
mod tests;
