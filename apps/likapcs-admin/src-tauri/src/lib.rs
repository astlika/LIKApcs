//! LIKApcs Admin desktop shell.
//!
//! The Rust side is intentionally thin: all business logic lives in the LIKApcs Server and the
//! React frontend talks to it over HTTP/WebSocket. The shell only provides native window
//! management and (from Phase 7) signed auto-updates.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .run(tauri::generate_context!())
        .expect("error while running LIKApcs Admin");
}
