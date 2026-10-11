//! LIKApcs-Client desktop shell.
//!
//! Thin native layer for the gaming-PC agent: kiosk window control (fullscreen lock screen with
//! keyboard hardening and cover windows on extra monitors, a small always-on-top countdown
//! widget, a settings flyout next to the tray), the tray icon, the machine identity, a DPAPI-backed secret
//! store, LAN discovery of the server, staff-requested power actions and the signed
//! auto-updater. All protocol logic lives in the TypeScript agent (`src/lib/agent.ts`).

mod kiosk;
mod secrets;

use serde::{Deserialize, Serialize};
use std::net::{SocketAddr, UdpSocket};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;

const DISCOVERY_PORT: u16 = 4701;
const DISCOVERY_REQUEST: &[u8] = b"LIKAPCS_DISCOVER_V1";
const OVERLAY_WIDTH: f64 = 300.0;
const OVERLAY_HEIGHT: f64 = 96.0;
const PANEL_WIDTH: f64 = 560.0;
const PANEL_HEIGHT: f64 = 720.0;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceIdentity {
    machine_id: Option<String>,
    hostname: String,
    os_info: String,
}

struct KioskState {
    locked: Arc<AtomicBool>,
}

/// Screen position (physical pixels) of the last left click on the tray icon; the settings
/// panel opens as a flyout next to it.
struct PanelAnchor(Mutex<Option<(f64, f64)>>);

#[cfg(windows)]
pub(crate) fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
pub(crate) fn hide_console(_cmd: &mut Command) {}

fn run_capture(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    hide_console(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Windows: HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid (stable per Windows installation).
/// Linux/macOS (development): /etc/machine-id or the IOPlatformUUID.
fn raw_machine_id() -> Option<String> {
    if cfg!(windows) {
        let text = run_capture(
            "reg",
            &["query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"],
        )?;
        return text
            .lines()
            .find(|l| l.contains("MachineGuid"))
            .and_then(|l| l.split_whitespace().last())
            .map(|s| s.trim().to_string())
            .filter(|s| s.len() >= 8);
    }
    if let Ok(id) = std::fs::read_to_string("/etc/machine-id") {
        let id = id.trim().to_string();
        if id.len() >= 8 {
            return Some(id);
        }
    }
    if cfg!(target_os = "macos") {
        let text = run_capture("ioreg", &["-rd1", "-c", "IOPlatformExpertDevice"])?;
        return text
            .lines()
            .find(|l| l.contains("IOPlatformUUID"))
            .and_then(|l| l.split('"').nth(3))
            .map(|s| s.to_string());
    }
    None
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|h| !h.is_empty())
        .or_else(|| run_capture("hostname", &[]).map(|h| h.trim().to_string()))
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "unknown-pc".into())
}

fn os_info() -> String {
    let base = format!("{} {}", std::env::consts::OS, std::env::consts::ARCH);
    if cfg!(windows) {
        if let Some(ver) = run_capture("cmd", &["/C", "ver"]) {
            let ver = ver.trim();
            if !ver.is_empty() {
                return format!("{ver} ({})", std::env::consts::ARCH);
            }
        }
    }
    base
}

#[tauri::command]
async fn device_identity() -> DeviceIdentity {
    tauri::async_runtime::spawn_blocking(|| DeviceIdentity {
        machine_id: raw_machine_id(),
        hostname: hostname(),
        os_info: os_info(),
    })
    .await
    .unwrap_or(DeviceIdentity { machine_id: None, hostname: "unknown-pc".into(), os_info: "unknown".into() })
}

#[tauri::command]
fn secret_get(name: String) -> Result<Option<String>, String> {
    secrets::get(&name)
}
#[tauri::command]
fn secret_set(name: String, value: String) -> Result<(), String> {
    secrets::set(&name, &value)
}
#[tauri::command]
fn secret_delete(name: String) -> Result<(), String> {
    secrets::delete(&name)
}

#[tauri::command]
async fn discover_servers(timeout_ms: Option<u64>) -> Vec<serde_json::Value> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(2500).clamp(300, 15_000));
    tauri::async_runtime::spawn_blocking(move || discover(timeout))
        .await
        .unwrap_or_default()
}

