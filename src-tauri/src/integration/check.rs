//! `OpenMindStudio.exe --integration check`: what a user or an IT administrator needs to know about this copy on this
//! computer, in plain lines — where the program and this user's data are, whether this user may write to the program
//! folder and the Desktop, whether a Desktop shortcut starts this program — and what to do about anything that is off.
//! It only reads (and creates then deletes one empty test file to learn whether a folder is writable).

use std::path::{Path, PathBuf};

/// Whether this user may create files in a folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Writable {
    Yes,
    No(String),
}

/// This user's Desktop shortcut to the program.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShortcutState {
    /// Starts the program by its network (or only) path.
    Correct(PathBuf),
    /// Starts this program through a drive letter that other computers may not have.
    DriveLetter(PathBuf),
    /// `OpenMind Studio.lnk` starts another program (an older location, another copy).
    OtherProgram(PathBuf, PathBuf),
    Missing,
}

#[derive(Debug, Clone)]
pub struct Report {
    pub exe: PathBuf,
    pub universal: PathBuf,
    pub on_network: bool,
    /// `install.json`'s layout as described by `deploy::describe_layout`.
    pub layout: String,
    pub network_layout: bool,
    pub user_shortcuts: bool,
    pub local_dir: Option<PathBuf>,
    pub local_on_network: bool,
    pub elevated: bool,
    pub program_folder: Writable,
    pub desktop: Result<PathBuf, String>,
    pub desktop_on_network: bool,
    pub desktop_writable: Writable,
    pub shortcut: ShortcutState,
    /// A shortcut to this program on the Public Desktop (every user sees it).
    pub public_shortcut: Option<PathBuf>,
}

/// How to add the shortcut by hand when nothing else may (shown with every refusal).
pub fn manual_steps(target: &Path) -> String {
    format!(
        "To add it by hand: right-click the Desktop > New > Shortcut, enter \"{}\", and name it OpenMind Studio. \
         If your Desktop is locked, start OpenMind Studio from that path (File Explorer or Win+R) or ask your IT \
         administrator to deploy the shortcut (deploy\\README.txt next to the program).",
        target.display()
    )
}

fn yes_no(writable: &Writable, yes: &str) -> String {
    match writable {
        Writable::Yes => yes.to_string(),
        Writable::No(reason) => format!("no ({reason})"),
    }
}

/// The report as text: facts first, then "What to do" (empty when everything is fine).
pub fn render(report: &Report) -> String {
    let mut lines = vec!["OpenMind Studio deployment check".to_string()];
    let mut fact = |label: &str, value: String| lines.push(format!("  {label:<20}{value}"));
    fact("Program:", report.exe.display().to_string());
    if report.universal != report.exe {
        fact("Network path:", report.universal.display().to_string());
    }
    fact(
        "Program folder:",
        format!(
            "{}, {}",
            if report.on_network {
                "on a network share"
            } else {
                "on this computer"
            },
            yes_no(&report.program_folder, "writable by you")
        ),
    );
    fact("Installation:", report.layout.clone());
    if report.network_layout {
        fact(
            "User shortcuts:",
            if report.user_shortcuts {
                "on (each Windows user gets a Desktop shortcut at their first start)".into()
            } else {
                "off (shortcuts are deployed by IT)".into()
            },
        );
    }
    match &report.local_dir {
        Some(dir) => fact(
            "Your data:",
            format!(
                "{} ({})",
                dir.display(),
                if report.local_on_network {
                    "on a network drive"
                } else {
                    "on this computer"
                }
            ),
        ),
        None => fact("Your data:", "next to the program".into()),
    }
    fact(
        "Windows rights:",
        if report.elevated {
            "administrator (elevated)".into()
        } else {
            "standard (no administrator rights needed to run OpenMind Studio)".into()
        },
    );
    match &report.desktop {
        Ok(dir) => fact(
            "Your Desktop:",
            format!(
                "{}{}, {}",
                dir.display(),
                if report.desktop_on_network {
                    " (redirected to a network folder)"
                } else {
                    ""
                },
                yes_no(&report.desktop_writable, "writable")
            ),
        ),
        Err(err) => fact("Your Desktop:", format!("unknown ({err})")),
    }
    fact(
        "Desktop shortcut:",
        match &report.shortcut {
            ShortcutState::Correct(lnk) => format!("{} starts this program", lnk.display()),
            ShortcutState::DriveLetter(lnk) => format!("{} uses a drive letter", lnk.display()),
            ShortcutState::OtherProgram(lnk, target) => {
                format!("{} starts {}", lnk.display(), target.display())
            }
            ShortcutState::Missing => "none on your Desktop".into(),
        },
    );
    if let Some(lnk) = &report.public_shortcut {
        fact(
            "All users' Desktop:",
            format!("{} starts this program", lnk.display()),
        );
    }
    let advice = advice(report);
    if !advice.is_empty() {
        lines.push(String::new());
        lines.push("What to do:".into());
        lines.extend(advice.into_iter().map(|line| format!("  - {line}")));
    }
    lines.join("\n")
}

