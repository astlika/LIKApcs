//! CS2 match server (0.24.0). This PC can install the Counter-Strike 2 dedicated server with
//! SteamCMD, run it, stop it, and start CS2 joined to a server. Only commands the LIKApcs server
//! sends reach this module, and the arguments and links are checked again here before anything
//! starts. Everything lives under %LOCALAPPDATA%\LIKApcs\cs2, so no admin rights are needed
//! except the one firewall prompt Windows shows during install.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const STEAMCMD_URL: &str = "https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip";
/// SteamCMD can take a long time on the first download (the server is about 30 GB).
const INSTALL_TIMEOUT: Duration = Duration::from_secs(90 * 60);
const CONNECT_PREFIX: &str = "steam://rungameid/730//+connect%20";
const SERVER_EXE: &str = "cs2.exe";

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Cs2Result {
    pub ok: bool,
    pub message: String,
    /// Install only: whether the firewall rules were added.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub firewall: Option<bool>,
}

fn fail(message: impl Into<String>) -> Cs2Result {
    Cs2Result {
        ok: false,
        message: message.into(),
        firewall: None,
    }
}

fn done(message: impl Into<String>) -> Cs2Result {
    Cs2Result {
        ok: true,
        message: message.into(),
        firewall: None,
    }
}

/// `%LOCALAPPDATA%\LIKApcs\cs2` (per user; `None` when the variable is missing).
fn root() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("LIKApcs").join("cs2"))
}

fn server_dir() -> Option<PathBuf> {
    root().map(|r| r.join("server"))
}

fn server_exe() -> Option<PathBuf> {
    server_dir().map(|s| s.join("game").join("bin").join("win64").join(SERVER_EXE))
}

fn steamcmd_exe() -> Option<PathBuf> {
    root().map(|r| r.join("steamcmd").join("steamcmd.exe"))
}

/// The server accepts only dedicated-mode launches with plain argv entries (no line breaks).
pub fn valid_server_args(args: &[String]) -> bool {
    !args.is_empty()
        && args.len() <= 80
        && args[0] == "-dedicated"
        && args
            .iter()
            .all(|a| a.len() <= 200 && !a.contains(['\r', '\n', '\0']))
}

/// Only the link LIKApcs builds: CS2 by app id, then an address, a port and an optional password.
pub fn valid_connect_url(url: &str) -> bool {
    if url.len() > 200 || !url.starts_with(CONNECT_PREFIX) {
        return false;
    }
    url[CONNECT_PREFIX.len()..]
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | ':' | '%' | '+'))
}

#[cfg(windows)]
fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_cmd: &mut Command) {}

fn ps_quote(s: &str) -> String {
    s.replace('\'', "''")
}

/// Writes a PowerShell script next to the server and runs it hidden, waiting at most `timeout`.
/// Returns the exit code, or an error text when it could not run or did not finish.
fn run_script(name: &str, body: &str, timeout: Duration) -> Result<i32, String> {
    let dir = root().ok_or("LOCALAPPDATA is not set")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let path = dir.join(name);
    std::fs::write(&path, body).map_err(|e| format!("cannot write {name}: {e}"))?;
    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
    ])
    .arg(&path)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    hide_console(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("cannot start PowerShell: {e}"))?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status.code().unwrap_or(-1)),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(200)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("timed out".into());
            }
            Err(e) => return Err(format!("lost the PowerShell process: {e}")),
        }
    }
}

