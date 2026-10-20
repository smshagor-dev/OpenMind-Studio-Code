//! Start Dictation in Editor: Windows' own voice typing (the Win+H panel). It types what it hears into the focused
//! text field — the editor, which the page focuses first — and Windows asks for the microphone itself. OpenMind
//! records nothing and sends nothing; pressing the shortcut again closes the panel. The WebView's speech recognition
//! isn't used: WebView2 has none that works offline.

/// Opens (or closes) Windows voice typing.
#[tauri::command]
pub fn dictation_toggle() -> Result<(), String> {
    platform::toggle()
}

#[cfg(windows)]
mod platform {
    use std::mem::size_of;

    use winapi::um::winuser::{
        SendInput, INPUT, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_LWIN,
    };

    const KEY_H: u16 = 0x48;

    fn key(code: u16, up: bool) -> INPUT {
        let mut input: INPUT = unsafe { std::mem::zeroed() };
        input.type_ = INPUT_KEYBOARD;
        // SAFETY: `INPUT` is a plain C struct; the keyboard member is the one `type_` selects.
        let keyboard: &mut KEYBDINPUT = unsafe { input.u.ki_mut() };
        keyboard.wVk = code;
        keyboard.dwFlags = if up { KEYEVENTF_KEYUP } else { 0 };
        input
    }

    pub fn toggle() -> Result<(), String> {
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
    pub fn toggle() -> Result<(), String> {
        Err("Dictation uses Windows voice typing, which isn't available on this system.".into())
    }
}
