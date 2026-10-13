//! End Task (0.17.0) — "close the games on this PC" from the desk.
//!
//! The staff button (or the automatic run at the end of a session) sends `tasks.end` with the
//! list of programs the owner keeps in Settings › Stations. This module is the last line of
//! defence on the PC itself: every entry is reduced to a plain `name.exe`, checked against a
//! hard-coded protected list (LIKApcs-Client, its WebView2, the Windows shell and system
//! processes) and only then handed to `taskkill`. Nothing outside that list is ever touched and
//! there is no way to ask for "close everything".
//!
//! The report (`closed` / `notRunning` / `failed` / `skipped`) goes back to the server as the
//! `tasks_ended` client event, which is what the Admin shows and audits.

use serde::Serialize;
use std::process::{Command, Stdio};

use crate::hide_console;

/// Names that can never be closed, whatever the server asks for. Mirrors
/// `PROTECTED_PROCESSES` in `packages/shared/src/end-tasks.ts` (that copy guards the Admin input
/// and the server settings, this one guards the PC).
const PROTECTED: &[&str] = &[
    "likapcs-client.exe",
    "likapcs.exe",
    "msedgewebview2.exe",
    "explorer.exe",
    "csrss.exe",
    "winlogon.exe",
    "wininit.exe",
    "services.exe",
    "lsass.exe",
    "smss.exe",
    "svchost.exe",
    "dwm.exe",
    "system",
    "fontdrvhost.exe",
    "sihost.exe",
    "taskhostw.exe",
    "ctfmon.exe",
    "conhost.exe",
    "runtimebroker.exe",
    "audiodg.exe",
    "spoolsv.exe",
    "searchhost.exe",
    "startmenuexperiencehost.exe",
    "shellexperiencehost.exe",
    "textinputhost.exe",
    "securityhealthservice.exe",
    "msmpeng.exe",
    "taskmgr.exe",
    "cmd.exe",
    "powershell.exe",
];

const MAX_NAME_LEN: usize = 64;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FailedTask {
    pub exe: String,
    pub error: String,
}

/// What the PC did with one End Task request.
#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EndTasksReport {
    /// Running programs that are closed now.
    pub closed: Vec<String>,
    /// Listed programs that were not running at all.
    pub not_running: Vec<String>,
    /// Programs Windows would not close (access denied, …).
    pub failed: Vec<FailedTask>,
    /// Entries refused before `taskkill` was ever called (protected, malformed, ourselves).
    pub skipped: Vec<String>,
}

fn is_allowed_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '(' | ')' | '+' | '\'' | '-')
}

/// Reduces one entry to a bare `name.exe`, or `None` when it must not be touched.
fn sanitize(entry: &str) -> Option<String> {
    let trimmed = entry.trim().trim_matches(|c| c == '"' || c == '\'');
    // A path is accepted but only its file name is used — `taskkill /IM` takes a name.
    let split = match (trimmed.rfind('\\'), trimmed.rfind('/')) {
        (Some(a), Some(b)) => a.max(b) + 1,
        (Some(a), None) => a + 1,
        (None, Some(b)) => b + 1,
        (None, None) => 0,
    };
    let name = trimmed[split.min(trimmed.len())..].trim();
    if name.is_empty() || name.len() > MAX_NAME_LEN {
        return None;
    }
    let lowered = name.to_ascii_lowercase();
    if !lowered.ends_with(".exe") {
        // `steam.exe -t` is a command line, not a program name.
        if lowered.contains(".exe") {
            return None;
        }
    }
    let with_ext = if lowered.ends_with(".exe") {
        format!("{}.exe", &name[..name.len() - 4])
    } else {
        format!("{name}.exe")
    };
    if with_ext.len() > MAX_NAME_LEN || !with_ext.chars().all(is_allowed_char) {
        return None;
    }
    if !with_ext.chars().next().map_or(false, |c| c.is_ascii_alphanumeric()) {
        return None;
    }
    if PROTECTED.contains(&with_ext.to_ascii_lowercase().as_str()) {
        return None;
    }
    Some(with_ext)
}

/// Our own executable name — never closed, even if somebody managed to list it.
fn own_exe_name() -> Option<String> {
    std::env::current_exe()
        .ok()?
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
}

fn kill(name: &str) -> Result<bool, String> {
    if cfg!(windows) {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/IM", name, "/F", "/T"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_console(&mut cmd);
        let out = cmd.output().map_err(|e| e.to_string())?;
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() {
            return Ok(true);
        }
        // taskkill answers 128 (and "… not found.") for a program that is not running.
        let text = format!("{stderr} {stdout}").to_ascii_lowercase();
        let code = out.status.code().unwrap_or(-1);
        if code == 128 || text.contains("not found") || text.contains("no tasks") {
            return Ok(false);
        }
        let detail = if stderr.is_empty() {
            format!("taskkill exited with {code}")
        } else {
            stderr
        };
        Err(detail.chars().take(200).collect())
    } else {
        // Development machines (Linux/macOS): the same semantics with pkill on the bare name.
        let stem = name.trim_end_matches(".exe");
        let out = Command::new("pkill")
            .args(["-x", stem])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| e.to_string())?;
        match out.status.code() {
            Some(0) => Ok(true),
            Some(1) => Ok(false),
            code => {
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                Err(if stderr.is_empty() {
                    format!("pkill exited with {code:?}")
                } else {
                    stderr
                })
            }
        }
    }
}

/// Closes every listed program and reports one entry per name. Never fails as a whole: a
/// program that cannot be closed is reported, it does not stop the others.
pub fn end_tasks(exes: &[String]) -> EndTasksReport {
    let mut report = EndTasksReport::default();
    let own = own_exe_name();
    for entry in exes {
        let Some(name) = sanitize(entry) else {
            report.skipped.push(entry.clone());
            continue;
        };
        if own.as_deref() == Some(name.to_ascii_lowercase().as_str()) {
            report.skipped.push(name);
            continue;
        }
        match kill(&name) {
            Ok(true) => report.closed.push(name),
            Ok(false) => report.not_running.push(name),
            Err(error) => report.failed.push(FailedTask { exe: name, error }),
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reduces_paths_and_appends_the_extension() {
        assert_eq!(sanitize("steam").as_deref(), Some("steam.exe"));
        assert_eq!(sanitize("  cs2.EXE ").as_deref(), Some("cs2.exe"));
        assert_eq!(
            sanitize(r"C:\Program Files (x86)\Steam\steam.exe").as_deref(),
            Some("steam.exe")
        );
        assert_eq!(sanitize("\"Battle.net.exe\"").as_deref(), Some("Battle.net.exe"));
    }

    #[test]
    fn refuses_protected_malformed_or_overlong_names() {
        let overlong = "x".repeat(70);
        for bad in [
            "likapcs-client.exe",
            "LIKApcs-Client",
            r"C:\Windows\explorer.exe",
            "svchost",
            "",
            "   ",
            ".exe",
            "steam.exe -t",
            "steam?.exe",
            overlong.as_str(),
        ] {
            assert_eq!(sanitize(bad), None, "{bad:?} must be refused");
        }
    }

    #[test]
    fn reports_every_entry_exactly_once() {
        let report = end_tasks(&[
            "likapcs-client.exe".to_string(),
            "explorer".to_string(),
            "not a name?".to_string(),
        ]);
        assert!(report.closed.is_empty());
        assert!(report.failed.is_empty());
        assert_eq!(report.skipped.len(), 3, "{report:?}");
    }
}
