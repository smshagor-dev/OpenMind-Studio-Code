//! Which computer the app runs on. In the per-computer data scope (see [`crate::data_scope`]) each computer gets its
//! own folder, `data/machines/<profile id>/`, named by a hash of what *this computer* says about itself.
//!
//! **Only the computer decides.** The inputs are read from the operating system and the firmware; nothing on the
//! portable drive (no `machine.json`, no scope file, no database, no drive serial or letter, no install folder) and not
//! the computer name is ever an input. So the same computer always finds the same profile (any drive letter, after a
//! rename, after an update), and another computer never does.
//!
//! **Signals** ([`MachineSignals`], all read-only, none needs administrator rights):
//! - `os_id` — Windows `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`, Linux `/etc/machine-id`, macOS has none;
//! - `hardware_uuid` — the SMBIOS system UUID (Windows `GetSystemFirmwareTable('RSMB')`, Linux
//!   `/sys/class/dmi/id/product_uuid` when readable, macOS `IOPlatformUUID`);
//! - `hardware_serial` — the SMBIOS system serial number (macOS `IOPlatformSerialNumber`), used **only when there is
//!   no valid hardware UUID**, so a serial that a BIOS update turns into a placeholder can't move a computer that
//!   has a UUID to a new profile.
//!
//! Lab PCs cloned from one Windows image often share `MachineGuid`; their SMBIOS UUIDs (or serials) differ, so they get
//! different profiles. Placeholder values that vendors and cloned images leave behind (empty, all zeros, all `F`,
//! `To Be Filled By O.E.M.`, `Default string`, `03000200-0400-0500-0006-000700080009` ...) are dropped before hashing.
//!
//! **Hash** (identity version [`IDENTITY_VERSION`]): `SHA-256("openmind-studio:v1:\n" + tuple)` where the tuple is
//! `os_id=<v>\nhardware_uuid=<v>\nhardware_serial=<v>\n` in that fixed order (an absent value is empty). The full hex
//! hash is the [`MachineIdentity::identity_hash`]; the profile folder is its first [`PROFILE_ID_LEN`] characters
//! (longer on a prefix collision: see [`crate::machine_paths::select_profile`]).
//!
//! **Fallback** when neither `os_id` nor `hardware_uuid` (nor a serial) is usable: a random id kept on *this computer*
//! (`%LOCALAPPDATA%\OpenMind Studio\machine-id`, `~/.local/state/openmind-studio/machine-id`, ...), never on the portable
//! drive, written once and reused; if it can't be saved, a random id for this run only ([`IdentitySource::Ephemeral`]).
//! `%LOCALAPPDATA%` is per Windows user, so on a computer with no usable signal two accounts get two profiles.
//!
//! The raw values and the tuple exist only inside [`resolve_with`] while they are hashed: they are never logged,
//! stored, returned, shown or used as a path, and no error message carries them.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// The identity algorithm's version; part of the hashed text. A future `v2` must keep finding `v1` profiles (see
/// `docs/data-scope.md`, "Identity versions").
pub const IDENTITY_VERSION: u32 = 1;

/// How many hex characters of the hash name a profile normally (48 bits).
pub const PROFILE_ID_LEN: usize = 12;

/// Profile id lengths, shortest first: the next one is used when a shorter one belongs to another computer.
pub const PROFILE_ID_LENGTHS: [usize; 5] = [PROFILE_ID_LEN, 16, 24, 32, 64];

/// The file the generated fallback id is kept in, under [`local_state_dir`].
const PERSISTED_FILE: &str = "machine-id";

/// Set (debug builds only) to `os=<v>;uuid=<v>;serial=<v>` to start as another computer: manual multi-PC tests.
const SIMULATE_ENV: &str = "OPENMIND_SIMULATE_MACHINE";

/// Where a computer's identity came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IdentitySource {
    /// The operating system and firmware signals.
    System,
    /// OpenMind's own id, saved on this computer by an earlier start.
    Persisted,
    /// OpenMind's own id, generated and saved on this computer now.
    Generated,
    /// A random id for this run only: nothing usable could be read or saved (the profile won't be found again).
    Ephemeral,
}