fn advice(report: &Report) -> Vec<String> {
    let mut advice = Vec::new();
    let repair = "run \"Create Desktop Shortcut\" in the deploy folder next to the program (or OpenMindStudio.exe \
                  --integration desktop-shortcut)";
    let shortcut_needed = report.public_shortcut.is_none();
    match &report.shortcut {
        ShortcutState::Missing if shortcut_needed => match &report.desktop_writable {
            Writable::Yes => advice.push(format!("To get a Desktop shortcut, {repair}.")),
            Writable::No(_) => advice.push(manual_steps(&report.universal)),
        },
        ShortcutState::DriveLetter(_) => advice.push(format!(
            "The shortcut works only where that drive letter is mapped; {repair} to point it at the network path."
        )),
        ShortcutState::OtherProgram(..) => advice.push(format!(
            "The shortcut starts another copy; {repair} if it should start this one."
        )),
        _ => {}
    }
    if report.local_on_network {
        advice.push(
            "Your local data folder (AppData\\Local) is on a network drive. OpenMind Studio keeps its database there; ask \
             IT to keep AppData\\Local on this computer's disk."
                .into(),
        );
    }
    if report.on_network && !report.network_layout {
        advice.push(
            "This copy runs from a network folder but isn't set up as a shared installation. An administrator who may \
             write there runs: OpenMindStudio.exe --integration set-layout network"
                .into(),
        );
    }
    if report.network_layout && matches!(report.program_folder, Writable::No(_)) {
        advice.push(
            "You may only read the shared folder: that's normal. Runtimes and tools are installed there by the person \
             who manages this installation."
                .into(),
        );
    }
    advice
}

/// Whether this user may create a file in `dir` (creates and deletes an empty test file).
pub fn probe_writable(dir: &Path) -> Writable {
    let probe = dir.join(format!(".openmind-write-check-{}", std::process::id()));
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
    {
        Ok(file) => {
            drop(file);
            let _ = std::fs::remove_file(&probe);
            Writable::Yes
        }
        Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
            Writable::No("access denied".into())
        }
        Err(err) => Writable::No(err.to_string()),
    }
}

/// Gathers the report for the program at `exe` (Windows).
#[cfg(windows)]
pub fn gather(exe: &Path) -> Report {
    use super::shortcut;
    use openmind_core::install::{self, InstallLayout, InstallRecord};
    let dir = exe.parent().unwrap_or(exe);
    let universal = shortcut::universal_path(exe);
    let record = install::read(dir);
    let (network_layout, user_shortcuts, local_state) = match &record {
        InstallRecord::Found(meta) => (
            meta.layout == InstallLayout::Network,
            meta.gives_user_desktop_shortcuts(),
            meta.layout.local_state(),
        ),
        _ => (false, false, false),
    };
    let local_dir = local_state
        .then(|| install::local_install_dir(dir))
        .flatten();
    let desktop = shortcut::desktop_dir(false);
    let links = desktop
        .as_ref()
        .map(|dir| shortcut::shortcuts_in(dir, super::provision::SCAN_LIMIT))
        .unwrap_or_default();
    let starts_this = |target: &Path| {
        super::deploy::same_target(target, &universal) || super::deploy::same_target(target, exe)
    };
    let state = if let Some((lnk, target)) = links.iter().find(|(_, target)| starts_this(target)) {
        if super::deploy::same_target(target, &universal) {
            ShortcutState::Correct(lnk.clone())
        } else {
            ShortcutState::DriveLetter(lnk.clone())
        }
    } else if let Some((lnk, target)) = links.iter().find(|(lnk, _)| {
        lnk.file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case(super::deploy::SHORTCUT_NAME))
    }) {
        ShortcutState::OtherProgram(lnk.clone(), target.clone())
    } else {
        ShortcutState::Missing
    };
    let public_shortcut = shortcut::desktop_dir(true)
        .map(|dir| shortcut::shortcuts_in(&dir, super::provision::SCAN_LIMIT))
        .unwrap_or_default()
        .into_iter()
        .find(|(_, target)| starts_this(target))
        .map(|(lnk, _)| lnk);
    let elevated = elevated();
    Report {
        exe: exe.to_path_buf(),
        universal: universal.clone(),
        on_network: install::is_remote_path(exe),
        layout: super::deploy::describe_layout(dir),
        network_layout,
        user_shortcuts,
        local_on_network: local_dir.as_deref().is_some_and(install::is_remote_path),
        local_dir,
        elevated,
        program_folder: probe_writable(dir),
        desktop_on_network: desktop.as_deref().is_ok_and(install::is_remote_path),
        desktop_writable: desktop
            .as_deref()
            .map(probe_writable)
            .unwrap_or_else(|err| Writable::No(err.clone())),
        desktop,
        shortcut: state,
        public_shortcut,
    }
}

