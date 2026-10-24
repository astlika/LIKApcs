//! LIKApcs-Client desktop shell.
//!
//! Thin native layer for the gaming-PC agent: kiosk window control (fullscreen lock screen with
//! keyboard hardening and cover windows on extra monitors, a small always-on-top countdown
//! widget, a settings flyout next to the tray), the tray icon, the machine identity, a DPAPI-backed secret
//! store, LAN discovery of the server, staff-requested power actions and the signed
//! auto-updater. All protocol logic lives in the TypeScript agent (`src/lib/agent.ts`).

mod hardware;
mod kiosk;
mod remote_input;
mod screen;
mod secrets;
mod tasks;
mod wallpaper;
mod wol;

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
const OVERLAY_MARGIN: f64 = 16.0;
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

/// Countdown widget footprint and corner, chosen by the owner in Admin → Settings → Client screen
/// (`client.widget_size` / `client.widget_position`). Logical pixels; the window follows the
/// monitor scale factor.
#[derive(Clone, Copy, PartialEq, Eq)]
enum WidgetSize {
    Small,
    Normal,
    Large,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WidgetPosition {
    TopLeft,
    TopCenter,
    TopRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
    /// 0.19.7: vertically centred on the left / right edge of the work area.
    MiddleLeft,
    MiddleRight,
}

#[derive(Clone, Copy)]
struct WidgetLayout {
    size: WidgetSize,
    position: WidgetPosition,
    /// Exact footprint (logical px) of the chosen design, computed by the frontend from the shared
    /// design table (0.13.0). `None` = the classic card sizes below.
    footprint: Option<(f64, f64)>,
}

impl WidgetLayout {
    fn dimensions(self) -> (f64, f64) {
        if let Some((w, h)) = self.footprint {
            if w.is_finite() && h.is_finite() && w >= 32.0 && h >= 16.0 {
                return (w.min(1200.0), h.min(600.0));
            }
        }
        match self.size {
            WidgetSize::Small => (264.0, 60.0),
            WidgetSize::Normal => (300.0, 96.0),
            WidgetSize::Large => (392.0, 128.0),
        }
    }
}

struct WidgetState {
    layout: Mutex<WidgetLayout>,
    /// True while the window is in `overlay` mode (so a layout change re-applies at once).
    overlay: AtomicBool,
    /// 0.19.7: owner setting `client.widget_hide_in_games` (default on).
    hide_in_games: AtomicBool,
    /// 0.19.7: the widget is hidden right now because a fullscreen game is in front.
    hidden_for_game: AtomicBool,
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

/// Static hardware facts for the server (sent with `client.hello`); cached after the first call.
/// The sampling itself happens on the hardware worker threads (see `hardware.rs` — never on the
/// UI thread); this only waits for the answer, off the UI thread as well.
#[tauri::command]
async fn hardware_info(
    state: tauri::State<'_, Arc<hardware::HardwareState>>,
) -> Result<hardware::HardwareInfo, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || s.info())
        .await
        .map_err(|e| e.to_string())
}

/// Outcome of `wol_configure` together with the re-read hardware facts for the server.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WolConfigureResult {
    ok: bool,
    message: String,
    elevated: bool,
    hardware: hardware::HardwareInfo,
}

/// Admin → `wol.configure`: turn on "wake on magic packet" + turn off Fast startup (may raise a
/// UAC prompt on this PC). Blocking PowerShell work, so off the UI thread like the rest.
#[tauri::command]
async fn wol_configure(
    state: tauri::State<'_, Arc<hardware::HardwareState>>,
) -> Result<WolConfigureResult, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = wol::configure();
        let hardware = s.refresh_network();
        WolConfigureResult {
            ok: outcome.ok,
            message: outcome.message,
            elevated: outcome.elevated,
            hardware,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Live load / temperatures for the heartbeat (same threading rules as `hardware_info`).
#[tauri::command]
async fn hardware_metrics(
    state: tauri::State<'_, Arc<hardware::HardwareState>>,
) -> Result<hardware::HardwareMetrics, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || s.metrics())
        .await
        .map_err(|e| e.to_string())
}

