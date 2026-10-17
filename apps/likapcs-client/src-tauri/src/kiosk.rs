//! Kiosk hardening while the lock screen is shown (Windows only; no-ops elsewhere).
//!
//! * A low-level keyboard hook swallows the keys that would take a customer away from the lock
//!   screen: both Windows keys (and with them Win+D, Win+Tab, Win+R, Win+L, …), Alt+Tab, Alt+Esc,
//!   Alt+F4, Ctrl+Esc, Ctrl+Shift+Esc and the context-menu key. Everything else — including the
//!   staff shortcuts Ctrl+Alt+A / Ctrl+Alt+S — passes through unchanged.
//! * Task Manager is disabled through the per-user policy `DisableTaskMgr` for the duration of the
//!   lock (Ctrl+Alt+Del itself cannot be intercepted by any application) and re-enabled as soon as
//!   the PC is unlocked, when the client exits, and by the uninstaller (`windows/hooks.nsh`).
//! * The taskbar auto-hides while the PC is locked (`SHAppBarMessage`), so a customer never sees
//!   it behind or above the lock screen, and it is back the moment the PC is unlocked.
//!
//! Boot (0.17.0): Windows postpones Run-key autostart apps by up to 10 s (`StartupDelayInMSec`),
//! which left the desktop — taskbar and all — visible after power-on. `arm_boot()` turns that
//! delay off and the installer adds an at-logon scheduled task, so the lock screen is the first
//! thing a switched-on PC shows.
//!
//! Nothing here is active during a paid session: the keyboard belongs to the customer then.

use std::sync::atomic::{AtomicBool, Ordering};

static ENABLED: AtomicBool = AtomicBool::new(false);
/// Owner setting: the Windows keys do nothing while a Steam game runs in front (default on).
static BLOCK_WIN_IN_GAMES: AtomicBool = AtomicBool::new(true);
/// True while the foreground window belongs to a game installed under `steamapps\common`.
static GAME_IN_FRONT: AtomicBool = AtomicBool::new(false);

/// Turns the Windows-key block during Steam games on or off (the owner's setting).
pub fn set_win_block_in_games(on: bool) {
    BLOCK_WIN_IN_GAMES.store(on, Ordering::SeqCst);
}

/// Turns the lock-screen hardening on or off. Idempotent; the policy change runs off-thread.
pub fn set_enabled(on: bool) {
    let was = ENABLED.swap(on, Ordering::SeqCst);
    if was != on {
        std::thread::spawn(move || {
            policy::task_manager(!on);
            policy::taskbar_autohide(on);
        });
    }
}

/// Makes the next boots lock immediately: no Windows startup delay for autostart apps. Safe to
/// call on every launch (the installer writes the same value before the first run).
pub fn arm_boot() {
    std::thread::spawn(|| policy::startup_no_delay());
}

/// Installs the keyboard hook. Must be called from the thread that runs the UI message loop —
/// low-level hooks are delivered to the installing thread.
pub fn install() {
    imp::install();
    #[cfg(windows)]
    std::thread::spawn(game_watch_loop);
}

/// Checks the foreground window a few times a second. Cheap: one process-name lookup.
#[cfg(windows)]
fn game_watch_loop() {
    loop {
        GAME_IN_FRONT.store(imp::foreground_is_steam_game(), Ordering::Relaxed);
        std::thread::sleep(std::time::Duration::from_millis(400));
    }
}

