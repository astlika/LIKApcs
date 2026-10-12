//! Wake-on-LAN support on the PC side (0.7.0).
//!
//! The server sends the magic packet; this module only answers two questions and performs one
//! action:
//!
//! * **facts** — which physical network adapters the PC has (name, MAC, current IPv4, link up),
//!   whether Windows lets each one wake the machine on a magic packet, and whether Windows
//!   "Fast startup" is on (while it is, a shut-down PC is really hibernated and most boards
//!   ignore magic packets). The Admin turns this into a readiness badge; the server picks the
//!   MAC to address.
//! * **configure** — switch the Windows side on: *wake on magic packet* for every physical
//!   adapter and Fast startup off. Both need administrator rights. The client normally runs as
//!   the ordinary gaming account, so this first tries in-process (works when the account is an
//!   admin or UAC is off) and otherwise asks Windows to elevate — a UAC prompt appears on the
//!   PC's screen and staff confirm it there. The outcome goes back to the Admin either way; a
//!   declined prompt is reported, never hidden. The BIOS/UEFI side ("Wake on LAN" / "Power on by
//!   PCI-E") cannot be touched from Windows at all — see docs/wake-on-lan.md.
//!
//! Everything shells out to a hidden PowerShell with a bounded wait, so a stuck WMI query costs
//! a missing value, never a hung agent. Nothing here touches COM, but the same rule as
//! `hardware.rs` applies: call from a worker thread (`spawn_blocking`), never the UI thread.

use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkAdapter {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Upper-case, colon separated (`08:BF:B8:12:34:56`).
    pub mac: String,
    #[serde(default)]
    pub ipv4: Option<String>,
    #[serde(default)]
    pub up: Option<bool>,
    /// Windows power-management flag "wake on magic packet"; `None` when it could not be read.
    #[serde(default)]
    pub wake_on_magic_packet: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WolFacts {
    #[serde(default)]
    pub adapters: Vec<NetworkAdapter>,
    #[serde(default)]
    pub fast_startup: Option<bool>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureOutcome {
    pub ok: bool,
    /// Human-readable summary for the audit log ("2 adapters enabled, Fast startup off").
    pub message: String,
    /// True when the change needed (and got) a UAC elevation.
    pub elevated: bool,
}

const FACTS_TIMEOUT: Duration = Duration::from_secs(20);
const CONFIGURE_TIMEOUT: Duration = Duration::from_secs(45);
/// Long enough for staff to walk to the PC and answer the UAC prompt.
const ELEVATED_TIMEOUT: Duration = Duration::from_secs(120);
/// Exit code the configuration script uses for "I am not elevated".
const EXIT_NEEDS_ELEVATION: i32 = 5;

// ─── Facts ─────────────────────────────────────────────────────────────────────

/// Adapters + Fast startup. Empty / `None` outside Windows or when PowerShell is unavailable.
pub fn facts() -> WolFacts {
    if !cfg!(windows) {
        return WolFacts::default();
    }
    let Some(out) = run_powershell(&["-Command", FACTS_SCRIPT], FACTS_TIMEOUT) else {
        return WolFacts::default();
    };
    parse_facts(&out)
}

/// Pure parser (unit-tested): tolerates PowerShell's habit of emitting a bare object instead of
/// a one-element array and the dash-separated MAC format Windows uses.
pub fn parse_facts(json: &str) -> WolFacts {
    let trimmed = json.trim();
    if trimmed.is_empty() {
        return WolFacts::default();
    }
    let mut facts: WolFacts = match serde_json::from_str::<serde_json::Value>(trimmed) {
        Ok(serde_json::Value::Object(mut map)) => {
            // `adapters` may be an object when PowerShell unwrapped a single element.
            if let Some(single @ serde_json::Value::Object(_)) = map.get("adapters").cloned() {
                map.insert("adapters".into(), serde_json::Value::Array(vec![single]));
            }
            serde_json::from_value(serde_json::Value::Object(map)).unwrap_or_default()
        }
        _ => return WolFacts::default(),
    };
    facts.adapters = facts
        .adapters
        .into_iter()
        .filter_map(|mut a| {
            a.mac = normalize_mac(&a.mac)?;
            a.name = a.name.trim().chars().take(120).collect();
            a.description = a
                .description
                .map(|d| d.trim().chars().take(120).collect::<String>())
                .filter(|d| !d.is_empty());
            a.ipv4 = a.ipv4.map(|ip| ip.trim().to_string()).filter(|ip| !ip.is_empty());
            Some(a)
        })
        .take(8)
        .collect();
    facts
}

/// `08-bf-b8-12-34-56` / `08:BF:B8:12:34:56` / `08bfb8123456` → `08:BF:B8:12:34:56`.
pub fn normalize_mac(raw: &str) -> Option<String> {
    let hex: String = raw
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if hex.len() != 12 || raw.chars().any(|c| !(c.is_ascii_hexdigit() || c == ':' || c == '-')) {
        return None;
    }
    if hex == "000000000000" {
        return None;
    }
    Some(
        hex.as_bytes()
            .chunks(2)
            .map(|pair| std::str::from_utf8(pair).unwrap_or("00"))
            .collect::<Vec<_>>()
            .join(":"),
    )
}

/// One PowerShell pass: physical adapters joined with their power-management flag and IPv4,
/// plus the Fast startup registry switch. Emits one JSON object on stdout.
const FACTS_SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$pm = @{}
Get-NetAdapterPowerManagement | ForEach-Object { $pm[$_.Name] = [string]$_.WakeOnMagicPacket }
$ips = @{}
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -ne 'WellKnown' } | ForEach-Object {
  $k = [int]$_.InterfaceIndex
  if (-not $ips.ContainsKey($k)) { $ips[$k] = [string]$_.IPAddress }
}
$list = @(Get-NetAdapter -Physical | ForEach-Object {
  $w = $pm[$_.Name]
  [pscustomobject]@{
    name = [string]$_.Name
    description = [string]$_.InterfaceDescription
    mac = [string]$_.MacAddress
    ipv4 = $ips[[int]$_.ifIndex]
    up = ($_.Status -eq 'Up')
    wakeOnMagicPacket = $(if ($w -eq 'Enabled') { $true } elseif ($w -eq 'Disabled' -or $w -eq 'Unsupported') { $false } else { $null })
  }
})
$fs = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -Name HiberbootEnabled).HiberbootEnabled
$fastStartup = $(if ($null -eq $fs) { $null } else { [bool]$fs })
[pscustomobject]@{ adapters = $list; fastStartup = $fastStartup } | ConvertTo-Json -Compress -Depth 4
"#;