/// Same datagram protocol as the server's `DiscoveryResponder` (apps/likapcs-server/src/discovery.ts).
fn discover(timeout: Duration) -> Vec<serde_json::Value> {
    let mut found: Vec<serde_json::Value> = Vec::new();
    let socket = match UdpSocket::bind(("0.0.0.0", 0)) {
        Ok(s) => s,
        Err(_) => return found,
    };
    let _ = socket.set_broadcast(true);
    let _ = socket.set_read_timeout(Some(Duration::from_millis(250)));
    let mut targets = vec![
        SocketAddr::from(([255, 255, 255, 255], DISCOVERY_PORT)),
        SocketAddr::from(([127, 0, 0, 1], DISCOVERY_PORT)),
    ];
    if let Ok(probe) = UdpSocket::bind(("0.0.0.0", 0)) {
        if probe.connect(("192.0.2.1", 9)).is_ok() {
            if let Ok(SocketAddr::V4(local)) = probe.local_addr() {
                let o = local.ip().octets();
                targets.push(SocketAddr::from(([o[0], o[1], o[2], 255], DISCOVERY_PORT)));
            }
        }
    }
    for target in &targets {
        let _ = socket.send_to(DISCOVERY_REQUEST, target);
    }
    let deadline = Instant::now() + timeout;
    let mut buf = [0u8; 4096];
    while Instant::now() < deadline {
        match socket.recv_from(&mut buf) {
            Ok((len, from)) => {
                if let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(&buf[..len]) {
                    if value.get("service").and_then(|s| s.as_str()) == Some("likapcs") {
                        // The address the reply came from is the one that is reachable from
                        // here — the server's own list may start with a virtual adapter.
                        if let serde_json::Value::Object(map) = &mut value {
                            map.insert(
                                "from".into(),
                                serde_json::Value::String(from.ip().to_string()),
                            );
                        }
                        let id = value.get("installationId").cloned();
                        if !found.iter().any(|f| f.get("installationId").cloned() == id) {
                            found.push(value);
                        }
                    }
                }
            }
            Err(_) => {
                if Instant::now() + Duration::from_millis(1200) < deadline {
                    for target in &targets {
                        let _ = socket.send_to(DISCOVERY_REQUEST, target);
                    }
                }
            }
        }
    }
    found
}

