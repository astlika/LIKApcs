//! Hardware facts and live metrics reported to the server — what the Admin shows when staff click
//! a PC ("i5-12400F · RTX 3060 · 16 GB · 38 % CPU · 54 °C"). Everything here is best effort and
//! honest: a value the OS does not expose is `None`, never a guess.
//!
//! * `info` — static facts, gathered once: CPU model and cores, GPU names (Windows: WMI via a
//!   hidden PowerShell; elsewhere unavailable), RAM size, OS, system drive size.
//! * `metrics` — per heartbeat: CPU load (a delta between two samples), RAM in use, free space on
//!   the system drive, hottest CPU / GPU sensor when the platform exposes one (consumer Windows
//!   installs usually do not — then it is simply absent).
//!
//! # Threading — read before touching
//!
//! **Nothing in here may ever run on the UI thread.** On Windows, `sysinfo` reads temperatures
//! through WMI and for that initialises COM on the *calling thread* as multi-threaded (MTA). The
//! window system (tao / WebView2) needs the UI thread in the single-threaded apartment (STA): a
//! main thread that touched WMI first makes window creation fail with `RPC_E_CHANGED_MODE` and
//! the client dies before anything is on screen. That is exactly what 0.6.0 did by building the
//! sampler inside `Builder::manage(...)`.
//!
//! So all `sysinfo` state lives on two private worker threads that are spawned lazily, on the
//! first request, and never on the UI thread:
//!
//! * the **sampler** owns `System` + `Disks` (CPU %, RAM, disk) and answers requests over a
//!   bounded channel;
//! * the **thermal** thread owns `Components` (WMI). It only ever *updates a cache*; a request
//!   nudges it and reads whatever the last pass produced. A stuck WMI query therefore costs one
//!   stale temperature, never a late heartbeat.
//!
//! Callers wait with a timeout; when a worker is busy or gone the caller gets defaults (all
//! `None`) and the agent carries on.

use serde::Serialize;
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::Mutex;
use std::time::Duration;
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

/// How long a caller waits for the sampler. The heartbeat runs every 10 s; `info` is requested
/// once and may spawn PowerShell for the GPU names.
const INFO_TIMEOUT: Duration = Duration::from_secs(15);
const METRICS_TIMEOUT: Duration = Duration::from_secs(4);
/// Requests queued at the sampler before callers get defaults instead of waiting.
const QUEUE: usize = 4;

enum Request {
    Info(SyncSender<HardwareInfo>),
    Metrics(SyncSender<HardwareMetrics>),
}

/// Handle shared with the Tauri commands. Cheap to create: no `sysinfo` object exists until the
/// first request, and then only on the worker threads.
pub struct HardwareState {
    sampler: Mutex<Option<SyncSender<Request>>>,
}

impl HardwareState {
    pub fn new() -> Self {
        Self { sampler: Mutex::new(None) }
    }

    /// Static facts; computed once by the sampler and cached there.
    pub fn info(&self) -> HardwareInfo {
        let (reply_tx, reply_rx) = sync_channel(1);
        if !self.submit(Request::Info(reply_tx)) {
            return HardwareInfo::default();
        }
        reply_rx.recv_timeout(INFO_TIMEOUT).unwrap_or_default()
    }

    /// One sample for the heartbeat.
    pub fn metrics(&self) -> HardwareMetrics {
        let (reply_tx, reply_rx) = sync_channel(1);
        if !self.submit(Request::Metrics(reply_tx)) {
            return HardwareMetrics::default();
        }
        reply_rx.recv_timeout(METRICS_TIMEOUT).unwrap_or_default()
    }

    /// Hands a request to the sampler, starting it on first use. `false` when the sampler is
    /// gone or its queue is full (a slow pass is in progress) — the caller answers with defaults.
    fn submit(&self, request: Request) -> bool {
        let mut guard = match self.sampler.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if guard.is_none() {
            *guard = spawn_sampler();
        }
        let Some(tx) = guard.as_ref() else { return false };
        match tx.try_send(request) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) => false,
            Err(TrySendError::Disconnected(_)) => {
                // The worker died (it never should): forget it so the next call starts a new one.
                *guard = None;
                false
            }
        }
    }
}

fn spawn_sampler() -> Option<SyncSender<Request>> {
    let (tx, rx) = sync_channel::<Request>(QUEUE);
    std::thread::Builder::new()
        .name("likapcs-hw-sampler".into())
        .spawn(move || sampler_main(rx))
        .ok()?;
    Some(tx)
}