/// Whether this process runs with an administrator's full rights (its token is elevated).
#[cfg(windows)]
fn elevated() -> bool {
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::processthreadsapi::{GetCurrentProcess, OpenProcessToken};
    use winapi::um::securitybaseapi::GetTokenInformation;
    use winapi::um::winnt::{TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    let mut token = std::ptr::null_mut();
    // SAFETY: the process pseudo-handle; `token` receives a handle we close below; `info` is a TOKEN_ELEVATION buffer.
    unsafe {
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return false;
        }
        let mut info = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut size = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            (&mut info as *mut TOKEN_ELEVATION).cast(),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut size,
        );
        CloseHandle(token);
        ok != 0 && info.TokenIsElevated != 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report() -> Report {
        Report {
            exe: PathBuf::from(r"Z:\OpenMind Studio\OpenMindStudio.exe"),
            universal: PathBuf::from(r"\\fs01\apps\OpenMind Studio\OpenMindStudio.exe"),
            on_network: true,
            layout: "network (install.json, written by 1.0.3 on 2026-10-13)".into(),
            network_layout: true,
            user_shortcuts: true,
            local_dir: Some(PathBuf::from(
                r"C:\Users\s\AppData\Local\OpenMind\Studio\Installations\0123",
            )),
            local_on_network: false,
            elevated: false,
            program_folder: Writable::No("access denied".into()),
            desktop: Ok(PathBuf::from(r"C:\Users\s\Desktop")),
            desktop_on_network: false,
            desktop_writable: Writable::Yes,
            shortcut: ShortcutState::Correct(PathBuf::from(
                r"C:\Users\s\Desktop\OpenMind Studio.lnk",
            )),
            public_shortcut: None,
        }
    }

    #[test]
    fn a_healthy_student_seat_needs_only_the_read_only_note() {
        let text = render(&report());
        assert!(text.contains(r"Network path:       \\fs01\apps"), "{text}");
        assert!(
            text.contains("standard (no administrator rights needed"),
            "{text}"
        );
        assert!(
            text.contains("You may only read the shared folder"),
            "{text}"
        );
        assert!(!text.contains("To add it by hand"), "{text}");
    }

    #[test]
    fn a_locked_desktop_gets_the_manual_steps_with_the_network_path() {
        let text = render(&Report {
            shortcut: ShortcutState::Missing,
            desktop_writable: Writable::No("access denied".into()),
            ..report()
        });
        assert!(
            text.contains("right-click the Desktop > New > Shortcut"),
            "{text}"
        );
        assert!(
            text.contains(r#""\\fs01\apps\OpenMind Studio\OpenMindStudio.exe""#),
            "{text}"
        );
    }

    #[test]
    fn drive_letter_shortcuts_misplaced_data_and_unset_layouts_are_explained() {
        let text = render(&Report {
            shortcut: ShortcutState::DriveLetter(PathBuf::from(
                r"C:\Users\s\Desktop\OpenMind Studio.lnk",
            )),
            local_on_network: true,
            network_layout: false,
            layout: "not recorded (no install.json)".into(),
            ..report()
        });
        assert!(text.contains("drive letter is mapped"), "{text}");
        assert!(
            text.contains("AppData\\Local) is on a network drive"),
            "{text}"
        );
        assert!(text.contains("--integration set-layout network"), "{text}");
    }

    #[test]
    fn a_public_desktop_shortcut_is_enough() {
        let text = render(&Report {
            shortcut: ShortcutState::Missing,
            public_shortcut: Some(PathBuf::from(
                r"C:\Users\Public\Desktop\OpenMind Studio.lnk",
            )),
            ..report()
        });
        assert!(text.contains("All users' Desktop:"), "{text}");
        assert!(!text.contains("To get a Desktop shortcut"), "{text}");
    }

    #[test]
    fn writability_is_probed_without_leaving_anything_behind() {
        let dir = tempfile::tempdir().expect("dir");
        assert_eq!(probe_writable(dir.path()), Writable::Yes);
        assert_eq!(std::fs::read_dir(dir.path()).expect("dir").count(), 0);
        assert!(matches!(
            probe_writable(&dir.path().join("missing")),
            Writable::No(_)
        ));
    }
}