/// Adds the firewall rules for the server (UDP and TCP on the game port). Windows asks for admin
/// rights through UAC; when the prompt is cancelled the rules are simply not added.
fn add_firewall_rules(exe: &Path, port: u16) -> bool {
    let fw_body = format!(
        "$ErrorActionPreference = 'Stop'\n\
         netsh advfirewall firewall delete rule name='LIKApcs CS2 server' | Out-Null\n\
         netsh advfirewall firewall add rule name='LIKApcs CS2 server' dir=in action=allow program='{exe}' enable=yes profile=private,domain | Out-Null\n\
         netsh advfirewall firewall add rule name='LIKApcs CS2 server ports' dir=in action=allow protocol=UDP localport={port} profile=private,domain | Out-Null\n\
         netsh advfirewall firewall add rule name='LIKApcs CS2 server ports TCP' dir=in action=allow protocol=TCP localport={port} profile=private,domain | Out-Null\n\
         exit 0\n",
        exe = ps_quote(&exe.to_string_lossy()),
        port = port,
    );
    let root = match root() {
        Some(r) => r,
        None => return false,
    };
    let fw_path = root.join("firewall.ps1");
    if std::fs::write(&fw_path, fw_body).is_err() {
        return false;
    }
    // Starts the rules script elevated (UAC) and waits for its exit code.
    let launcher = format!(
        "$p = Start-Process -FilePath powershell -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','{}') -Verb RunAs -WindowStyle Hidden -Wait -PassThru\n\
         exit $p.ExitCode\n",
        ps_quote(&fw_path.to_string_lossy()),
    );
    matches!(
        run_script("firewall-launch.ps1", &launcher, Duration::from_secs(300)),
        Ok(0)
    )
}

/// Downloads SteamCMD (once), installs the CS2 dedicated server, adds the firewall rules.
pub fn install() -> Cs2Result {
    if !cfg!(windows) {
        return fail("the CS2 server can only be installed on Windows");
    }
    let (Some(root), Some(server), Some(steamcmd), Some(exe)) =
        (root(), server_dir(), steamcmd_exe(), server_exe())
    else {
        return fail("LOCALAPPDATA is not set on this PC");
    };
    if let Err(e) = std::fs::create_dir_all(root.join("steamcmd")) {
        return fail(format!("cannot create the SteamCMD folder: {e}"));
    }
    if !steamcmd.exists() {
        let body = format!(
            "$ErrorActionPreference = 'Stop'\n\
             $zip = '{zip}'\n\
             Invoke-WebRequest -UseBasicParsing -Uri '{url}' -OutFile $zip\n\
             Expand-Archive -Force -Path $zip -DestinationPath '{dir}'\n",
            zip = ps_quote(&root.join("steamcmd.zip").to_string_lossy()),
            url = STEAMCMD_URL,
            dir = ps_quote(&root.join("steamcmd").to_string_lossy()),
        );
        match run_script("steamcmd-download.ps1", &body, Duration::from_secs(900)) {
            Ok(0) if steamcmd.exists() => {}
            Ok(code) => return fail(format!("SteamCMD could not be downloaded (exit {code})")),
            Err(e) => return fail(format!("SteamCMD download: {e}")),
        }
    }
    // `force_install_dir` must come before `login` (SteamCMD requirement).
    let mut cmd = Command::new(&steamcmd);
    cmd.args([
        "+force_install_dir",
        &server.to_string_lossy(),
        "+login",
        "anonymous",
        "+app_update",
        "730",
        "validate",
        "+quit",
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    hide_console(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return fail(format!("cannot start SteamCMD: {e}")),
    };
    let deadline = Instant::now() + INSTALL_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_secs(2)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return fail("the CS2 server download took too long and was stopped");
            }
            Err(e) => return fail(format!("lost SteamCMD: {e}")),
        }
    };
    if !status.success() || !exe.exists() {
        return fail(format!(
            "SteamCMD finished without the CS2 server (exit {:?}); try again",
            status.code()
        ));
    }
    let firewall = add_firewall_rules(&exe, 27015);
    Cs2Result {
        ok: true,
        message: if firewall {
            "CS2 server installed; firewall rules added".into()
        } else {
            "CS2 server installed. The firewall was not changed (the admin prompt was cancelled): \
             allow UDP and TCP 27015 for the players to join"
                .into()
        },
        firewall: Some(firewall),
    }
}