// ─── Configure ─────────────────────────────────────────────────────────────────

/// Script that does the actual change. It refuses with exit 5 when not elevated, so the caller
/// knows to retry through UAC; it writes its summary to `-ResultPath` because the stdout of an
/// elevated process cannot be read from a non-elevated one.
const CONFIGURE_SCRIPT: &str = r#"param([string]$ResultPath)
$ErrorActionPreference = 'Continue'
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { exit 5 }
$enabled = @()
$errors = @()
Get-NetAdapter -Physical | ForEach-Object {
  $n = $_.Name
  try {
    Set-NetAdapterPowerManagement -Name $n -WakeOnMagicPacket Enabled -ErrorAction Stop
    $enabled += $n
  } catch {
    $errors += ($n + ': ' + $_.Exception.Message)
  }
}
try {
  New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -Name HiberbootEnabled -Value 0 -PropertyType DWord -Force -ErrorAction Stop | Out-Null
  $fast = 'off'
} catch {
  $fast = 'unchanged'
  $errors += ('fast startup: ' + $_.Exception.Message)
}
$result = [pscustomobject]@{ ok = ($errors.Count -eq 0); enabled = @($enabled); fastStartup = $fast; errors = @($errors) }
$result | ConvertTo-Json -Compress -Depth 3 | Set-Content -LiteralPath $ResultPath -Encoding UTF8
exit 0
"#;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ScriptResult {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    enabled: Vec<String>,
    #[serde(default)]
    fast_startup: Option<String>,
    #[serde(default)]
    errors: Vec<String>,
}