fn apply_locked(window: &WebviewWindow) {
    // The client is never a "program" on the taskbar or in Alt+Tab — only the tray icon.
    let _ = window.set_skip_taskbar(true);
    let _ = window.set_decorations(false);
    let _ = window.set_resizable(false);
    let _ = window.set_fullscreen(true);
    let _ = window.set_always_on_top(true);
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn apply_overlay(window: &WebviewWindow) {
    let _ = window.set_fullscreen(false);
    let _ = window.set_decorations(false);
    let _ = window.set_resizable(false);
    let _ = window.set_skip_taskbar(true);
    let _ = window.set_always_on_top(true);
    let _ = window.set_size(LogicalSize::new(OVERLAY_WIDTH, OVERLAY_HEIGHT));
    // Top-right corner of the monitor the window is on.
    let (mut x, mut y) = (16.0, 16.0);
    if let Ok(Some(monitor)) = window.current_monitor() {
        let scale = monitor.scale_factor();
        let size = monitor.size().to_logical::<f64>(scale);
        let pos = monitor.position().to_logical::<f64>(scale);
        x = pos.x + size.width - OVERLAY_WIDTH - 16.0;
        y = pos.y + 16.0;
    }
    let _ = window.set_position(LogicalPosition::new(x, y));
    let _ = window.show();
}

/// Settings panel opened from the tray while the PC is unlocked: an always-on-top flyout next to
/// the tray icon (bottom-right of the work area for the usual taskbar position), kept inside the
/// work area of the monitor the click happened on. Centred when no monitor is known.
fn apply_panel(app: &AppHandle, window: &WebviewWindow) {
    let _ = window.set_fullscreen(false);
    let _ = window.set_decorations(false);
    let _ = window.set_resizable(false);
    let _ = window.set_skip_taskbar(true);
    let _ = window.set_always_on_top(true);

    let anchor = app.state::<PanelAnchor>().0.lock().ok().and_then(|a| *a);
    let monitor = anchor
        .and_then(|(x, y)| app.monitor_from_point(x, y).ok().flatten())
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());

    match monitor {
        Some(monitor) => {
            let scale = monitor.scale_factor();
            let work = monitor.work_area();
            let margin = (12.0 * scale).round();
            let left = work.position.x as f64;
            let top = work.position.y as f64;
            let right = left + work.size.width as f64;
            let bottom = top + work.size.height as f64;
            let width = (PANEL_WIDTH * scale)
                .round()
                .min(right - left - 2.0 * margin)
                .max(1.0);
            let height = (PANEL_HEIGHT * scale)
                .round()
                .min(bottom - top - 2.0 * margin)
                .max(1.0);
            // Without a click to anchor to (Ctrl+Alt+S), assume the tray's usual corner.
            let (ax, ay) = anchor.unwrap_or((right, bottom));
            // Horizontally right-aligned to the click, vertically on the taskbar's side.
            let x = (ax - width + 48.0 * scale)
                .max(left + margin)
                .min(right - width - margin);
            let y = if ay >= top + (bottom - top) / 2.0 {
                bottom - height - margin
            } else {
                top + margin
            };
            let _ = window.set_size(PhysicalSize::new(width as u32, height as u32));
            let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
        }
        None => {
            let _ = window.set_size(LogicalSize::new(PANEL_WIDTH, PANEL_HEIGHT));
            let _ = window.center();
        }
    }
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// Black cover windows on every monitor except the one showing the lock screen, so a second
/// screen cannot be used while the PC is locked. Closed again when the PC is unlocked.
fn update_covers(app: &AppHandle, locked: bool) {
    for (label, existing) in app.webview_windows() {
        if label.starts_with("cover-") {
            let _ = existing.destroy();
        }
    }
    if !locked {
        return;
    }
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    // Without knowing where the lock screen is, do nothing rather than risk covering it.
    let Some(main_monitor) = main.current_monitor().ok().flatten() else {
        return;
    };
    let Ok(monitors) = app.available_monitors() else {
        return;
    };
    for (index, monitor) in monitors.iter().enumerate() {
        if main_monitor.position() == monitor.position() {
            continue;
        }
        let scale = monitor.scale_factor();
        let pos = monitor.position().to_logical::<f64>(scale);
        let size = monitor.size().to_logical::<f64>(scale);
        let label = format!("cover-{index}");
        let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("cover.html".into()))
            .title("LIKApcs")
            .decorations(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .position(pos.x, pos.y)
            .inner_size(size.width, size.height)
            .build();
        if let Ok(cover) = built {
            let _ = cover.set_fullscreen(true);
        }
    }
}

/// Async on purpose: creating webview windows (the covers) from a *synchronous* command
/// deadlocks on Windows (see `WebviewWindowBuilder::new`).
#[tauri::command]
async fn set_window_mode(app: AppHandle, mode: String) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("main window missing")?;
    let locked = app.state::<KioskState>().locked.clone();
    match mode.as_str() {
        "locked" => {
            locked.store(true, Ordering::SeqCst);
            kiosk::set_enabled(true);
            apply_locked(&window);
            update_covers(&app, true);
        }
        "overlay" => {
            locked.store(false, Ordering::SeqCst);
            kiosk::set_enabled(false);
            update_covers(&app, false);
            apply_overlay(&window);
        }
        "panel" => {
            locked.store(false, Ordering::SeqCst);
            kiosk::set_enabled(false);
            update_covers(&app, false);
            apply_panel(&app, &window);
        }
        other => return Err(format!("unknown window mode {other}")),
    }
    Ok(())
}

/// Localised texts for the tray menu, provided by the frontend (it owns the language).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrayLabels {
    status: String,
    settings: String,
    update: String,
    quit: String,
}