/// Undoes everything that could outlive the process (policies). Safe to call repeatedly.
pub fn restore() {
    ENABLED.store(false, Ordering::SeqCst);
    policy::task_manager(true);
    policy::taskbar_autohide(false);
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

    /// Without this, Windows holds Run-key autostart apps back for ~10 s after logon — long
    /// enough for a switched-on PC to show the desktop and the taskbar before the lock screen.
    pub fn startup_no_delay() {
        let mut cmd = Command::new("reg");
        cmd.args([
            "add",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Serialize",
            "/v",
            "StartupDelayInMSec",
            "/t",
            "REG_DWORD",
            "/d",
            "0",
            "/f",
        ]);
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        crate::hide_console(&mut cmd);
        let _ = cmd.status();
    }

    /// Hides the taskbar for the session (auto-hide) while the PC is locked; `false` brings it
    /// back. Session-scoped appbar state, no registry write, nothing survives a reboot.
    pub fn taskbar_autohide(on: bool) {
        shell::appbar_autohide(on);
    }

    mod shell {
        use windows_sys::Win32::Foundation::{HWND, RECT};
        use windows_sys::Win32::UI::Shell::{
            SHAppBarMessage, ABM_SETSTATE, ABS_AUTOHIDE, APPBARDATA,
        };

        pub fn appbar_autohide(on: bool) {
            let mut data = APPBARDATA {
                cbSize: std::mem::size_of::<APPBARDATA>() as u32,
                hWnd: HWND::default(),
                uCallbackMessage: 0,
                uEdge: 0,
                rc: RECT {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                },
                lParam: if on { ABS_AUTOHIDE as isize } else { 0 },
            };
            // SAFETY: SHAppBarMessage only reads the descriptor we pass.
            unsafe {
                SHAppBarMessage(ABM_SETSTATE, &mut data);
            }
        }
    }
}

#[cfg(not(windows))]
mod policy {
    pub fn task_manager(_allow: bool) {}
    pub fn startup_no_delay() {}
    pub fn taskbar_autohide(_on: bool) {}
}

#[cfg(windows)]
mod imp {
    use super::ENABLED;
    use std::sync::atomic::Ordering;
    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use super::{BLOCK_WIN_IN_GAMES, GAME_IN_FRONT};
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_APPS, VK_CONTROL, VK_ESCAPE, VK_F4, VK_LWIN, VK_RWIN, VK_TAB,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetForegroundWindow, GetWindowThreadProcessId, SetWindowsHookExW,
        HC_ACTION, KBDLLHOOKSTRUCT, LLKHF_ALTDOWN, WH_KEYBOARD_LL,
    };

    fn key_down(vk: u16) -> bool {
        // SAFETY: plain Win32 call without pointers.
        unsafe { GetAsyncKeyState(vk as i32) < 0 }
    }

    /// Path check for a game started by Steam: its executable lives under `steamapps\common`.
    pub fn foreground_is_steam_game() -> bool {
        // SAFETY: plain Win32 calls; the process handle is closed on every path below.
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() {
                return false;
            }
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid == 0 {
                return false;
            }
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len);
            CloseHandle(handle);
            if ok == 0 {
                return false;
            }
            let path = String::from_utf16_lossy(&buf[..len as usize]).to_lowercase();
            path.contains("\\steamapps\\common\\")
        }
    }

    unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        let locked = ENABLED.load(Ordering::Relaxed);
        let game_guard =
            BLOCK_WIN_IN_GAMES.load(Ordering::Relaxed) && GAME_IN_FRONT.load(Ordering::Relaxed);
        if code == HC_ACTION as i32 && lparam != 0 && (locked || game_guard) {
            // SAFETY: for HC_ACTION the system guarantees lparam points at a KBDLLHOOKSTRUCT.
            let info = &*(lparam as *const KBDLLHOOKSTRUCT);
            let vk = info.vkCode as u16;
            let is_win = vk == VK_LWIN || vk == VK_RWIN;
            // During a Steam game only the Windows keys are swallowed; the lock screen blocks more.
            let alt = (info.flags & LLKHF_ALTDOWN) != 0;
            let ctrl = key_down(VK_CONTROL);
            let win_held = key_down(VK_LWIN) || key_down(VK_RWIN);
            let locked_block = locked
                && (is_win
                    || vk == VK_APPS
                    || win_held
                    || (alt && (vk == VK_TAB || vk == VK_ESCAPE || vk == VK_F4))
                    || (ctrl && vk == VK_ESCAPE));
            let game_block = game_guard && is_win;
            if locked_block || game_block {
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
