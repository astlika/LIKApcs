//! LIKApcs-Client desktop shell.
//!
//! Thin native layer for the gaming-PC agent: kiosk window control (fullscreen lock screen vs. a
//! small always-on-top timer overlay), the machine identity, a DPAPI-backed secret store, LAN
//! discovery of the server, staff-requested power actions and the signed auto-updater. All
//! protocol logic lives in the TypeScript agent (`src/lib/agent.ts`).

mod secrets;

use serde::Serialize;
use std::net::{SocketAddr, UdpSocket};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewWindow, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

const DISCOVERY_PORT: u16 = 4701;
const DISCOVERY_REQUEST: &[u8] = b"LIKAPCS_DISCOVER_V1";
const OVERLAY_WIDTH: f64 = 300.0;
const OVERLAY_HEIGHT: f64 = 96.0;

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

#[cfg(windows)]
fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn hide_console(_cmd: &mut Command) {}

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
            Ok((len, _)) => {
                if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&buf[..len]) {
                    if value.get("service").and_then(|s| s.as_str()) == Some("likapcs") {
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
    let _ = window.set_skip_taskbar(false);
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

#[tauri::command]
fn set_window_mode(app: AppHandle, state: tauri::State<'_, KioskState>, mode: String) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("main window missing")?;
    match mode.as_str() {
        "locked" => {
            state.locked.store(true, Ordering::SeqCst);
            apply_locked(&window);
            Ok(())
        }
        "overlay" => {
            state.locked.store(false, Ordering::SeqCst);
            apply_overlay(&window);
            Ok(())
        }
        other => Err(format!("unknown window mode {other}")),
    }
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
        .invoke_handler(tauri::generate_handler![
            device_identity,
            secret_get,
            secret_set,
            secret_delete,
            discover_servers,
            set_window_mode,
            power_action
        ])
        .setup(move |app| {
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
            // The client is never closed by the customer; staff stop it via Task Manager or uninstall.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.show();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running LIKApcs Client");
}
