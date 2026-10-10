//! Supervises the LIKApcs Server that ships inside the main-PC installer.
//!
//! Layout next to the Admin executable (see `scripts/stage-runtime.ps1`):
//!   runtime/likapcs-server.exe        Node.js runtime
//!   runtime/server/dist/index.js      the server (fully bundled)
//!   runtime/server/dist/cli.js        server CLI (status / stop / discover)
//!   runtime/pgsql/                    portable PostgreSQL used by the server
//!
//! The server runs as a separate, detached background process owned by the logged-in user, so it
//! survives closing the Admin window and is restarted by the Admin app when it is not reachable.
//! Business data lives in the per-user data directory, never inside the installation folder.

use serde::Serialize;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const HTTP_PORT: u16 = 4700;
pub const DISCOVERY_PORT: u16 = 4701;
const DISCOVERY_REQUEST: &[u8] = b"LIKAPCS_DISCOVER_V1";

#[derive(Clone, Debug)]
pub struct Runtime {
    pub dir: PathBuf,
    pub node: PathBuf,
    pub script: PathBuf,
    pub cli: PathBuf,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    /// True when the embedded runtime is installed next to this executable ("main PC" install).
    pub available: bool,
    pub running: bool,
    pub version: Option<String>,
    pub port: u16,
    pub pid: Option<u64>,
    pub runtime_dir: Option<String>,
    pub data_dir: String,
    pub log_file: Option<String>,
}

fn server_exe_name() -> &'static str {
    if cfg!(windows) {
        "likapcs-server.exe"
    } else {
        "likapcs-server"
    }
}

/// Finds the bundled runtime: `<exe dir>/runtime` (NSIS layout) or `<exe dir>/../runtime`.
pub fn locate_runtime() -> Option<Runtime> {
    let exe = std::env::current_exe().ok()?;
    let base = exe.parent()?.to_path_buf();
    let mut candidates = vec![base.join("runtime")];
    if let Some(parent) = base.parent() {
        candidates.push(parent.join("runtime"));
    }
    if let Ok(dir) = std::env::var("LIKAPCS_RUNTIME_DIR") {
        candidates.insert(0, PathBuf::from(dir));
    }
    for dir in candidates {
        let node = dir.join(server_exe_name());
        let script = dir.join("server").join("dist").join("index.js");
        let cli = dir.join("server").join("dist").join("cli.js");
        if node.exists() && script.exists() && cli.exists() {
            return Some(Runtime { dir, node, script, cli });
        }
    }
    None
}

/// Mirrors `resolveDataDir()` in the server (apps/likapcs-server/src/embedded/paths.ts).
pub fn data_dir() -> PathBuf {
    if let Ok(explicit) = std::env::var("LIKAPCS_DATA_DIR") {
        return PathBuf::from(explicit);
    }
    if cfg!(windows) {
        let base = std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home_dir().join("AppData").join("Local"));
        return base.join("LIKApcs-Data");
    }
    if cfg!(target_os = "macos") {
        return home_dir().join("Library").join("Application Support").join("LIKApcs");
    }
    std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home_dir().join(".local").join("share"))
        .join("likapcs")
}

fn home_dir() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

#[cfg(windows)]
fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_cmd: &mut Command) {}

/// Minimal HTTP GET against the loopback health endpoint — no HTTP client dependency needed.
pub fn health(port: u16, timeout: Duration) -> Option<serde_json::Value> {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let mut stream = TcpStream::connect_timeout(&addr, timeout).ok()?;
    stream.set_read_timeout(Some(timeout)).ok()?;
    stream.set_write_timeout(Some(timeout)).ok()?;
    let request = format!(
        "GET /api/v1/system/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nAccept: application/json\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).ok()?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).ok()?;
    let text = String::from_utf8_lossy(&response);
    if !text.starts_with("HTTP/1.1 200") && !text.starts_with("HTTP/1.0 200") {
        return None;
    }
    let body = text.split("\r\n\r\n").nth(1)?.trim();
    serde_json::from_str(body).ok()
}

fn read_state(dir: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(dir.join("server.json")).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn info() -> ServerInfo {
    let runtime = locate_runtime();
    let data = data_dir();
    let live = health(HTTP_PORT, Duration::from_millis(900));
    let state = read_state(&data);
    ServerInfo {
        available: runtime.is_some(),
        running: live.is_some(),
        version: live
            .as_ref()
            .and_then(|h| h.get("version"))
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        port: HTTP_PORT,
        pid: if live.is_some() {
            state.as_ref().and_then(|s| s.get("pid")).and_then(|p| p.as_u64())
        } else {
            None
        },
        runtime_dir: runtime.as_ref().map(|r| r.dir.display().to_string()),
        data_dir: data.display().to_string(),
        log_file: Some(data.join("logs").join("server.log").display().to_string()),
    }
}

/// Last `max_bytes` of the bundled server's log file (only this fixed file is ever read, so the
/// command cannot be abused to read arbitrary files). Returns an empty string when there is no log.
pub fn log_tail(max_bytes: u64) -> Result<String, String> {
    let path = data_dir().join("logs").join("server.log");
    let mut file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(format!("cannot open {}: {e}", path.display())),
    };
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let max = max_bytes.clamp(1024, 1024 * 1024);
    if len > max {
        use std::io::Seek;
        file.seek(std::io::SeekFrom::Start(len - max))
            .map_err(|e| e.to_string())?;
    }
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    if len > max {
        // Drop the (probably partial) first line after seeking into the middle of the file.
        if let Some(nl) = text.find('\n') {
            text = text[nl + 1..].to_string();
        }
    }
    Ok(text)
}

/// Spawns the server as a detached background process (no console window, outlives this app).
pub fn start(rt: &Runtime) -> Result<(), String> {
    let cwd = rt
        .script
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| rt.dir.clone());
    let mut cmd = Command::new(&rt.node);
    cmd.arg(&rt.script)
        .arg("--background")
        .current_dir(cwd)
        .env("LIKAPCS_PORT", HTTP_PORT.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    cmd.spawn()
        .map(|_child| ()) // dropping Child does not kill the process
        .map_err(|e| format!("could not start the LIKApcs server ({}): {e}", rt.node.display()))
}

/// Progress of a starting server, read from `<data dir>/startup.json` (written by the server, see
/// apps/likapcs-server/src/embedded/startup-state.ts). The Admin's start screen polls this together
/// with the health endpoint, so the user sees the real phase/error instead of a blind spinner.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupStatus {
    /// True when the health endpoint answers (the server is ready).
    pub running: bool,
    /// Parsed startup.json, if present.
    pub startup: Option<serde_json::Value>,
    pub log_file: String,
}