/// Owns the `sysinfo` objects for CPU / RAM / disk. Lives as long as the process.
fn sampler_main(rx: Receiver<Request>) {
    let mut sys = System::new_with_specifics(
        RefreshKind::nothing()
            .with_cpu(CpuRefreshKind::everything())
            .with_memory(MemoryRefreshKind::everything()),
    );
    let mut disks = Disks::new_with_refreshed_list();
    let thermal = Thermal::new();
    let mut info: Option<HardwareInfo> = None;
    while let Ok(request) = rx.recv() {
        match request {
            Request::Info(reply) => {
                let value = info
                    .get_or_insert_with(|| collect_info(&mut sys, &disks))
                    .clone();
                let _ = reply.try_send(value);
            }
            Request::Metrics(reply) => {
                let value = collect_metrics(&mut sys, &mut disks, &thermal);
                let _ = reply.try_send(value);
            }
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

fn collect_info(sys: &mut System, disks: &Disks) -> HardwareInfo {
    sys.refresh_memory();
    let cpu = sys.cpus().first().and_then(|c| clean(c.brand()));
    let threads = sys.cpus().len() as u32;
    let cpu_cores = sys.physical_core_count().map(|n| n as u32);
    let ram = sys.total_memory() / MB;
    let disk_total_mb = system_disk(disks).map(|d| d.total_space() / MB);
    let os = System::long_os_version()
        .or_else(System::name)
        .and_then(|s| clean(&s));
    HardwareInfo {
        cpu,
        cpu_cores,
        cpu_threads: if threads > 0 { Some(threads) } else { None },
        gpus: gpu_names(),
        ram_total_mb: if ram > 0 { Some(ram) } else { None },
        os,
        disk_total_mb,
    }
}

fn collect_metrics(sys: &mut System, disks: &mut Disks, thermal: &Thermal) -> HardwareMetrics {
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    let usage = sys.global_cpu_usage();
    let total = sys.total_memory() / MB;
    disks.refresh(false);
    let disk_free_mb = system_disk(disks).map(|d| d.available_space() / MB);
    let (cpu_temp_c, gpu_temp_c) = thermal.latest_and_nudge();
    HardwareMetrics {
        cpu_percent: if usage.is_finite() { Some(usage.clamp(0.0, 100.0)) } else { None },
        memory_used_mb: Some(sys.used_memory() / MB),
        memory_total_mb: if total > 0 { Some(total) } else { None },
        disk_free_mb,
        cpu_temp_c,
        gpu_temp_c,
    }
}

// ─── Temperatures (own thread: WMI on Windows) ──────────────────────────────────

type Temps = (Option<f32>, Option<f32>);

/// Cache in front of the thermal thread. `latest_and_nudge` never blocks on the sensors.
struct Thermal {
    latest: std::sync::Arc<Mutex<Temps>>,
    nudge: Option<SyncSender<()>>,
}

impl Thermal {
    fn new() -> Self {
        let latest = std::sync::Arc::new(Mutex::new((None, None)));
        let (tx, rx) = sync_channel::<()>(1);
        let cache = latest.clone();
        let spawned = std::thread::Builder::new()
            .name("likapcs-hw-thermal".into())
            .spawn(move || thermal_main(rx, cache))
            .is_ok();
        Self { latest, nudge: if spawned { Some(tx) } else { None } }
    }

    /// The last reading, and a request for a fresh one for the next heartbeat. The very first
    /// call therefore reports no temperature yet — honest, and one heartbeat later it is there
    /// (when the machine exposes any).
    fn latest_and_nudge(&self) -> Temps {
        if let Some(tx) = &self.nudge {
            let _ = tx.try_send(());
        }
        self.latest.lock().map(|t| *t).unwrap_or((None, None))
    }
}

fn thermal_main(rx: Receiver<()>, cache: std::sync::Arc<Mutex<Temps>>) {
    let mut components: Option<Components> = None;
    while rx.recv().is_ok() {
        let comps = components.get_or_insert_with(Components::new_with_refreshed_list);
        comps.refresh(false);
        let temps = pick_temps(comps);
        if let Ok(mut slot) = cache.lock() {
            *slot = temps;
        }
    }
}

/// Hottest CPU-ish and GPU-ish sensor by label; anything else is ignored.
fn pick_temps(comps: &Components) -> Temps {
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
            || label == "computer"
        {
            &mut cpu
        } else {
            continue;
        };
        *slot = Some(slot.map_or(t, |prev| prev.max(t)));
    }
    (cpu, gpu)
}