/// The computer the app runs on: only derived hashes are kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MachineIdentity {
    identity_hash: String,
    source: IdentitySource,
}

impl MachineIdentity {
    /// An identity from an already derived full hash (64 lower-case hex characters).
    pub fn from_hash(identity_hash: String, source: IdentitySource) -> Option<Self> {
        is_hash(&identity_hash).then_some(Self {
            identity_hash,
            source,
        })
    }

    /// The full SHA-256 hex hash (also stored in `machine.json` to recognise the profile; not reversible).
    pub fn identity_hash(&self) -> &str {
        &self.identity_hash
    }

    /// The profile id of the usual length ([`PROFILE_ID_LEN`]).
    pub fn profile_id(&self) -> &str {
        &self.identity_hash[..PROFILE_ID_LEN]
    }

    /// The candidate profile ids, shortest first ([`PROFILE_ID_LENGTHS`]).
    pub fn candidate_ids(&self) -> impl Iterator<Item = &str> {
        PROFILE_ID_LENGTHS
            .iter()
            .map(|len| &self.identity_hash[..*len])
    }

    pub fn source(&self) -> IdentitySource {
        self.source
    }
}

/// Whether `text` is a usable profile id (also refuses anything that could leave `data/machines/`).
pub fn is_profile_id(text: &str) -> bool {
    PROFILE_ID_LENGTHS.contains(&text.len()) && is_lower_hex(text)
}

fn is_hash(text: &str) -> bool {
    text.len() == 64 && is_lower_hex(text)
}

fn is_lower_hex(text: &str) -> bool {
    text.bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// What one computer says about itself, as read (not yet validated).
#[derive(Default, Clone, PartialEq, Eq)]
pub struct MachineSignals {
    pub os_id: Option<String>,
    pub hardware_uuid: Option<String>,
    pub hardware_serial: Option<String>,
}

/// Never prints the values.
impl std::fmt::Debug for MachineSignals {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MachineSignals")
            .field("os_id", &self.os_id.is_some())
            .field("hardware_uuid", &self.hardware_uuid.is_some())
            .field("hardware_serial", &self.hardware_serial.is_some())
            .finish()
    }
}

/// The validated, normalized tuple in its fixed order, or `None` when nothing in it identifies the computer.
pub fn canonical_tuple(signals: &MachineSignals) -> Option<String> {
    let os_id = signals.os_id.as_deref().and_then(normalize_uuid);
    let uuid = signals.hardware_uuid.as_deref().and_then(normalize_uuid);
    // A serial only stands in for a missing UUID (see the module text).
    let serial = match uuid {
        Some(_) => None,
        None => signals
            .hardware_serial
            .as_deref()
            .and_then(normalize_serial),
    };
    if os_id.is_none() && uuid.is_none() && serial.is_none() {
        return None;
    }
    Some(format!(
        "os_id={}\nhardware_uuid={}\nhardware_serial={}\n",
        os_id.unwrap_or_default(),
        uuid.unwrap_or_default(),
        serial.unwrap_or_default()
    ))
}

