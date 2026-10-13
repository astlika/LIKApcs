//! LIKApcs Admin desktop shell.
//!
//! The Rust side stays thin: all business logic lives in the LIKApcs Server and the React frontend
//! talks to it over HTTP/WebSocket. The shell provides the native window, the tray icon, the signed
//! auto-updater (GitHub Releases, minisign-verified), start-at-login, LAN discovery and — on the main
//! PC — supervision of the bundled server process (see `server_manager.rs`).

mod display;
mod server_manager;

use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

use server_manager::{locate_runtime, ServerInfo, StartupStatus};

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[tauri::command]
async fn embedded_server_info() -> ServerInfo {
    // The loopback probe can take up to ~1 s when the server is down; keep it off the UI thread.
    tauri::async_runtime::spawn_blocking(server_manager::info)
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn embedded_server_start() -> Result<ServerInfo, String> {
    let rt = locate_runtime().ok_or("embedded server runtime not installed")?;
    tauri::async_runtime::spawn_blocking(move || {
        server_manager::ensure_running(&rt, Duration::from_secs(90)).map(|_| server_manager::info())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Non-blocking start: spawns the server (unless it already answers) and returns at once. Returns
/// true when a new process was started.
#[tauri::command]
async fn embedded_server_launch() -> Result<bool, String> {
    let rt = locate_runtime().ok_or("embedded server runtime not installed")?;
    tauri::async_runtime::spawn_blocking(move || server_manager::launch(&rt))
        .await
        .map_err(|e| e.to_string())?
}

/// Health + the server's own start-up progress file; polled by the start screen.
#[tauri::command]
async fn embedded_server_startup() -> StartupStatus {
    tauri::async_runtime::spawn_blocking(server_manager::startup_status)
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn embedded_server_stop() -> Result<ServerInfo, String> {
    let rt = locate_runtime().ok_or("embedded server runtime not installed")?;
    tauri::async_runtime::spawn_blocking(move || server_manager::stop(&rt).map(|_| server_manager::info()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn embedded_server_restart() -> Result<ServerInfo, String> {
    let rt = locate_runtime().ok_or("embedded server runtime not installed")?;
    tauri::async_runtime::spawn_blocking(move || server_manager::restart(&rt).map(|_| server_manager::info()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn embedded_server_log(max_bytes: Option<u64>) -> Result<String, String> {
    let max = max_bytes.unwrap_or(64 * 1024);
    tauri::async_runtime::spawn_blocking(move || server_manager::log_tail(max))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn discover_servers(timeout_ms: Option<u64>) -> Vec<serde_json::Value> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(2500).clamp(300, 15_000));
    tauri::async_runtime::spawn_blocking(move || server_manager::discover(timeout))
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn firewall_status() -> server_manager::FirewallStatus {
    tauri::async_runtime::spawn_blocking(server_manager::firewall_status)
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn allow_firewall() -> Result<(), String> {
    let rt = locate_runtime().ok_or("embedded server runtime not installed")?;
    tauri::async_runtime::spawn_blocking(move || server_manager::allow_firewall(&rt))
        .await
        .map_err(|e| e.to_string())?
}

/// Opens an http(s) link in the user's default browser (the WebView must never navigate away
/// from the app, and a `target=_blank` popup inside WebView2 is not a browser). Anything that is
/// not a plain web URL is refused.
#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
    let trimmed = url.trim().to_string();
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://"))
        || trimmed.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err("only http(s) links can be opened".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        let result = std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &trimmed])
            .spawn();
        #[cfg(target_os = "macos")]
        let result = std::process::Command::new("open").arg(&trimmed).spawn();
        #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
        let result = std::process::Command::new("xdg-open").arg(&trimmed).spawn();
        result.map(|_| ()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ─── Customer display (0.16.0) ─────────────────────────────────────────────────
#[tauri::command]
fn display_monitors(app: AppHandle) -> Vec<display::MonitorInfo> {
    display::monitors(&app)
}

/// Async on purpose: creating a webview window from a *synchronous* command deadlocks on Windows.
#[tauri::command]
async fn display_open(app: AppHandle, monitor: Option<String>) -> Result<bool, String> {
    display::open(&app, monitor.as_deref())
}

#[tauri::command]
async fn display_close(app: AppHandle) -> Result<(), String> {
    display::close(&app)
}

#[tauri::command]
fn display_is_open(app: AppHandle) -> bool {
    display::is_open(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let background = std::env::args().any(|a| a == "--background");

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ))
        .invoke_handler(tauri::generate_handler![
            embedded_server_info,
            embedded_server_start,
            embedded_server_launch,
            embedded_server_startup,
            embedded_server_stop,
            embedded_server_restart,
            embedded_server_log,
            discover_servers,
            firewall_status,
            allow_firewall,
            open_url,
            display_monitors,
            display_open,
            display_close,
            display_is_open
        ])
        .setup(move |app| {
            let has_runtime = locate_runtime().is_some();

            // Tray icon: the Admin window can be closed while the server keeps running.
            let open = MenuItem::with_id(app, "open", "Open LIKApcs", true, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart-server", "Restart server", has_runtime, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Close LIKApcs (server keeps running)", true, None::<&str>)?;
            let quit_all = MenuItem::with_id(app, "quit-all", "Stop server and close", has_runtime, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &open,
                    &PredefinedMenuItem::separator(app)?,
                    &restart,
                    &PredefinedMenuItem::separator(app)?,
                    &quit,
                    &quit_all,
                ],
            )?;
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("LIKApcs")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "restart-server" => {
                        if let Some(rt) = locate_runtime() {
                            std::thread::spawn(move || {
                                let _ = server_manager::restart(&rt);
                            });
                        }
                    }
                    "quit" => app.exit(0),
                    "quit-all" => {
                        if let Some(rt) = locate_runtime() {
                            let _ = server_manager::stop(&rt);
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // The window is created hidden (tauri.conf.json) so that an autostart with
            // `--background` never flashes a window; a normal launch shows it right away.
            if !background {
                show_main(app.handle());
            }

            // Main-PC install: make sure the bundled server is up (never blocks the UI thread).
            if let Some(rt) = locate_runtime() {
                std::thread::spawn(move || {
                    let _ = server_manager::ensure_running(&rt, Duration::from_secs(120));
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // With a bundled server, closing the window only hides it (the tray keeps it reachable).
            // The customer display window closes for real.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && locate_runtime().is_some() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running LIKApcs Admin");
}