/// 0.23.0: sets this PC's Windows desktop wallpaper (picture bytes, base64, from the server).
#[tauri::command]
async fn set_desktop_wallpaper(bytes: String, ext: String) -> Result<(), String> {
    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD
        .decode(bytes.as_bytes())
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || wallpaper::set_desktop(&data, &ext))
        .await
        .map_err(|e| e.to_string())?
}

/// 0.23.0: puts back the desktop wallpaper the PC had before the Admin changed it.
#[tauri::command]
async fn restore_desktop_wallpaper() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(wallpaper::restore)
        .await
        .map_err(|e| e.to_string())?
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
    // Entering fullscreen is asynchronous on Windows: re-assert once the transition settled, or
    // the lock screen can end up under the shell instead of above everything.
    reassert(window, move |w| {
        let _ = w.set_always_on_top(true);
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    });
}

/// Runs `apply` again after the Windows window transition settles (fullscreen in/out, z-order).
/// A no-op value-wise: re-applying the same state is how the client wins these races on 10/11.
fn reassert(window: &WebviewWindow, apply: impl Fn(&WebviewWindow) + Send + 'static + Clone) {
    for delay_ms in [180u64, 600] {
        let window = window.clone();
        let apply = apply.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            apply(&window);
        });
    }
}

/// `already_widget`: the window was already the countdown widget before this call (a design,
/// size or notice change while a customer plays). Then only the geometry is updated: leaving
/// fullscreen and taking focus would drop a running game (CS2) from the screen and bring the
/// mouse cursor back, on every staff notice, order flash or time warning.
fn apply_overlay(window: &WebviewWindow, layout: WidgetLayout, already_widget: bool) {
    let (width, height) = layout.dimensions();
    if !already_widget {
        let _ = window.set_fullscreen(false);
        let _ = window.set_decorations(false);
        let _ = window.set_resizable(false);
        let _ = window.set_skip_taskbar(true);
    }
    let _ = window.set_always_on_top(true);
    let _ = window.set_size(LogicalSize::new(width, height));
    position_overlay(window, layout.position, width, height);
    show_widget(window);
    let _ = window.unminimize();
    if !already_widget {
        let _ = window.set_focus();
    }
    // Leaving fullscreen is asynchronous on Windows (11 restores the window's old "normal" rect
    // after this returns): re-apply the widget geometry and the topmost flag once the transition
    // settles, or the countdown widget ends up off-screen / behind the shell — invisible.
    reassert(window, move |w| {
        let _ = w.set_size(LogicalSize::new(width, height));
        position_overlay(w, layout.position, width, height);
        let _ = w.set_always_on_top(true);
        show_widget(w);
        if !already_widget {
            let _ = w.unminimize();
        }
    });
}

/// Shows the countdown widget unless a fullscreen game currently hides it (0.19.7): a layout
/// change or a re-apply must not bring the widget back over the game.
fn show_widget(window: &WebviewWindow) {
    let hidden = window
        .app_handle()
        .state::<WidgetState>()
        .hidden_for_game
        .load(Ordering::SeqCst);
    if !hidden {
        let _ = window.show();
    }
}

/// 0.19.7: whether a fullscreen game is in front (the same check as the widget report).
#[cfg(windows)]
fn game_in_front(app: &AppHandle) -> bool {
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    diag::exclusive_fullscreen_foreground(&window).is_some()
}

#[cfg(not(windows))]
fn game_in_front(_app: &AppHandle) -> bool {
    false
}

