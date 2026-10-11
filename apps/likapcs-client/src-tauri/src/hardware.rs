//! Hardware facts and live metrics reported to the server — what the Admin shows when staff click
//! a PC ("i5-12400F · RTX 3060 · 16 GB · 38 % CPU · 54 °C"). Everything here is best effort and
//! honest: a value the OS does not expose is `None`, never a guess.
//!
//! * `hardware_info` — static facts, gathered once: CPU model and cores, GPU names (Windows: WMI via
//!   a hidden PowerShell; elsewhere unavailable), RAM size, OS, system drive size.
//! * `hardware_metrics` — per heartbeat: CPU load (needs two samples; the first call after start
//!   reports what sysinfo has so far), RAM in use, free space on the system drive, hottest CPU /
//!   GPU sensor when the platform exposes one (consumer Windows installs usually do not — then it
//!   is simply absent).

use serde::Serialize;
use std::sync::Mutex;
use sysinfo::{Components, CpuRefreshKind, Disks, MemoryRefreshKind, RefreshKind, System};

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HardwareInfo {
    pub cpu: Option<String>,
    pub cpu_cores: Option<u32>,
    pub cpu_threads: Option<u32>,
    pub gpus: Vec<String>,
    pub ram_total_mb: Option<u64>,
    pub os: Option<String>,
    pub disk_total_mb: Option<u64>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HardwareMetrics {
    pub cpu_percent: Option<f32>,
    pub memory_used_mb: Option<u64>,
    pub memory_total_mb: Option<u64>,
    pub disk_free_mb: Option<u64>,
    pub cpu_temp_c: Option<f32>,
    pub gpu_temp_c: Option<f32>,
}

/// Long-lived sampler: CPU usage is a delta between two refreshes, so the `System` must persist.
pub struct HardwareState {
    system: Mutex<System>,
    components: Mutex<Components>,
    disks: Mutex<Disks>,
    info: Mutex<Option<HardwareInfo>>,
}

impl HardwareState {
    pub fn new() -> Self {
        let system = System::new_with_specifics(
            RefreshKind::nothing()
                .with_cpu(CpuRefreshKind::everything())
                .with_memory(MemoryRefreshKind::everything()),
        );
        Self {
            system: Mutex::new(system),
            components: Mutex::new(Components::new_with_refreshed_list()),
            disks: Mutex::new(Disks::new_with_refreshed_list()),
            info: Mutex::new(None),
        }
    }
}

const MB: u64 = 1024 * 1024;

fn clean(s: &str) -> Option<String> {
    let t = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        None
    } else {
        Some(t.chars().take(120).collect())
    }
}

/// The drive the OS lives on (C:\ on Windows, / elsewhere); falls back to the largest drive.
fn system_disk(disks: &Disks) -> Option<&sysinfo::Disk> {
    let root = if cfg!(windows) { "C:\\" } else { "/" };
    disks
        .iter()
        .find(|d| d.mount_point().to_string_lossy().eq_ignore_ascii_case(root))
        .or_else(|| disks.iter().max_by_key(|d| d.total_space()))
}

/// GPU names from WMI (Windows only). Runs once, hidden, with a short timeout.
#[cfg(windows)]
fn gpu_names() -> Vec<String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Duration;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let child = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join \"`n\"",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else { return Vec::new() };
    // Bounded wait: a stuck WMI must never stall the agent.
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(100))
            }
            _ => {
                let _ = child.kill();
                return Vec::new();
            }
        }
    }
    let Ok(out) = child.wait_with_output() else { return Vec::new() };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(clean)
        .filter(|n| !n.to_ascii_lowercase().contains("basic display"))
        .take(4)
        .collect()
}

#[cfg(not(windows))]
fn gpu_names() -> Vec<String> {
    Vec::new()
}

/// Static facts; computed once per process and cached.
pub fn info(state: &HardwareState) -> HardwareInfo {
    if let Some(cached) = state.info.lock().ok().and_then(|g| g.clone()) {
        return cached;
    }
    let (cpu, cpu_cores, cpu_threads, ram_total_mb) = {
        let mut sys = state.system.lock().unwrap_or_else(|e| e.into_inner());
        sys.refresh_memory();
        let cpu = sys.cpus().first().and_then(|c| clean(c.brand()));
        let threads = sys.cpus().len() as u32;
        let cores = sys.physical_core_count().map(|n| n as u32);
        let ram = sys.total_memory() / MB;
        (
            cpu,
            cores,
            if threads > 0 { Some(threads) } else { None },
            if ram > 0 { Some(ram) } else { None },
        )
    };
    let disk_total_mb = state
        .disks
        .lock()
        .ok()
        .and_then(|d| system_disk(&d).map(|d| d.total_space() / MB));
    let os = System::long_os_version()
        .or_else(System::name)
        .and_then(|s| clean(&s));
    let info = HardwareInfo {
        cpu,
        cpu_cores,
        cpu_threads,
        gpus: gpu_names(),
        ram_total_mb,
        os,
        disk_total_mb,
    };
    if let Ok(mut g) = state.info.lock() {
        *g = Some(info.clone());
    }
    info
}

/// One sample for the heartbeat.
pub fn metrics(state: &HardwareState) -> HardwareMetrics {
    let (cpu_percent, memory_used_mb, memory_total_mb) = {
        let mut sys = state.system.lock().unwrap_or_else(|e| e.into_inner());
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        let usage = sys.global_cpu_usage();
        let total = sys.total_memory() / MB;
        (
            if usage.is_finite() { Some(usage.clamp(0.0, 100.0)) } else { None },
            Some(sys.used_memory() / MB),
            if total > 0 { Some(total) } else { None },
        )
    };
    let disk_free_mb = state.disks.lock().ok().and_then(|mut d| {
        d.refresh(false);
        system_disk(&d).map(|d| d.available_space() / MB)
    });
    let (cpu_temp_c, gpu_temp_c) = state
        .components
        .lock()
        .map(|mut comps| {
            comps.refresh(false);
            let mut cpu: Option<f32> = None;
            let mut gpu: Option<f32> = None;
            for c in comps.iter() {
                let Some(t) = c.temperature() else { continue };
                if !t.is_finite() || t <= 0.0 || t > 150.0 {
                    continue;
                }
                let label = c.label().to_ascii_lowercase();
                let slot = if label.contains("gpu") || label.contains("radeon") || label.contains("nvidia") {
                    &mut gpu
                } else if label.contains("cpu")
                    || label.contains("core")
                    || label.contains("tctl")
                    || label.contains("tdie")
                    || label.contains("package")
                    || label.contains("k10temp")
                    || label.contains("coretemp")
                    || label.contains("acpi")
                {
                    &mut cpu
                } else {
                    continue;
                };
                *slot = Some(slot.map_or(t, |prev| prev.max(t)));
            }
            (cpu, gpu)
        })
        .unwrap_or((None, None));
    HardwareMetrics {
        cpu_percent,
        memory_used_mb,
        memory_total_mb,
        disk_free_mb,
        cpu_temp_c,
        gpu_temp_c,
    }
}
