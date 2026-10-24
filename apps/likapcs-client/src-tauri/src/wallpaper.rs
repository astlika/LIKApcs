//! 0.23.0: this PC's Windows desktop wallpaper, set from the Admin (one PC, a group, or all).
//!
//! The picture arrives as base64 bytes and is written to `%LOCALAPPDATA%\LIKApcs-Client\wallpaper`.
//! The wallpaper the PC had before the first change is kept in `original.txt` and put back when
//! the Admin clears the desktop wallpaper. Only Windows changes the desktop; other builds (used in
//! development) accept the calls and do nothing.

use std::fs;
use std::path::{Path, PathBuf};

const MARKER: &str = "original.txt";
const PREFIX: &str = "desktop-";
const MAX_BYTES: usize = 20 * 1024 * 1024;

fn data_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("LIKApcs-Client").join("wallpaper")
}

/// Writes the picture and sets it as the desktop wallpaper. `ext` is `png` or `jpg`.
pub fn set_desktop(bytes: &[u8], ext: &str) -> Result<(), String> {
    if ext != "png" && ext != "jpg" {
        return Err(format!("unsupported wallpaper type: {ext}"));
    }
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err("the wallpaper picture is empty or too large".into());
    }
    let dir = data_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    remember_original(&dir)?;
    // A new file name each time: Windows reads the wallpaper by path, so an overwritten file
    // could be shown from its old copy.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("{PREFIX}{stamp}.{ext}"));
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    platform::set_path(&path)?;
    remove_pictures(&dir, Some(&path));
    Ok(())
}

/// Puts back the wallpaper the PC had before the Admin changed it. Nothing to do if it never did.
pub fn restore() -> Result<(), String> {
    let dir = data_dir();
    let marker = dir.join(MARKER);
    if !marker.exists() {
        return Ok(());
    }
    let original = fs::read_to_string(&marker).map_err(|e| e.to_string())?;
    // An empty original means the PC had no wallpaper; setting "" clears it again.
    platform::set_path_str(original.trim_end_matches('\0'))?;
    fs::remove_file(&marker).map_err(|e| e.to_string())?;
    remove_pictures(&dir, None);
    Ok(())
}

/// Keeps the wallpaper the PC had first, so a later clear can restore it.
fn remember_original(dir: &Path) -> Result<(), String> {
    let marker = dir.join(MARKER);
    if marker.exists() {
        return Ok(());
    }
    // Unknown current wallpaper: keep none marker, so a later restore leaves the desktop alone.
    let Ok(current) = platform::current_path() else {
        return Ok(());
    };
    fs::write(&marker, current).map_err(|e| e.to_string())
}

/// Deletes the pictures this module wrote, except `keep`.
fn remove_pictures(dir: &Path, keep: Option<&Path>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let ours = path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with(PREFIX));
        if ours && Some(path.as_path()) != keep {
            let _ = fs::remove_file(&path);
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::ffi::{c_void, OsStr};
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SystemParametersInfoW, SPIF_SENDCHANGE, SPIF_UPDATEINIFILE, SPI_GETDESKWALLPAPER,
        SPI_SETDESKWALLPAPER,
    };

    /// MAX_PATH: the longest path SPI_GETDESKWALLPAPER writes.
    const MAX_PATH_CHARS: usize = 260;

    pub fn current_path() -> Result<String, String> {
        let mut buf = [0u16; MAX_PATH_CHARS];
        // SAFETY: the buffer is MAX_PATH wide characters, the size the call is told.
        let ok = unsafe {
            SystemParametersInfoW(
                SPI_GETDESKWALLPAPER,
                buf.len() as u32,
                buf.as_mut_ptr() as *mut c_void,
                0,
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Ok(String::from_utf16_lossy(&buf[..len]))
    }

    pub fn set_path(path: &Path) -> Result<(), String> {
        let text = path
            .to_str()
            .ok_or_else(|| "the wallpaper path is not valid text".to_string())?;
        set_path_str(text)
    }

    pub fn set_path_str(text: &str) -> Result<(), String> {
        let mut wide: Vec<u16> = OsStr::new(text)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: `wide` is a NUL-terminated UTF-16 string that lives for the whole call.
        let ok = unsafe {
            SystemParametersInfoW(
                SPI_SETDESKWALLPAPER,
                0,
                wide.as_mut_ptr() as *mut c_void,
                SPIF_UPDATEINIFILE | SPIF_SENDCHANGE,
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod platform {
    use std::path::Path;

    pub fn current_path() -> Result<String, String> {
        Ok(String::new())
    }

    pub fn set_path(_path: &Path) -> Result<(), String> {
        Ok(())
    }

    pub fn set_path_str(_text: &str) -> Result<(), String> {
        Ok(())
    }
}