/// 0.19.7: hides the countdown widget while a fullscreen game is in front, and shows it again
/// afterwards (owner setting `client.widget_hide_in_games`, default on). Only hides or shows the
/// window and never takes focus, so the game keeps its focus and the cursor stays hidden.
fn widget_watch_tick(app: &AppHandle) {
    let state = app.state::<WidgetState>();
    let overlay = state.overlay.load(Ordering::SeqCst);
    let hidden = state.hidden_for_game.load(Ordering::SeqCst);
    let want_hidden =
        overlay && state.hide_in_games.load(Ordering::SeqCst) && game_in_front(app);
    if want_hidden == hidden {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    state.hidden_for_game.store(want_hidden, Ordering::SeqCst);
    if want_hidden {
        let _ = window.hide();
    } else if overlay {
        let _ = window.show();
    }
}

/// 0.19.7: owner setting `client.widget_hide_in_games`, pushed by the client's settings.
#[tauri::command]
fn set_widget_hide_in_games(state: tauri::State<'_, WidgetState>, enabled: bool) {
    state.hide_in_games.store(enabled, Ordering::SeqCst);
}

/// The owner's `client.block_win_in_games` setting, pushed by the client's settings.
#[tauri::command]
fn set_block_win_in_games(enabled: bool) {
    kiosk::set_win_block_in_games(enabled);
}

/// Keeps the widget in the chosen corner of the work area (taskbar excluded) of the monitor the
/// window is on — after every resize, or a grown card would drift away from its corner.
fn position_overlay(window: &WebviewWindow, position: WidgetPosition, width: f64, height: f64) {
    let (mut x, mut y) = (OVERLAY_MARGIN, OVERLAY_MARGIN);
    if let Ok(Some(monitor)) = window.current_monitor() {
        let scale = monitor.scale_factor();
        let work = monitor.work_area();
        let size = work.size.to_logical::<f64>(scale);
        let pos = work.position.to_logical::<f64>(scale);
        let right = pos.x + size.width - width - OVERLAY_MARGIN;
        let bottom = pos.y + size.height - height - OVERLAY_MARGIN;
        // 0.19.1: the centre positions sit in the middle of the work area, at the top or bottom edge.
        let centre = pos.x + (size.width - width) / 2.0;
        let (cx, cy) = match position {
            WidgetPosition::TopLeft => (pos.x + OVERLAY_MARGIN, pos.y + OVERLAY_MARGIN),
            WidgetPosition::TopCenter => (centre, pos.y + OVERLAY_MARGIN),
            WidgetPosition::TopRight => (right, pos.y + OVERLAY_MARGIN),
            WidgetPosition::BottomLeft => (pos.x + OVERLAY_MARGIN, bottom),
            WidgetPosition::BottomCenter => (centre, bottom),
            WidgetPosition::BottomRight => (right, bottom),
            WidgetPosition::MiddleLeft => {
                (pos.x + OVERLAY_MARGIN, pos.y + (size.height - height) / 2.0)
            }
            WidgetPosition::MiddleRight => (right, pos.y + (size.height - height) / 2.0),
        };
        x = cx;
        y = cy;
    }
    let _ = window.set_position(LogicalPosition::new(x, y));
}

/// What `widget_check` answers: can the customer actually see the countdown right now (0.17.1).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WidgetCheck {
    ok: bool,
    detail: String,
}

/// 0.17.1: update check against the LIKApcs server on the LAN (cafe PCs usually have no
/// internet). The server serves the same signed manifest shape as the GitHub feed, so the
/// updater verifies the minisign signature exactly like it does for GitHub.
#[tauri::command]
async fn update_check_server(app: AppHandle, base: String) -> Result<Option<String>, String> {
    let updater = lan_updater(&app, base)?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| u.version))
}

/// Downloads the LAN installer and runs it (the app exits inside `install`, the NSIS updater
/// restarts it). Progress reaches the frontend as `update-progress` events (0..100 or null).
#[tauri::command]
async fn update_from_server(app: AppHandle, base: String) -> Result<Option<String>, String> {
    use tauri::Emitter;

    let updater = lan_updater(&app, base)?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let version = update.version.clone();
    let progress = app.clone();
    let finished = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                let pct = total.map(|t| ((chunk as f64 / t as f64) * 100.0).round() as u32);
                let _ = progress.emit("update-progress", pct);
            },
            move || {
                let _ = finished.emit("update-progress", 100u32);
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(Some(version))
}

