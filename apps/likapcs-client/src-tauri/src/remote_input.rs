//! Live control (remote control, phase 2): one input event from the Admin, sent to this PC with
//! `SendInput`. Only the Admin's relayed events reach this function; the server checks the
//! permission and that the Admin is controlling this PC.
//!
//! Limits (see docs/remote-control-plan.md): UAC prompts, the lock screen, Ctrl+Alt+Del and some
//! anti-cheat protected games refuse injected input, and `SendInput` then reports failure.

use serde::Deserialize;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RemoteInput {
    /// Pointer position as a fraction of the primary screen (0 = left/top, 1 = right/bottom).
    Move { x: f64, y: f64 },
    Button { button: String, down: bool },
    Wheel { delta: i32 },
    /// `code` is the browser's `KeyboardEvent.code` (layout independent), e.g. "KeyA".
    Key { code: String, down: bool },
}

#[tauri::command]
pub fn send_remote_input(event: RemoteInput) -> Result<(), String> {
    imp::send(event)
}

#[cfg(windows)]
mod imp {
    use super::RemoteInput;
    use std::mem::size_of;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY,
        KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN,
        MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE,
        MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEINPUT,
    };

    pub fn send(event: RemoteInput) -> Result<(), String> {
        let input = match event {
            RemoteInput::Move { x, y } => mouse(MOUSEINPUT {
                dx: (x.clamp(0.0, 1.0) * 65535.0).round() as i32,
                dy: (y.clamp(0.0, 1.0) * 65535.0).round() as i32,
                mouseData: 0,
                dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
                time: 0,
                dwExtraInfo: 0,
            }),
            RemoteInput::Button { button, down } => {
                let flags = match (button.as_str(), down) {
                    ("left", true) => MOUSEEVENTF_LEFTDOWN,
                    ("left", false) => MOUSEEVENTF_LEFTUP,
                    ("right", true) => MOUSEEVENTF_RIGHTDOWN,
                    ("right", false) => MOUSEEVENTF_RIGHTUP,
                    ("middle", true) => MOUSEEVENTF_MIDDLEDOWN,
                    ("middle", false) => MOUSEEVENTF_MIDDLEUP,
                    _ => return Err(format!("unknown mouse button {button}")),
                };
                mouse(MOUSEINPUT { dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 })
            }
            RemoteInput::Wheel { delta } => mouse(MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: delta as u32,
                dwFlags: MOUSEEVENTF_WHEEL,
                time: 0,
                dwExtraInfo: 0,
            }),
            RemoteInput::Key { code, down } => {
                let (scan, extended) = scancode(&code).ok_or_else(|| format!("unsupported key {code}"))?;
                let mut flags = KEYEVENTF_SCANCODE;
                if extended {
                    flags |= KEYEVENTF_EXTENDEDKEY;
                }
                if !down {
                    flags |= KEYEVENTF_KEYUP;
                }
                keyboard(KEYBDINPUT { wVk: 0, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 })
            }
        };
        let sent = unsafe { SendInput(1, &input, size_of::<INPUT>() as i32) };
        if sent == 1 {
            Ok(())
        } else {
            Err("SendInput refused the event (UAC, lock screen or a protected window)".into())
        }
    }

    fn mouse(mi: MOUSEINPUT) -> INPUT {
        let mut input: INPUT = unsafe { std::mem::zeroed() };
        input.r#type = INPUT_MOUSE;
        input.Anonymous = INPUT_0 { mi };
        input
    }

    fn keyboard(ki: KEYBDINPUT) -> INPUT {
        let mut input: INPUT = unsafe { std::mem::zeroed() };
        input.r#type = INPUT_KEYBOARD;
        input.Anonymous = INPUT_0 { ki };
        input
    }

    /// Set 1 scan codes for the keys a PC user normally needs. Returns (scan, is_extended).
    fn scancode(code: &str) -> Option<(u16, bool)> {
        let key = match code {
            "Escape" => (0x01, false),
            "Digit1" => (0x02, false), "Digit2" => (0x03, false), "Digit3" => (0x04, false),
            "Digit4" => (0x05, false), "Digit5" => (0x06, false), "Digit6" => (0x07, false),
            "Digit7" => (0x08, false), "Digit8" => (0x09, false), "Digit9" => (0x0A, false),
            "Digit0" => (0x0B, false), "Minus" => (0x0C, false), "Equal" => (0x0D, false),
            "Backspace" => (0x0E, false), "Tab" => (0x0F, false),
            "KeyQ" => (0x10, false), "KeyW" => (0x11, false), "KeyE" => (0x12, false),
            "KeyR" => (0x13, false), "KeyT" => (0x14, false), "KeyY" => (0x15, false),
            "KeyU" => (0x16, false), "KeyI" => (0x17, false), "KeyO" => (0x18, false),
            "KeyP" => (0x19, false), "BracketLeft" => (0x1A, false), "BracketRight" => (0x1B, false),
            "Enter" => (0x1C, false), "ControlLeft" => (0x1D, false),
            "KeyA" => (0x1E, false), "KeyS" => (0x1F, false), "KeyD" => (0x20, false),
            "KeyF" => (0x21, false), "KeyG" => (0x22, false), "KeyH" => (0x23, false),
            "KeyJ" => (0x24, false), "KeyK" => (0x25, false), "KeyL" => (0x26, false),
            "Semicolon" => (0x27, false), "Quote" => (0x28, false), "Backquote" => (0x29, false),
            "ShiftLeft" => (0x2A, false), "Backslash" => (0x2B, false),
            "KeyZ" => (0x2C, false), "KeyX" => (0x2D, false), "KeyC" => (0x2E, false),
            "KeyV" => (0x2F, false), "KeyB" => (0x30, false), "KeyN" => (0x31, false),
            "KeyM" => (0x32, false), "Comma" => (0x33, false), "Period" => (0x34, false),
            "Slash" => (0x35, false), "ShiftRight" => (0x36, false), "AltLeft" => (0x38, false),
            "Space" => (0x39, false), "CapsLock" => (0x3A, false),
            "F1" => (0x3B, false), "F2" => (0x3C, false), "F3" => (0x3D, false), "F4" => (0x3E, false),
            "F5" => (0x3F, false), "F6" => (0x40, false), "F7" => (0x41, false), "F8" => (0x42, false),
            "F9" => (0x43, false), "F10" => (0x44, false), "F11" => (0x57, false), "F12" => (0x58, false),
            "NumLock" => (0x45, false), "ScrollLock" => (0x46, false),
            "ControlRight" => (0x1D, true), "AltRight" => (0x38, true),
            "Home" => (0x47, true), "ArrowUp" => (0x48, true), "PageUp" => (0x49, true),
            "ArrowLeft" => (0x4B, true), "ArrowRight" => (0x4D, true), "End" => (0x4F, true),
            "ArrowDown" => (0x50, true), "PageDown" => (0x51, true),
            "Insert" => (0x52, true), "Delete" => (0x53, true),
            "MetaLeft" => (0x5B, true), "MetaRight" => (0x5C, true), "ContextMenu" => (0x5D, true),
            _ => return None,
        };
        Some(key)
    }
}

#[cfg(not(windows))]
mod imp {
    use super::RemoteInput;

    pub fn send(_event: RemoteInput) -> Result<(), String> {
        Err("remote control is only available on Windows".into())
    }
}
