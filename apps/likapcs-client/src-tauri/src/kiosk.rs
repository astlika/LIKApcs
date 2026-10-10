//! Kiosk hardening while the lock screen is shown (Windows only; no-ops elsewhere).
//!
//! * A low-level keyboard hook swallows the keys that would take a customer away from the lock
//!   screen: both Windows keys (and with them Win+D, Win+Tab, Win+R, Win+L, …), Alt+Tab, Alt+Esc,
//!   Alt+F4, Ctrl+Esc, Ctrl+Shift+Esc and the context-menu key. Everything else — including the
//!   staff shortcuts Ctrl+Alt+A / Ctrl+Alt+S — passes through unchanged.
//! * Task Manager is disabled through the per-user policy `DisableTaskMgr` for the duration of the
//!   lock (Ctrl+Alt+Del itself cannot be intercepted by any application) and re-enabled as soon as
//!   the PC is unlocked, when the client exits, and by the uninstaller (`windows/hooks.nsh`).
//!
//! Nothing here is active during a paid session: the keyboard belongs to the customer then.

use std::sync::atomic::{AtomicBool, Ordering};

static ENABLED: AtomicBool = AtomicBool::new(false);

/// Turns the lock-screen hardening on or off. Idempotent; the policy change runs off-thread.
pub fn set_enabled(on: bool) {
    let was = ENABLED.swap(on, Ordering::SeqCst);
    if was != on {
        std::thread::spawn(move || policy::task_manager(!on));
    }
}

/// Installs the keyboard hook. Must be called from the thread that runs the UI message loop —
/// low-level hooks are delivered to the installing thread.
pub fn install() {
    imp::install();
}

/// Undoes everything that could outlive the process (policies). Safe to call repeatedly.
pub fn restore() {
    ENABLED.store(false, Ordering::SeqCst);
    policy::task_manager(true);
}

#[cfg(windows)]
mod policy {
    use std::process::{Command, Stdio};

    const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\System";

    pub fn task_manager(allow: bool) {
        let mut cmd = Command::new("reg");
        if allow {
            cmd.args(["delete", KEY, "/v", "DisableTaskMgr", "/f"]);
        } else {
            cmd.args(["add", KEY, "/v", "DisableTaskMgr", "/t", "REG_DWORD", "/d", "1", "/f"]);
        }
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        crate::hide_console(&mut cmd);
        let _ = cmd.status();
    }
}

#[cfg(not(windows))]
mod policy {
    pub fn task_manager(_allow: bool) {}
}

#[cfg(windows)]
mod imp {
    use super::ENABLED;
    use std::sync::atomic::Ordering;
    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_APPS, VK_CONTROL, VK_ESCAPE, VK_F4, VK_LWIN, VK_RWIN, VK_TAB,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, SetWindowsHookExW, HC_ACTION, KBDLLHOOKSTRUCT, LLKHF_ALTDOWN,
        WH_KEYBOARD_LL,
    };

    fn key_down(vk: u16) -> bool {
        // SAFETY: plain Win32 call without pointers.
        unsafe { GetAsyncKeyState(vk as i32) < 0 }
    }

    unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 && lparam != 0 && ENABLED.load(Ordering::Relaxed) {
            // SAFETY: for HC_ACTION the system guarantees lparam points at a KBDLLHOOKSTRUCT.
            let info = &*(lparam as *const KBDLLHOOKSTRUCT);
            let vk = info.vkCode as u16;
            let alt = (info.flags & LLKHF_ALTDOWN) != 0;
            let ctrl = key_down(VK_CONTROL);
            let win_held = key_down(VK_LWIN) || key_down(VK_RWIN);
            let blocked = vk == VK_LWIN
                || vk == VK_RWIN
                || vk == VK_APPS
                || win_held
                || (alt && (vk == VK_TAB || vk == VK_ESCAPE || vk == VK_F4))
                || (ctrl && vk == VK_ESCAPE);
            if blocked {
                return 1;
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    pub fn install() {
        // SAFETY: standard global low-level hook registration; the callback lives for the whole
        // process and only reads an atomic plus the struct the system hands it.
        unsafe {
            let module = GetModuleHandleW(std::ptr::null());
            let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), module, 0);
            if hook.is_null() {
                eprintln!("kiosk: low-level keyboard hook could not be installed");
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn install() {}
}