fn lan_updater(app: &AppHandle, base: String) -> Result<tauri_plugin_updater::Updater, String> {
    use tauri_plugin_updater::UpdaterExt;
    let base = base.trim_end_matches('/');
    let url = format!("{base}/api/v1/updates/client-manifest");
    app.updater_builder()
        // `endpoints` returns Result; and the LAN feed is plain http:// — the config enables
        // `dangerousInsecureTransportProtocol`, which is safe here because the installer itself
        // is still minisign-verified with the same key as the GitHub feed.
        .endpoints(vec![url
            .parse()
            .map_err(|e| format!("bad server url: {e}"))?])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())
}

/// The PC's own answer to "is the widget visible?", plus the heal: a widget window that is
/// hidden, empty or parked outside every connected monitor is put back on the primary monitor's
/// work area before the report goes out. An exclusive-fullscreen foreground app (a game that
/// bypasses the desktop compositor) hides every topmost window — that is reported as the cause,
/// because no application can draw over it.
#[tauri::command]
async fn widget_check(
    app: AppHandle,
    state: tauri::State<'_, WidgetState>,
) -> Result<WidgetCheck, String> {
    if !state.overlay.load(Ordering::SeqCst) {
        return Ok(WidgetCheck {
            ok: true,
            detail: "not-overlay".into(),
        });
    }
    if state.hidden_for_game.load(Ordering::SeqCst) {
        // Hidden on purpose while a game runs (0.19.7): not a broken widget, so no heal.
        return Ok(WidgetCheck {
            ok: true,
            detail: "hidden-for-game".into(),
        });
    }
    let window = app
        .get_webview_window("main")
        .ok_or("main window missing")?;
    let layout = *state.layout.lock().map_err(|_| "widget state poisoned")?;

    let monitors = app.available_monitors().unwrap_or_default();
    let broken = {
        let visible = window.is_visible().unwrap_or(false);
        let size = window.inner_size().ok();
        let pos = window.outer_position().ok();
        let inside = match (&pos, &size) {
            (Some(p), Some(sz)) => monitors.iter().any(|m| {
                let mp = m.position();
                let ms = m.size();
                p.x >= mp.x - 64
                    && p.y >= mp.y - 64
                    && p.x < mp.x + ms.width as i32
                    && p.y < mp.y + ms.height as i32
                    && sz.width > 8
                    && sz.height > 8
            }),
            _ => false,
        };
        !visible || !inside
    };
    if broken {
        // Heal on the primary monitor rather than trusting `current_monitor` mid-transition.
        if let Some(primary) = app.primary_monitor().ok().flatten().or_else(|| monitors.first().cloned()) {
            let scale = primary.scale_factor();
            let work = primary.work_area();
            let (w, h) = layout.dimensions();
            let wa = work.size.to_logical::<f64>(scale);
            let wp = work.position.to_logical::<f64>(scale);
            let _ = window.set_size(LogicalSize::new(w, h));
            let _ = window.set_position(LogicalPosition::new(
                wp.x + wa.width - w - OVERLAY_MARGIN,
                wp.y + OVERLAY_MARGIN,
            ));
        }
        let _ = window.set_always_on_top(true);
        let _ = window.show();
        let _ = window.unminimize();
        let still = !window.is_visible().unwrap_or(false);
        let detail = if still {
            "hidden-after-heal".to_string()
        } else {
            "healed-offscreen-or-hidden".to_string()
        };
        append_crash_log(&format!("widget_check: broken → {detail}"));
        return Ok(WidgetCheck {
            ok: !still,
            detail,
        });
    }
    if let Some(title) = diag::exclusive_fullscreen_foreground(&window) {
        append_crash_log(&format!("widget_check: covered by exclusive-fullscreen app {title}"));
        return Ok(WidgetCheck {
            ok: false,
            detail: format!("fullscreen-app:{title}"),
        });
    }
    Ok(WidgetCheck {
        ok: true,
        detail: "visible".into(),
    })
}