/// Whether a cs2.exe is already running on this PC (tasklist).
fn server_running() -> bool {
    let mut cmd = Command::new("tasklist");
    cmd.args(["/FI", &format!("IMAGENAME eq {SERVER_EXE}"), "/NH"])
        .stdin(Stdio::null());
    hide_console(&mut cmd);
    cmd.output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .to_lowercase()
                .contains(SERVER_EXE)
        })
        .unwrap_or(false)
}

/// Starts the server with the arguments the LIKApcs server built (`-dedicated …`).
pub fn start(args: Vec<String>) -> Cs2Result {
    if !valid_server_args(&args) {
        return fail("invalid CS2 server arguments");
    }
    let Some(exe) = server_exe() else {
        return fail("LOCALAPPDATA is not set on this PC");
    };
    if !exe.exists() {
        return fail("the CS2 server is not installed on this PC yet — install it first");
    }
    if server_running() {
        return done("the CS2 server is already running");
    }
    let mut cmd = Command::new(&exe);
    cmd.args(&args)
        .current_dir(exe.parent().unwrap_or(Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_console(&mut cmd);
    match cmd.spawn() {
        // The child keeps running after this handle is dropped.
        Ok(_) => done("the CS2 server started"),
        Err(e) => fail(format!("cannot start the CS2 server: {e}")),
    }
}

/// Stops the server on this PC. On a PC that also plays, this closes CS2 as well.
pub fn stop() -> Cs2Result {
    let mut cmd = Command::new("taskkill");
    cmd.args(["/IM", SERVER_EXE, "/F", "/T"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_console(&mut cmd);
    match cmd.status() {
        Ok(s) if s.success() => done("the CS2 server stopped"),
        Ok(_) => done("the CS2 server was not running"),
        Err(e) => fail(format!("cannot run taskkill: {e}")),
    }
}

/// Opens the link through Windows, which starts Steam and joins CS2 to the server.
pub fn connect(url: &str) -> Cs2Result {
    if !valid_connect_url(url) {
        return fail("invalid CS2 connect link");
    }
    // explorer.exe takes the steam:// link as one argument (no cmd.exe quoting problems).
    let mut cmd = Command::new("explorer");
    cmd.arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_console(&mut cmd);
    match cmd.spawn() {
        Ok(_) => done("opening CS2 and joining the server"),
        Err(e) => fail(format!("cannot open CS2: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_args_must_start_as_a_dedicated_launch() {
        let good: Vec<String> = ["-dedicated", "-usercon", "+map", "de_dust2"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert!(valid_server_args(&good));
        assert!(!valid_server_args(&[]));
        assert!(!valid_server_args(&["-applaunch".into(), "730".into()]));
        assert!(!valid_server_args(&["-dedicated".into(), "x\nrm".into()]));
        assert!(!valid_server_args(&["-dedicated".into(), "a".repeat(201)]));
    }

    #[test]
    fn connect_link_is_only_the_one_the_server_builds() {
        let ok =
            "steam://rungameid/730//+connect%20192.168.1.10:27015%20+password%20Ab3dEf9hJk2LmN4p";
        assert!(valid_connect_url(ok));
        assert!(valid_connect_url(
            "steam://rungameid/730//+connect%20192.168.1.10:27015"
        ));
        assert!(!valid_connect_url("https://evil.example/"));
        assert!(!valid_connect_url(
            "steam://rungameid/440//+connect%20192.168.1.10:27015"
        ));
        assert!(!valid_connect_url(&format!("{ok}&calc.exe")));
        assert!(!valid_connect_url(&format!("{ok} ")));
    }

    #[test]
    fn the_result_uses_camel_case_and_hides_firewall_when_unknown() {
        let json = serde_json::to_string(&done("x")).unwrap();
        assert_eq!(json, r#"{"ok":true,"message":"x"}"#);
        let json = serde_json::to_string(&Cs2Result {
            ok: false,
            message: "y".into(),
            firewall: Some(false),
        })
        .unwrap();
        assert_eq!(json, r#"{"ok":false,"message":"y","firewall":false}"#);
    }
}
