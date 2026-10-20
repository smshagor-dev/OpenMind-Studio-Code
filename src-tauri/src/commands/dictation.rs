//! Start Dictation in Editor: Windows' own voice typing (the Win+H panel). It types what it hears into the focused
//! text field — the editor, which the page focuses first — and Windows asks for the microphone itself. OpenMind
//! records nothing and sends nothing; pressing the shortcut again closes the panel. The WebView's speech recognition
//! isn't used: WebView2 has none that works offline.
//!
//! Win+H goes to whatever window is in the foreground, so it is sent only when that window is this app's window that
//! asked (brought forward first and checked); otherwise the command refuses and nothing is typed anywhere else.

use std::time::{Duration, Instant};

/// How long the window may take to come to the front.
const FOCUS_WAIT: Duration = Duration::from_millis(600);

/// Opens (or closes) Windows voice typing for the asking window's focused editor.
#[tauri::command]
pub async fn dictation_toggle(window: tauri::Window) -> Result<(), String> {
    if !cfg!(windows) {
        return Err(unavailable());
    }
    let _ = window.set_focus();
    let deadline = Instant::now() + FOCUS_WAIT;
    loop {
        if window.is_focused().unwrap_or(false) && platform::foreground_is_this_process() {
            return platform::send_voice_typing_shortcut();
        }
        if Instant::now() >= deadline {
            return Err(
                "OpenMind Studio isn't the window in front, so voice typing could type into another app. Click the editor and try again."
                    .into(),
            );
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

fn unavailable() -> String {
    "Dictation uses Windows voice typing, which isn't available on this system.".into()
}

#[cfg(windows)]
mod platform {
    use std::mem::size_of;

    use winapi::shared::minwindef::DWORD;
    use winapi::um::winuser::{
        GetForegroundWindow, GetWindowThreadProcessId, SendInput, INPUT, INPUT_KEYBOARD,
        KEYBDINPUT, KEYEVENTF_KEYUP, VK_LWIN,
    };

    const KEY_H: u16 = 0x48;

    /// The foreground window belongs to this process.
    pub fn foreground_is_this_process() -> bool {
        // SAFETY: both calls take no pointers we own except `pid`, which lives for the call.
        unsafe {
            let window = GetForegroundWindow();
            if window.is_null() {
                return false;
            }
            let mut pid: DWORD = 0;
            GetWindowThreadProcessId(window, &mut pid);
            pid == std::process::id()
        }
    }

    fn key(code: u16, up: bool) -> INPUT {
        // SAFETY: `INPUT` is a plain C struct; all-zero is a valid value.
        let mut input: INPUT = unsafe { std::mem::zeroed() };
        input.type_ = INPUT_KEYBOARD;
        // SAFETY: the keyboard member is the one `type_` selects.
        let keyboard: &mut KEYBDINPUT = unsafe { input.u.ki_mut() };
        keyboard.wVk = code;
        keyboard.dwFlags = if up { KEYEVENTF_KEYUP } else { 0 };
        input
    }

    pub fn send_voice_typing_shortcut() -> Result<(), String> {
        let mut inputs = [
            key(VK_LWIN as u16, false),
            key(KEY_H, false),
            key(KEY_H, true),
            key(VK_LWIN as u16, true),
        ];
        // SAFETY: the array is valid for its length and each element is a fully initialised keyboard INPUT.
        let sent = unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_mut_ptr(),
                size_of::<INPUT>() as i32,
            )
        };
        if sent as usize == inputs.len() {
            Ok(())
        } else {
            Err("Windows didn't accept the voice typing shortcut. Press Win+H to start voice typing.".into())
        }
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn foreground_is_this_process() -> bool {
        false
    }

    pub fn send_voice_typing_shortcut() -> Result<(), String> {
        Err(super::unavailable())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    #[cfg(windows)]
    fn a_test_process_without_a_window_is_never_the_foreground() {
        // The test runner owns no window, so the shortcut would be refused rather than sent elsewhere.
        assert!(!super::platform::foreground_is_this_process());
    }

    #[test]
    fn other_systems_are_told_it_isnt_available() {
        assert!(super::unavailable().contains("isn't available"));
    }
}