/// Windows-only foreground check (see `widget_check`); always None elsewhere.
#[cfg(windows)]
mod diag {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowLongW, GetWindowTextW, GetWindowRect,
        GWL_STYLE, WS_CAPTION,
    };

    /// Title of the foreground window when it covers its whole monitor without a caption — the
    /// signature of an exclusive-fullscreen game (borderless ones keep WS_CAPTION-free popup
    /// style too, but those are composed by DWM and never hide a topmost window; a false
    /// positive there is harmless: the desk only reads it when the widget really is unseen).
    pub fn exclusive_fullscreen_foreground(window: &tauri::WebviewWindow) -> Option<String> {
        // SAFETY: plain Win32 queries without owned pointers.
        unsafe {
            let fg = GetForegroundWindow();
            if fg.is_null() {
                return None;
            }
            if let Ok(own) = window.hwnd() {
                // windows-sys HWND is a raw pointer; tauri's comes from the `windows` crate as a
                // struct — compare the addresses, not the types.
                if fg as isize == own.0 as isize {
                    return None;
                }
            }
            // The desktop and the shell (wallpaper, taskbar) cover the monitor without a caption
            // too: they are not games (0.19.7 — the widget now hides on this check).
            let mut class = [0u16; 64];
            let class_len = GetClassNameW(fg, class.as_mut_ptr(), class.len() as i32);
            let class_name = String::from_utf16_lossy(&class[..class_len.max(0) as usize]);
            if matches!(
                class_name.as_str(),
                "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
            ) {
                return None;
            }
            let style = GetWindowLongW(fg, GWL_STYLE);
            if style & WS_CAPTION as i32 != 0 {
                return None;
            }
            let mut rect = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            if GetWindowRect(fg, &mut rect) == 0 {
                return None;
            }
            let (w, h) = (rect.right - rect.left, rect.bottom - rect.top);
            let mut title = [0u16; 128];
            let len = GetWindowTextW(fg, title.as_mut_ptr(), title.len() as i32);
            let name = String::from_utf16_lossy(&title[..len.max(0) as usize]);
            // "Covers the monitor" ≈ at least a full-HD-sized rect: smaller popups are not games.
            if w >= 1280 && h >= 720 {
                return Some(if name.is_empty() {
                    "unknown".into()
                } else {
                    name
                });
            }
            None
        }
    }
}

#[cfg(not(windows))]
mod diag {
    pub fn exclusive_fullscreen_foreground(_window: &tauri::WebviewWindow) -> Option<String> {
        None
    }
}

/// The card widget grows to fit its words (staff notice, maintenance, an order flash): the
/// frontend measures what it rendered and asks for a window that shows all of it, so no text is
/// ever cut (0.17.0). Ignored while the window is not the widget.
#[tauri::command]
async fn widget_fit(
    app: AppHandle,
    state: tauri::State<'_, WidgetState>,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if !state.overlay.load(Ordering::SeqCst) {
        return Ok(());
    }
    let layout = *state.layout.lock().map_err(|_| "widget state poisoned")?;
    let (w, h) = (width.clamp(264.0, 900.0), height.clamp(60.0, 700.0));
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_size(LogicalSize::new(w, h));
        position_overlay(&window, layout.position, w, h);
    }
    Ok(())
}