/// `SHA-256("openmind-studio:v1:\n" + tuple)` as 64 lower-case hex characters.
pub fn identity_hash(tuple: &str) -> String {
    let digest =
        Sha256::digest(format!("openmind-studio:v{IDENTITY_VERSION}:\n{tuple}").as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// A UUID/GUID as 32 hex digits in the `8-4-4-4-12` form, lower case; `None` for anything malformed or a placeholder.
pub fn normalize_uuid(raw: &str) -> Option<String> {
    let hex: String = raw
        .trim()
        .trim_matches(|c| c == '{' || c == '}')
        .chars()
        .filter(|c| *c != '-')
        .collect::<String>()
        .to_ascii_lowercase();
    if hex.len() != 32 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let first = hex.as_bytes()[0];
    if hex.bytes().all(|b| b == first) {
        return None; // all zeros, all F, any one repeated digit
    }
    let formatted = format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    );
    (!PLACEHOLDER_UUIDS.contains(&formatted.as_str())).then_some(formatted)
}

/// UUIDs shipped unchanged on many boards (so not one computer's).
const PLACEHOLDER_UUIDS: &[&str] = &[
    "03000200-0400-0500-0006-000700080009",
    "01234567-89ab-cdef-0123-456789abcdef",
    "12345678-1234-5678-90ab-cddeefaabbcc",
];

/// A serial number trimmed, inner spaces collapsed, upper case; `None` for a placeholder or something too short.
pub fn normalize_serial(raw: &str) -> Option<String> {
    let text = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let upper = text.to_ascii_uppercase();
    let alnum: Vec<char> = upper.chars().filter(char::is_ascii_alphanumeric).collect();
    if alnum.len() < 4 || alnum.iter().all(|c| *c == alnum[0]) {
        return None;
    }
    let squashed: String = upper
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == ' ')
        .collect();
    if PLACEHOLDER_SERIALS
        .iter()
        .any(|p| squashed.trim() == *p || squashed.trim().starts_with(&format!("{p} ")))
    {
        return None;
    }
    if upper.chars().any(char::is_control) {
        return None;
    }
    Some(upper)
}

/// Serials (upper case, punctuation removed) that vendors leave in place of a real one.
const PLACEHOLDER_SERIALS: &[&str] = &[
    "TO BE FILLED BY OEM",
    "DEFAULT STRING",
    "SYSTEM SERIAL NUMBER",
    "CHASSIS SERIAL NUMBER",
    "BASE BOARD SERIAL NUMBER",
    "SERIAL NUMBER",
    "UNKNOWN",
    "NONE",
    "NOT SPECIFIED",
    "NOT APPLICABLE",
    "NOT AVAILABLE",
    "NA",
    "INVALID",
    "OEM",
    "O E M",
    "EMPTY",
    "NULL",
    "123456789",
    "1234567890",
    "0123456789",
    "SYSTEM PRODUCT NAME",
];

/// What [`resolve_with`] reads from the computer; the real one is [`SystemProbe`].
pub trait IdentityProbe {
    /// The operating system's and firmware's signals.
    fn signals(&self) -> MachineSignals;
    /// The file OpenMind's fallback id is kept in on this computer.
    fn persisted_file(&self) -> Option<PathBuf>;
    /// A new random id (32 hex characters).
    fn generate(&self) -> Option<String>;
}

/// Resolves this computer's identity; never fails. `app_root` is only used to refuse a fallback file on the drive.
pub fn resolve(app_root: &Path) -> MachineIdentity {
    resolve_with(&SystemProbe, app_root)
}

pub fn resolve_with(probe: &dyn IdentityProbe, app_root: &Path) -> MachineIdentity {
    if let Some(tuple) = canonical_tuple(&probe.signals()) {
        return identity(&tuple, IdentitySource::System);
    }
    tracing::warn!(
        "System machine identifier unavailable. Using OpenMind fallback device identity."
    );
    // The fallback id must stay on this computer: a file inside the portable folder would travel to the next PC.
    let file = probe
        .persisted_file()
        .filter(|file| !inside(file, app_root));
    if let Some(id) = file.as_deref().and_then(read_persisted) {
        return identity(&fallback_tuple(&id), IdentitySource::Persisted);
    }
    if let Some(id) = probe.generate() {
        if let Some(file) = file.as_deref() {
            match write_persisted(file, &id) {
                // Another start may have written its own id first: use whichever is on disk.
                Ok(()) => {
                    if let Some(saved) = read_persisted(file) {
                        let source = if saved == id {
                            IdentitySource::Generated
                        } else {
                            IdentitySource::Persisted
                        };
                        return identity(&fallback_tuple(&saved), source);
                    }
                }
                Err(err) => tracing::warn!(
                    error_kind = ?err.kind(),
                    "couldn't save OpenMind's fallback device identity on this computer"
                ),
            }
        }
        tracing::warn!("OpenMind's fallback device identity is used for this run only");
        return identity(&fallback_tuple(&id), IdentitySource::Ephemeral);
    }
    // No randomness at all (practically impossible): still never a shared or name-based identity.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let id = format!("{nanos:032x}{:08x}", std::process::id());
    identity(&fallback_tuple(&id), IdentitySource::Ephemeral)
}

