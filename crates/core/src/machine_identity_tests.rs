use super::*;

const GUID_CLONED: &str = "6F1C2A4E-9B3D-4C21-8E57-0D2B9A6C1F34";
const GUID_OTHER: &str = "{a1b2c3d4-0000-4000-8000-112233445566}";
const UUID_A: &str = "4C4C4544-0042-3510-8051-B3C04F4D3432";
const UUID_B: &str = "4C4C4544-0057-4810-8031-C2C04F4E3432";

struct Probe {
    signals: MachineSignals,
    file: Option<PathBuf>,
    random: Option<&'static str>,
}

impl IdentityProbe for Probe {
    fn signals(&self) -> MachineSignals {
        self.signals.clone()
    }
    fn persisted_file(&self) -> Option<PathBuf> {
        self.file.clone()
    }
    fn generate(&self) -> Option<String> {
        self.random.map(str::to_string)
    }
}

fn pc(os: Option<&str>, uuid: Option<&str>, serial: Option<&str>) -> Probe {
    Probe {
        signals: MachineSignals {
            os_id: os.map(str::to_string),
            hardware_uuid: uuid.map(str::to_string),
            hardware_serial: serial.map(str::to_string),
        },
        file: None,
        random: None,
    }
}

fn id(probe: &Probe) -> MachineIdentity {
    resolve_with(probe, Path::new("G:/OpenMind-Studio"))
}

#[test]
fn cloned_lab_pcs_with_one_machine_guid_get_different_profiles() {
    let pc_a = id(&pc(Some(GUID_CLONED), Some(UUID_A), None));
    let pc_b = id(&pc(Some(GUID_CLONED), Some(UUID_B), None));
    assert_ne!(pc_a.profile_id(), pc_b.profile_id());
    assert_ne!(pc_a.identity_hash(), pc_b.identity_hash());
    assert_eq!(pc_a.source(), IdentitySource::System);
}

#[test]
fn the_same_smbios_uuid_with_another_machine_guid_is_another_profile() {
    let one = id(&pc(Some(GUID_CLONED), Some(UUID_A), None));
    let two = id(&pc(Some(GUID_OTHER), Some(UUID_A), None));
    assert_ne!(one.profile_id(), two.profile_id());
}

#[test]
fn the_same_computer_always_gets_the_same_profile_whatever_the_formatting() {
    let first = id(&pc(Some(GUID_CLONED), Some(UUID_A), Some("ABC123")));
    let again = id(&pc(
        Some(&format!("  {{{}}} ", GUID_CLONED.to_lowercase())),
        Some(&UUID_A.replace('-', "").to_lowercase()),
        Some("abc123"),
    ));
    assert_eq!(first, again);
    assert_eq!(first.profile_id().len(), PROFILE_ID_LEN);
    assert!(first.identity_hash().starts_with(first.profile_id()));
}

#[test]
fn neither_the_computer_name_nor_the_drive_is_an_input() {
    // The probe has no way to see either: renaming the PC or moving the drive can't change the profile.
    let before = id(&pc(Some(GUID_CLONED), Some(UUID_A), None));
    let on_h = resolve_with(
        &pc(Some(GUID_CLONED), Some(UUID_A), None),
        Path::new("H:/OpenMind-Studio"),
    );
    let on_e = resolve_with(
        &pc(Some(GUID_CLONED), Some(UUID_A), None),
        Path::new("E:/x/y"),
    );
    assert_eq!(before, on_h);
    assert_eq!(before, on_e);
}

#[test]
fn placeholder_uuids_and_serials_are_ignored() {
    let real = id(&pc(Some(GUID_CLONED), None, None));
    for junk in [
        "00000000-0000-0000-0000-000000000000",
        "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
        "03000200-0400-0500-0006-000700080009",
        "",
        "not-a-uuid",
        "1234",
    ] {
        assert_eq!(
            id(&pc(Some(GUID_CLONED), Some(junk), None)),
            real,
            "{junk:?}"
        );
    }
    for junk in [
        "To Be Filled By O.E.M.",
        "Default string",
        "System Serial Number",
        "Unknown",
        "None",
        "Not Specified",
        "  ",
        "0000000",
        "N/A",
    ] {
        assert_eq!(
            id(&pc(Some(GUID_CLONED), None, Some(junk))),
            real,
            "{junk:?}"
        );
        assert_eq!(normalize_serial(junk), None, "{junk:?}");
    }
}

#[test]
fn a_serial_only_counts_when_there_is_no_uuid() {
    let with_uuid = id(&pc(Some(GUID_CLONED), Some(UUID_A), Some("SERIAL-1")));
    let serial_changed = id(&pc(Some(GUID_CLONED), Some(UUID_A), Some("SERIAL-2")));
    assert_eq!(
        with_uuid, serial_changed,
        "a UUID machine ignores its serial"
    );
    let no_uuid_1 = id(&pc(Some(GUID_CLONED), None, Some("SERIAL-1")));
    let no_uuid_2 = id(&pc(Some(GUID_CLONED), None, Some("SERIAL-2")));
    assert_ne!(
        no_uuid_1, no_uuid_2,
        "cloned PCs without UUIDs are told apart by serial"
    );
}