/// Owner changed the widget design / size / corner (pushed by the server): remember it and, when
/// the widget is showing right now, resize and move it immediately. `width`/`height` are the
/// design's footprint in logical pixels (omitted by older frontends → classic card sizes).
#[tauri::command]
async fn set_widget_layout(
    app: AppHandle,
    state: tauri::State<'_, WidgetState>,
    size: String,
    position: String,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    let size = match size.as_str() {
        "small" => WidgetSize::Small,
        "normal" => WidgetSize::Normal,
        "large" => WidgetSize::Large,
        other => return Err(format!("unknown widget size {other}")),
    };
    let position = match position.as_str() {
        "top-left" => WidgetPosition::TopLeft,
        "top-center" => WidgetPosition::TopCenter,
        "top-right" => WidgetPosition::TopRight,
        "bottom-left" => WidgetPosition::BottomLeft,
        "bottom-center" => WidgetPosition::BottomCenter,
        "bottom-right" => WidgetPosition::BottomRight,
        "middle-left" => WidgetPosition::MiddleLeft,
        "middle-right" => WidgetPosition::MiddleRight,
        other => return Err(format!("unknown widget position {other}")),
    };
    let footprint = match (width, height) {
        (Some(w), Some(h)) => Some((w, h)),
        _ => None,
    };
    let layout = WidgetLayout {
        size,
        position,
        footprint,
    };
    *state.layout.lock().map_err(|_| "widget state poisoned")? = layout;
    if state.overlay.load(Ordering::SeqCst) {
        if let Some(window) = app.get_webview_window("main") {
            // Already the widget: a geometry change must not steal focus from the game.
            apply_overlay(&window, layout, true);
        }
    }
    Ok(())
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

/// 0.17.1: the frontend reports `webview_ready` the moment the React app has mounted. If that
/// handshake never arrives, the window would sit blank forever with nothing to click — the guard
/// in `setup` turns it into a native message + crash-log line instead.
pub struct WebviewReady(AtomicBool);

#[tauri::command]
fn webview_ready(state: tauri::State<'_, WebviewReady>) {
    state.0.store(true, Ordering::Release);
}

/// Async on purpose: creating webview windows (the covers) from a *synchronous* command
/// deadlocks on Windows (see `WebviewWindowBuilder::new`).
#[tauri::command]
async fn set_window_mode(app: AppHandle, mode: String) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("main window missing")?;
    let locked = app.state::<KioskState>().locked.clone();
    let widget = app.state::<WidgetState>();
    let was_widget = widget.overlay.swap(mode == "overlay", Ordering::SeqCst);
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
            let layout = *widget.layout.lock().map_err(|_| "widget state poisoned")?;
            apply_overlay(&window, layout, was_widget);
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

/// End Task (0.17.0): closes the programs the owner listed in Settings › Stations. Only
/// reachable through an authenticated, acknowledged server command (`tasks.end`); the native
/// side filters the list once more and refuses LIKApcs itself and the Windows shell.
#[tauri::command]
async fn end_tasks(exes: Vec<String>) -> Result<tasks::EndTasksReport, String> {
    // `taskkill` blocks per program: keep the UI thread free while the games go down.
    tauri::async_runtime::spawn_blocking(move || tasks::end_tasks(&exes))
        .await
        .map_err(|e| e.to_string())
}

/// Where a crash is written: `%LOCALAPPDATA%\LIKApcs-Client\crash.log` (the temp dir elsewhere).
fn crash_log_path() -> std::path::PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(std::env::temp_dir);
    base.join("LIKApcs-Client").join("crash.log")
}

#[cfg(windows)]
fn show_fatal_box(text: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND, MB_TOPMOST,
    };
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let text = wide(text);
    let title = wide("LIKApcs Client");
    // SAFETY: both buffers are NUL-terminated and outlive the call.
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR | MB_TOPMOST | MB_SETFOREGROUND,
        );
    }
}
#[cfg(not(windows))]
fn show_fatal_box(text: &str) {
    eprintln!("{text}");
}

fn append_crash_log(line: &str) -> std::path::PathBuf {
    let path = crash_log_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write;
        let unix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(file, "[unix {unix}] LIKApcs-Client {} {line}", env!("CARGO_PKG_VERSION"));
    }
    path
}

/// The window is a WebView2 view: without the runtime there is nothing to show. Windows 10 PCs
/// that never received the Edge updates (or installed the client offline) lack it — say so in
/// plain words instead of dying with a cryptic error.
#[cfg(windows)]
fn ensure_webview2() {
    match tauri::webview_version() {
        Err(err) => {
            let text = format!(
                "LIKApcs Client needs the Microsoft Edge WebView2 Runtime, which is not installed on this PC ({err}).\n\nRun LIKApcs-Client-Setup.exe again while the PC is connected to the internet (the installer downloads it), or install the \"Evergreen Bootstrapper\" from https://developer.microsoft.com/microsoft-edge/webview2/ — then start LIKApcs Client again."
            );
            let path = append_crash_log(&format!("cannot start: {text}"));
            show_fatal_box(&format!("{text}\n\n(Logged to {})", path.display()));
            std::process::exit(1);
        }
        Ok(version) => {
            // 0.17.1: an ancient runtime (Win10 PCs that were never updated can still carry the
            // WebView2 that shipped with Edge 1803, major < 90) cannot render this app — the
            // window would stay blank forever. Say so instead, with a box and a log line.
            let major: u32 = version
                .split('.')
                .next()
                .and_then(|n| n.parse().ok())
                .unwrap_or(u32::MAX);
            if major < 90 {
                let text = format!(
                    "The WebView2 Runtime on this PC is too old (version {version}). LIKApcs Client needs WebView2 90 or newer.\n\nUpdate this PC's WebView2 Runtime / Microsoft Edge (easiest: run LIKApcs-Client-Setup.exe again while the PC has internet), then start LIKApcs Client."
                );
                let path = append_crash_log(&format!("webview2 too old: {version}"));
                show_fatal_box(&format!("{text}\n\n(Logged to {})", path.display()));
                std::process::exit(1);
            }
        }
    }
}
#[cfg(not(windows))]
fn ensure_webview2() {}