/// Turns the Windows side of Wake-on-LAN on. Never panics; every failure becomes a message.
pub fn configure() -> ConfigureOutcome {
    if !cfg!(windows) {
        return ConfigureOutcome {
            ok: false,
            message: "Wake-on-LAN configuration is only available on Windows".into(),
            elevated: false,
        };
    }
    let dir = std::env::temp_dir();
    let script_path = dir.join("likapcs-wol-configure.ps1");
    let result_path = dir.join("likapcs-wol-configure.result.json");
    let _ = std::fs::remove_file(&result_path);
    if let Err(err) = std::fs::write(&script_path, CONFIGURE_SCRIPT) {
        return ConfigureOutcome {
            ok: false,
            message: format!("could not write the configuration script: {err}"),
            elevated: false,
        };
    }
    let script = script_path.to_string_lossy().into_owned();
    let result_file = result_path.to_string_lossy().into_owned();

    // 1) In-process attempt (succeeds when the account already has admin rights).
    let direct = run_powershell_status(
        &[
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &script,
            "-ResultPath",
            &result_file,
        ],
        CONFIGURE_TIMEOUT,
    );
    let mut elevated = false;
    match direct {
        Some(code) if code == EXIT_NEEDS_ELEVATION => {
            // 2) Ask Windows to elevate: UAC prompt on the PC, staff confirm there.
            elevated = true;
            let command = format!(
                "Start-Process -FilePath powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','{}','-ResultPath','{}')",
                ps_quote(&script),
                ps_quote(&result_file)
            );
            match run_powershell_status(&["-Command", &command], ELEVATED_TIMEOUT) {
                Some(0) => {}
                Some(_) => {
                    let _ = std::fs::remove_file(&script_path);
                    return ConfigureOutcome {
                        ok: false,
                        message: "administrator confirmation was declined on the PC".into(),
                        elevated,
                    };
                }
                None => {
                    let _ = std::fs::remove_file(&script_path);
                    return ConfigureOutcome {
                        ok: false,
                        message: "no administrator confirmation on the PC within 2 minutes".into(),
                        elevated,
                    };
                }
            }
        }
        Some(0) => {}
        Some(code) => {
            let _ = std::fs::remove_file(&script_path);
            return ConfigureOutcome {
                ok: false,
                message: format!("configuration script failed (exit {code})"),
                elevated,
            };
        }
        None => {
            let _ = std::fs::remove_file(&script_path);
            return ConfigureOutcome {
                ok: false,
                message: "PowerShell did not finish in time".into(),
                elevated,
            };
        }
    }
    let _ = std::fs::remove_file(&script_path);
    let outcome = match std::fs::read_to_string(&result_path) {
        Ok(json) => summarize(&json, elevated),
        Err(_) => ConfigureOutcome {
            ok: false,
            message: "the configuration script left no result".into(),
            elevated,
        },
    };
    let _ = std::fs::remove_file(&result_path);
    outcome
}

/// Turns the script's JSON into the one-line outcome (unit-tested).
pub fn summarize(json: &str, elevated: bool) -> ConfigureOutcome {
    // PowerShell writes UTF-8 with a BOM; serde does not like the BOM.
    let json = json.trim_start_matches('\u{feff}').trim();
    let parsed: ScriptResult = serde_json::from_str(json).unwrap_or_default();
    let mut parts = vec![format!(
        "{} adapter{} set to wake on magic packet",
        parsed.enabled.len(),
        if parsed.enabled.len() == 1 { "" } else { "s" }
    )];
    match parsed.fast_startup.as_deref() {
        Some("off") => parts.push("Fast startup off".into()),
        _ => parts.push("Fast startup unchanged".into()),
    }
    if !parsed.errors.is_empty() {
        parts.push(format!("errors: {}", parsed.errors.join("; ")));
    }
    ConfigureOutcome {
        ok: parsed.ok && !parsed.enabled.is_empty(),
        message: parts.join(", "),
        elevated,
    }
}