/// Starts the server in the background when it is not reachable and returns immediately; use
/// `startup_status` to follow the progress. (`ensure_running` is the blocking variant.)
pub fn launch(rt: &Runtime) -> Result<bool, String> {
    if health(HTTP_PORT, Duration::from_millis(900)).is_some() {
        return Ok(false);
    }
    // A stale startup.json from an earlier failure must not be mistaken for this attempt.
    let _ = std::fs::remove_file(data_dir().join("startup.json"));
    start(rt)?;
    Ok(true)
}

pub fn startup_status() -> StartupStatus {
    let data = data_dir();
    let running = health(HTTP_PORT, Duration::from_millis(900)).is_some();
    let startup = std::fs::read_to_string(data.join("startup.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok());
    StartupStatus {
        running,
        startup,
        log_file: data.join("logs").join("server.log").display().to_string(),
    }
}

/// Makes sure the server answers on the loopback port, starting it when necessary.
pub fn ensure_running(rt: &Runtime, wait: Duration) -> Result<serde_json::Value, String> {
    if let Some(h) = health(HTTP_PORT, Duration::from_millis(900)) {
        return Ok(h);
    }
    start(rt)?;
    let deadline = Instant::now() + wait;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(500));
        if let Some(h) = health(HTTP_PORT, Duration::from_millis(900)) {
            return Ok(h);
        }
    }
    Err(format!(
        "the server did not become ready within {} s — see {}",
        wait.as_secs(),
        data_dir().join("logs").join("server.log").display()
    ))
}

/// Graceful stop through the server CLI (loopback control endpoint, token from the data dir).
pub fn stop(rt: &Runtime) -> Result<(), String> {
    let mut cmd = Command::new(&rt.node);
    cmd.arg(&rt.cli)
        .arg("stop")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    let output = cmd.output().map_err(|e| format!("could not run the server CLI: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

pub fn restart(rt: &Runtime) -> Result<serde_json::Value, String> {
    stop(rt)?;
    ensure_running(rt, Duration::from_secs(90))
}

/// Broadcasts a discovery datagram and collects every LIKApcs server that answers.
pub fn discover(timeout: Duration) -> Vec<serde_json::Value> {
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
    // Directed broadcast of the primary interface's /24 helps on networks that drop 255.255.255.255.
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
            Ok((len, _from)) => {
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
                // timeout tick → re-send once in a while, some stacks drop the first broadcast
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

/// Opens the Windows Firewall for the server (one UAC prompt). No-op on other platforms.
pub fn allow_firewall(rt: &Runtime) -> Result<(), String> {
    #[cfg(windows)]
    {
        let exe = rt.node.display().to_string();
        let script = format!(
            "$ErrorActionPreference = 'Stop'\n\
             Get-NetFirewallRule -DisplayName 'LIKApcs*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule\n\
             New-NetFirewallRule -DisplayName 'LIKApcs Server' -Direction Inbound -Program '{exe}' -Action Allow -Profile Any | Out-Null\n\
             New-NetFirewallRule -DisplayName 'LIKApcs Server API (TCP {http})' -Direction Inbound -Protocol TCP -LocalPort {http} -Action Allow -Profile Any | Out-Null\n\
             New-NetFirewallRule -DisplayName 'LIKApcs Discovery (UDP {disc})' -Direction Inbound -Protocol UDP -LocalPort {disc} -Action Allow -Profile Any | Out-Null\n",
            exe = exe.replace('\'', "''"),
            http = HTTP_PORT,
            disc = DISCOVERY_PORT
        );
        let script_path = std::env::temp_dir().join("likapcs-firewall.ps1");
        std::fs::write(&script_path, script).map_err(|e| e.to_string())?;
        let launcher = format!(
            "$p = Start-Process powershell -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"{}\"'; exit $p.ExitCode",
            script_path.display()
        );
        let mut cmd = Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &launcher])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_console(&mut cmd);
        let output = cmd.output().map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&script_path);
        if output.status.success() {
            Ok(())
        } else {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(if err.is_empty() { "firewall rule was not created (permission denied or cancelled)".into() } else { err })
        }
    }
    #[cfg(not(windows))]
    {
        let _ = rt;
        Ok(())
    }
}