/// A crash must never be silent on a gaming PC: whatever panics (release builds abort right
/// after) is appended to `crash.log`, the kiosk policies are undone so the machine is left usable,
/// and the staff see a message that says where the log is.
fn install_crash_reporter() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = info.to_string();
        let path = append_crash_log(&format!("crashed: {message}"));
        kiosk::restore();
        show_fatal_box(&format!(
            "LIKApcs Client {} stopped unexpectedly.\n\n{message}\n\nDetails were written to:\n{}\n\nStart the client again from the Start menu; if this repeats, send the file above to support.",
            env!("CARGO_PKG_VERSION"),
            path.display()
        ));
        previous(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_crash_reporter();
    ensure_webview2();
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
        .manage(WebviewReady(AtomicBool::new(false)))
        .manage(PanelAnchor(Mutex::new(None)))
        // Cheap handle only — the sysinfo/WMI workers start lazily on their own threads
        // (hardware.rs explains why they must never touch this, the UI, thread).
        .manage(Arc::new(hardware::HardwareState::new()))
        .manage(WidgetState {
            layout: Mutex::new(WidgetLayout {
                size: WidgetSize::Normal,
                position: WidgetPosition::TopRight,
                footprint: None,
            }),
            overlay: AtomicBool::new(false),
            hide_in_games: AtomicBool::new(true),
            hidden_for_game: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            device_identity,
            hardware_info,
            hardware_metrics,
            wol_configure,
            end_tasks,
            set_widget_layout,
            set_widget_hide_in_games,
            set_block_win_in_games,
            screen::capture_screen_frame,
            remote_input::send_remote_input,
            widget_fit,
            widget_check,
            update_check_server,
            update_from_server,
            webview_ready,
            secret_get,
            secret_set,
            secret_delete,
            set_desktop_wallpaper,
            restore_desktop_wallpaper,
            discover_servers,
            set_window_mode,
            power_action,
            tray_update,
            quit_app
        ])
        .setup(move |app| {
            // 0.19.7: hide the countdown widget while a fullscreen game runs (once a second).
            let watch = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(1000));
                widget_watch_tick(&watch);
            });
            // Keyboard hardening is armed from the start: the client boots locked.
            kiosk::install();
            kiosk::set_enabled(true);
            // Next boot must lock at once: drop the Windows startup delay for autostart apps.
            kiosk::arm_boot();

            // Blank-window guard (0.17.1): if the UI never reports itself mounted, the PC is
            // left with a blank window and no clue anywhere — that is exactly what the cafes
            // saw. Ten seconds later this becomes a native box + crash.log line.
            let guard = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(10));
                let ready = guard
                    .try_state::<WebviewReady>()
                    .map(|s| s.0.load(Ordering::Acquire))
                    .unwrap_or(true);
                if !ready {
                    let path = append_crash_log("webview handshake timeout: UI never reported ready");
                    show_fatal_box(&format!(
                        "LIKApcs Client's interface did not start on this PC within 10 seconds.\n\nLogged to {}.\n\nThe usual cause is an outdated Microsoft Edge WebView2 Runtime: update it (or rerun LIKApcs-Client-Setup.exe with internet) and start the client again.",
                        path.display()
                    ));
                    std::process::exit(2);
                }
            });

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