/// Single-quotes a string for a PowerShell literal (`'` → `''`).
fn ps_quote(s: &str) -> String {
    s.replace('\'', "''")
}

// ─── PowerShell plumbing ───────────────────────────────────────────────────────

/// Runs a hidden PowerShell and returns its stdout, or `None` on timeout / spawn failure.
fn run_powershell(args: &[&str], timeout: Duration) -> Option<String> {
    let (status, stdout) = run_powershell_inner(args, timeout)?;
    let _ = status;
    Some(stdout)
}

/// Same, but only the exit code (`None` on timeout / spawn failure).
fn run_powershell_status(args: &[&str], timeout: Duration) -> Option<i32> {
    run_powershell_inner(args, timeout).map(|(code, _)| code)
}

fn run_powershell_inner(args: &[&str], timeout: Duration) -> Option<(i32, String)> {
    use std::process::{Command, Stdio};
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive"])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide_console(&mut cmd);
    let mut child = cmd.spawn().ok()?;
    // Drain stdout while waiting so a chatty script cannot block on a full pipe.
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = String::new();
        let _ = stdout.read_to_string(&mut buf);
        buf
    });
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let out = reader.join().unwrap_or_default();
                return Some((status.code().unwrap_or(-1), out));
            }
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(100));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

#[cfg(windows)]
fn hide_console(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn hide_console(_cmd: &mut std::process::Command) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_mac_formats() {
        assert_eq!(normalize_mac("08-bf-b8-12-34-56").as_deref(), Some("08:BF:B8:12:34:56"));
        assert_eq!(normalize_mac("08:BF:B8:12:34:56").as_deref(), Some("08:BF:B8:12:34:56"));
        assert_eq!(normalize_mac("08BFB8123456").as_deref(), Some("08:BF:B8:12:34:56"));
        assert_eq!(normalize_mac("00-00-00-00-00-00"), None);
        assert_eq!(normalize_mac("not a mac"), None);
        assert_eq!(normalize_mac("08-bf-b8-12-34"), None);
    }

    #[test]
    fn parses_facts_including_single_adapter_object() {
        let f = parse_facts(
            r#"{"adapters":{"name":"Ethernet","description":"Realtek PCIe GbE","mac":"08-BF-B8-12-34-56","ipv4":"192.168.1.21","up":true,"wakeOnMagicPacket":true},"fastStartup":true}"#,
        );
        assert_eq!(f.adapters.len(), 1);
        assert_eq!(f.adapters[0].mac, "08:BF:B8:12:34:56");
        assert_eq!(f.adapters[0].ipv4.as_deref(), Some("192.168.1.21"));
        assert_eq!(f.adapters[0].wake_on_magic_packet, Some(true));
        assert_eq!(f.fast_startup, Some(true));

        let many = parse_facts(
            r#"{"adapters":[{"name":"Wi-Fi","mac":"3C-F0-11-AA-BB-CC","up":false,"wakeOnMagicPacket":null},{"name":"Bad","mac":"zz"}],"fastStartup":null}"#,
        );
        assert_eq!(many.adapters.len(), 1, "adapters without a usable MAC are dropped");
        assert_eq!(many.adapters[0].wake_on_magic_packet, None);
        assert_eq!(many.fast_startup, None);

        assert_eq!(parse_facts(""), WolFacts::default());
        assert_eq!(parse_facts("garbage"), WolFacts::default());
    }

    #[test]
    fn summarizes_script_results() {
        let ok = summarize(
            "\u{feff}{\"ok\":true,\"enabled\":[\"Ethernet\"],\"fastStartup\":\"off\",\"errors\":[]}",
            true,
        );
        assert!(ok.ok);
        assert!(ok.elevated);
        assert_eq!(ok.message, "1 adapter set to wake on magic packet, Fast startup off");

        let failed = summarize(
            r#"{"ok":false,"enabled":[],"fastStartup":"unchanged","errors":["Ethernet: Access is denied"]}"#,
            false,
        );
        assert!(!failed.ok);
        assert!(failed.message.contains("Access is denied"));

        assert!(!summarize("", false).ok);
    }
}