fn fallback_tuple(id: &str) -> String {
    format!("fallback_id={id}\n")
}

fn identity(tuple: &str, source: IdentitySource) -> MachineIdentity {
    MachineIdentity {
        identity_hash: identity_hash(tuple),
        source,
    }
}

/// Whether `path` lies inside `root` (compared as given and, when both exist, canonicalized).
fn inside(path: &Path, root: &Path) -> bool {
    if path.starts_with(root) {
        return true;
    }
    let canonical = |p: &Path| {
        p.ancestors()
            .find_map(|a| std::fs::canonicalize(a).ok().map(|c| (a.to_path_buf(), c)))
            .map(|(a, c)| c.join(p.strip_prefix(&a).unwrap_or(Path::new(""))))
    };
    match (canonical(path), std::fs::canonicalize(root).ok()) {
        (Some(path), Some(root)) => path.starts_with(root),
        _ => false,
    }
}

fn read_persisted(file: &Path) -> Option<String> {
    let text = std::fs::read_to_string(file).ok()?;
    let id = text.trim();
    (id.len() == 32 && is_lower_hex(id)).then(|| id.to_string())
}

/// Writes the id only when the file doesn't exist yet (an existing one is never replaced).
fn write_persisted(file: &Path, id: &str) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(file)
    {
        Ok(mut handle) => {
            handle.write_all(id.as_bytes())?;
            handle.sync_all()
        }
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(err) => Err(err),
    }
}

/// The real computer.
pub struct SystemProbe;

impl IdentityProbe for SystemProbe {
    fn signals(&self) -> MachineSignals {
        if cfg!(debug_assertions) {
            if let Some(simulated) = std::env::var(SIMULATE_ENV)
                .ok()
                .and_then(|v| parse_simulated(&v))
            {
                return simulated;
            }
        }
        crate::machine_signals::read()
    }

    fn persisted_file(&self) -> Option<PathBuf> {
        local_state_dir().map(|dir| dir.join(PERSISTED_FILE))
    }

    fn generate(&self) -> Option<String> {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).ok()?;
        Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
    }
}

/// `os=<v>;uuid=<v>;serial=<v>` (each part optional), for [`SIMULATE_ENV`].
fn parse_simulated(text: &str) -> Option<MachineSignals> {
    let mut signals = MachineSignals::default();
    for part in text.split(';') {
        let (key, value) = part.split_once('=')?;
        let value = Some(value.trim().to_string()).filter(|v| !v.is_empty());
        match key.trim() {
            "os" => signals.os_id = value,
            "uuid" => signals.hardware_uuid = value,
            "serial" => signals.hardware_serial = value,
            _ => return None,
        }
    }
    Some(signals)
}

/// A per-user folder on this computer (never the portable drive) for OpenMind's fallback id: `%LOCALAPPDATA%\OpenMind
/// Studio` on Windows, `~/Library/Application Support/OpenMind Studio` on macOS, `$XDG_STATE_HOME/openmind-studio`
/// (else `~/.local/state/openmind-studio`) elsewhere. Only used when the computer's own signals can't be read.
pub fn local_state_dir() -> Option<PathBuf> {
    let abs = |name: &str| {
        std::env::var_os(name)
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
    };
    if cfg!(windows) {
        abs("LOCALAPPDATA").map(|dir| dir.join("OpenMind Studio"))
    } else if cfg!(target_os = "macos") {
        abs("HOME").map(|home| {
            home.join("Library")
                .join("Application Support")
                .join("OpenMind Studio")
        })
    } else {
        abs("XDG_STATE_HOME")
            .or_else(|| abs("HOME").map(|home| home.join(".local").join("state")))
            .map(|dir| dir.join("openmind-studio"))
    }
}

#[cfg(test)]
#[path = "machine_identity_tests.rs"]
mod tests;