#[test]
fn the_tuple_has_a_fixed_order_and_version() {
    let tuple = canonical_tuple(&pc(Some(GUID_CLONED), Some(UUID_A), None).signals).expect("tuple");
    assert_eq!(
        tuple,
        "os_id=6f1c2a4e-9b3d-4c21-8e57-0d2b9a6c1f34\nhardware_uuid=4c4c4544-0042-3510-8051-b3c04f4d3432\nhardware_serial=\n"
    );
    // Pinned: changing the algorithm by accident would move every computer to a new profile.
    assert_eq!(
        identity_hash(&tuple),
        identity_hash("os_id=6f1c2a4e-9b3d-4c21-8e57-0d2b9a6c1f34\nhardware_uuid=4c4c4544-0042-3510-8051-b3c04f4d3432\nhardware_serial=\n")
    );
    let digest = Sha256::digest(format!("openmind-studio:v1:\n{tuple}").as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(identity_hash(&tuple), hex);
}

#[test]
fn the_fallback_id_is_kept_on_this_computer_and_reused() {
    let local = tempfile::tempdir().expect("tempdir");
    let file = local.path().join("OpenMind Studio").join("machine-id");
    let mut probe = pc(None, Some("00000000-0000-0000-0000-000000000000"), None);
    probe.file = Some(file.clone());
    probe.random = Some("0123456789abcdef0123456789abcdef");
    let first = id(&probe);
    assert_eq!(first.source(), IdentitySource::Generated);
    probe.random = Some("ffffffffffffffff0000000000000000");
    let again = id(&probe);
    assert_eq!(again.source(), IdentitySource::Persisted);
    assert_eq!(
        first.profile_id(),
        again.profile_id(),
        "same computer after a restart"
    );
}

#[test]
fn the_fallback_never_lives_on_the_portable_drive() {
    let drive = tempfile::tempdir().expect("tempdir");
    let on_drive = drive.path().join("data").join("machine-id");
    std::fs::create_dir_all(on_drive.parent().expect("parent")).expect("dir");
    std::fs::write(&on_drive, "0123456789abcdef0123456789abcdef").expect("planted");
    let mut probe = pc(None, None, None);
    probe.file = Some(on_drive.clone());
    probe.random = Some("aaaaaaaaaaaaaaaa1111111111111111");
    let identity = resolve_with(&probe, drive.path());
    // The planted file is not read and nothing is written to the drive: this run's id is not saved.
    assert_eq!(identity.source(), IdentitySource::Ephemeral);
    assert_eq!(
        std::fs::read_to_string(&on_drive).expect("read"),
        "0123456789abcdef0123456789abcdef"
    );
    let other_pc = resolve_with(&probe, drive.path());
    assert_eq!(other_pc.source(), IdentitySource::Ephemeral);
}

#[test]
fn an_unsaveable_fallback_is_used_for_this_run_only() {
    let mut probe = pc(None, None, None);
    probe.random = Some("0123456789abcdef0123456789abcdef");
    assert_eq!(id(&probe).source(), IdentitySource::Ephemeral);
}

#[test]
fn raw_values_never_appear_in_an_identity_or_its_debug_text() {
    let probe = pc(Some(GUID_CLONED), Some(UUID_A), Some("SN-SECRET-9"));
    let identity = id(&probe);
    let text = format!("{identity:?} {:?}", probe.signals);
    for raw in [GUID_CLONED, UUID_A, "SN-SECRET-9", "6f1c2a4e", "4c4c4544"] {
        assert!(
            !text.to_lowercase().contains(&raw.to_lowercase()),
            "{raw} in {text}"
        );
        assert!(!identity.identity_hash().contains(&raw.to_lowercase()));
    }
}

#[test]
fn profile_ids_are_checked_before_they_become_paths() {
    let identity = id(&pc(Some(GUID_CLONED), Some(UUID_A), None));
    let lengths: Vec<usize> = identity.candidate_ids().map(str::len).collect();
    assert_eq!(lengths, PROFILE_ID_LENGTHS.to_vec());
    for candidate in identity.candidate_ids() {
        assert!(is_profile_id(candidate));
    }
    for bad in [
        "../../evil",
        "",
        "ABCDEF123456",
        "abcdef12345",
        "abcdef12345g",
    ] {
        assert!(!is_profile_id(bad), "{bad}");
    }
    assert!(MachineIdentity::from_hash("abc".into(), IdentitySource::System).is_none());
}

#[test]
fn simulated_machines_parse_only_known_keys() {
    let parsed = parse_simulated("os=G1;uuid=U1;serial=").expect("parse");
    assert_eq!(parsed.os_id.as_deref(), Some("G1"));
    assert_eq!(parsed.hardware_serial, None);
    assert!(parse_simulated("hostname=x").is_none());
}
