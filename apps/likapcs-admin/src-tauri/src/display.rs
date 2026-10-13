//! Customer display (0.16.0): a second webview window (`display.html`) that the cashier puts on
//! the monitor facing the customers. It is fed by the main window over Tauri events /
//! `BroadcastChannel` and never talks to the server itself; the Rust side only places the window.
//!
//! * `monitors()` lists the screens with size / position / scale and marks the one the Admin
//!   window is on, so the settings page can offer "Monitor 2 — 1920×1080".
//! * `open()` creates (or re-shows) the window full screen on the chosen monitor — by name, else
//!   the first monitor that is not the Admin's. With a single monitor it opens as a plain,
//!   resizable window instead (a preview the owner can look at); nothing is ever placed over the
//!   POS itself.
//! * `close()` closes it. Closing the Admin window never closes the display (the ads keep playing
//!   until the app quits).
use serde::Serialize;
use tauri::{AppHandle, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "display";

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    /// Platform name (`\\.\DISPLAY2` on Windows); the stored choice. Empty when unknown.
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub scale_factor: f64,
    /// The monitor the Admin window currently sits on (never chosen automatically).
    pub current: bool,
    pub primary: bool,
}

fn main_monitor(app: &AppHandle) -> Option<Monitor> {
    app.get_webview_window("main")
        .and_then(|w| w.current_monitor().ok().flatten())
}

fn same(a: &Monitor, b: &Monitor) -> bool {
    a.position() == b.position() && a.size() == b.size()
}

pub fn monitors(app: &AppHandle) -> Vec<MonitorInfo> {
    let current = main_monitor(app);
    let primary = app.primary_monitor().ok().flatten();
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| MonitorInfo {
            name: m.name().cloned().unwrap_or_default(),
            width: m.size().width,
            height: m.size().height,
            x: m.position().x,
            y: m.position().y,
            scale_factor: m.scale_factor(),
            current: current.as_ref().map(|c| same(c, m)).unwrap_or(false),
            primary: primary.as_ref().map(|p| same(p, m)).unwrap_or(false),
        })
        .collect()
}

/// Picks the target monitor: the named one when it is still connected, else the first screen the
/// Admin window is not on. `None` = only one monitor → windowed preview.
fn pick(app: &AppHandle, wanted: Option<&str>) -> Option<Monitor> {
    let monitors = app.available_monitors().ok()?;
    let current = main_monitor(app);
    if let Some(name) = wanted.filter(|n| !n.is_empty()) {
        if let Some(m) = monitors.iter().find(|m| m.name().map(|s| s.as_str()) == Some(name)) {
            return Some(m.clone());
        }
    }
    monitors
        .iter()
        .find(|m| current.as_ref().map(|c| !same(c, m)).unwrap_or(true))
        .cloned()
}

/// Returns true when the display went full screen on its own monitor (false = windowed preview).
pub fn open(app: &AppHandle, wanted: Option<&str>) -> Result<bool, String> {
    let target = pick(app, wanted);
    let fullscreen = target.is_some();
    let window = match app.get_webview_window(LABEL) {
        Some(w) => w,
        None => WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("display.html".into()))
            .title("LIKApcs — Customer display")
            .decorations(!fullscreen)
            .resizable(!fullscreen)
            .skip_taskbar(fullscreen)
            .focused(false)
            .inner_size(960.0, 600.0)
            .min_inner_size(480.0, 320.0)
            .visible(false)
            .build()
            .map_err(|e| e.to_string())?,
    };
    match target {
        Some(m) => {
            let _ = window.set_fullscreen(false);
            let _ = window.set_decorations(false);
            let _ = window.set_position(PhysicalPosition::new(m.position().x, m.position().y));
            let _ = window.set_size(PhysicalSize::new(m.size().width, m.size().height));
            let _ = window.set_fullscreen(true);
        }
        None => {
            let _ = window.set_fullscreen(false);
            let _ = window.set_decorations(true);
        }
    }
    let _ = window.show();
    // The cashier keeps typing / scanning into the POS: give the focus straight back.
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_focus();
    }
    Ok(fullscreen)
}

pub fn close(app: &AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn is_open(app: &AppHandle) -> bool {
    app.get_webview_window(LABEL)
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false)
}