fn build_tray_menu(app: &AppHandle, labels: &TrayLabels) -> tauri::Result<Menu<tauri::Wry>> {
    let status = MenuItem::with_id(app, "status", labels.status.as_str(), false, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", labels.settings.as_str(), true, None::<&str>)?;
    let update = MenuItem::with_id(app, "update", labels.update.as_str(), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", labels.quit.as_str(), true, None::<&str>)?;
    Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &update,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )
}

/// Refreshes the tray menu/tooltip (status line, language) — called by the agent on every change.
#[tauri::command]
fn tray_update(app: AppHandle, labels: TrayLabels) -> Result<(), String> {
    let tray = app.tray_by_id("main").ok_or("tray icon missing")?;
    let menu = build_tray_menu(&app, &labels).map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    tray.set_tooltip(Some(labels.status.as_str())).map_err(|e| e.to_string())?;
    Ok(())
}

/// Exits the client. Refused while the PC is locked — staff unlock it first (Ctrl+Alt+A), which
/// the server verifies. `force` is only sent by the agent for a PC that is not paired yet (no
/// station, nothing billable) so a technician can leave the lock screen without uninstalling.
#[tauri::command]
fn quit_app(app: AppHandle, state: tauri::State<'_, KioskState>, force: Option<bool>) -> Result<(), String> {
    if state.locked.load(Ordering::SeqCst) && !force.unwrap_or(false) {
        return Err("locked".into());
    }
    kiosk::restore();
    app.exit(0);
    Ok(())
}

/// Staff-requested power action. Only reachable through an authenticated, acknowledged server
/// command (see agent.ts); the OS still shows its normal shutdown notice.
#[tauri::command]
async fn power_action(action: String) -> Result<(), String> {
    let flag = match action.as_str() {
        "restart" => "/r",
        "shutdown" => "/s",
        _ => return Err(format!("unknown power action {action}")),
    };
    tauri::async_runtime::spawn_blocking(move || {
        if cfg!(windows) {
            let mut cmd = Command::new("shutdown");
            cmd.args([flag, "/t", "3", "/f", "/c", "LIKApcs: requested by the staff"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped());
            hide_console(&mut cmd);
            let out = cmd.output().map_err(|e| e.to_string())?;
            if out.status.success() {
                Ok(())
            } else {
                Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
            }
        } else {
            let verb = if flag == "/r" { "reboot" } else { "poweroff" };
            let status = Command::new("systemctl").arg(verb).status().map_err(|e| e.to_string())?;
            if status.success() {
                Ok(())
            } else {
                Err(format!("systemctl {verb} failed"))
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let locked = Arc::new(AtomicBool::new(true));

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .manage(KioskState { locked: locked.clone() })
        .manage(PanelAnchor(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            device_identity,
            secret_get,
            secret_set,
            secret_delete,
            discover_servers,
            set_window_mode,
            power_action,
            tray_update,
            quit_app
        ])
        .setup(move |app| {
            // Keyboard hardening is armed from the start: the client boots locked.
            kiosk::install();
            kiosk::set_enabled(true);

            // Tray icon: the only visible trace of the client during a session. Menu actions are
            // forwarded to the frontend, which knows the language and the lock state.
            let labels = TrayLabels {
                status: "LIKApcs Client".into(),
                settings: "Settings…".into(),
                update: "Check for updates".into(),
                quit: "Quit LIKApcs Client".into(),
            };
            let menu = build_tray_menu(app.handle(), &labels)?;
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("LIKApcs Client")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    let id: String = event.id.0.clone();
                    let _ = app.emit("tray", id);
                })
                .on_tray_icon_event(|tray, event| {
                    // Left click = settings (the frontend toggles the panel); the context menu
                    // stays on the right button.
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Ok(mut anchor) = app.state::<PanelAnchor>().0.lock() {
                            *anchor = Some((position.x, position.y));
                        }
                        let _ = app.emit("tray", "settings");
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            if let Some(window) = app.get_webview_window("main") {
                apply_locked(&window);
                // Focus guard: while locked, keep the lock screen in front (best effort — OS-level
                // kiosk hardening such as Windows Assigned Access is documented separately).
                let guard_flag = locked.clone();
                let guarded = window.clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(Duration::from_millis(750));
                    if guard_flag.load(Ordering::SeqCst) {
                        let _ = guarded.set_always_on_top(true);
                        if !guarded.is_focused().unwrap_or(true) {
                            let _ = guarded.show();
                            let _ = guarded.set_focus();
                        }
                        if guarded.is_minimized().unwrap_or(false) {
                            let _ = guarded.unminimize();
                        }
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                // The client is never closed by the customer; staff quit it from the tray after a
                // staff unlock, or uninstall it.
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.show();
                }
                // Something stole the foreground while locked (a notification, an installer
                // window): take it straight back.
                WindowEvent::Focused(false) => {
                    let locked = window.app_handle().state::<KioskState>().locked.load(Ordering::SeqCst);
                    if locked {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building LIKApcs Client")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                kiosk::restore();
            }
        });
}
