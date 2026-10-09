//! LIKApcs Admin desktop shell.
//!
//! The Rust side is intentionally thin: all business logic lives in the LIKApcs Server and the
//! React frontend talks to it over HTTP/WebSocket. The shell provides the native window, the
//! signed auto-updater (GitHub Releases, minisign-verified) and process restart after an update.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .run(tauri::generate_context!())
        .expect("error while running LIKApcs Admin");
}
