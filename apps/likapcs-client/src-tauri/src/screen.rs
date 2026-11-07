//! Live screen (remote view): one JPEG frame of the primary screen, on request.
//!
//! The webview asks for a frame at the rate and size the server sets (`server.stream`); nothing
//! here runs on its own. The picture is shrunk by GDI itself (`StretchBlt`, HALFTONE) straight
//! from the screen, so only the small picture is copied and encoded. Read-only.

use serde::Serialize;

#[derive(Serialize)]
pub struct ScreenFrame {
    pub width: u32,
    pub height: u32,
    /// JPEG bytes, base64 encoded (standard alphabet).
    pub jpeg: String,
}

/// Captures the primary screen as a JPEG that fits inside `max_width` × `max_height`, keeping the
/// screen's aspect ratio. The screen is never enlarged. `quality` is 1–100.
#[tauri::command]
pub fn capture_screen_frame(
    max_width: u32,
    max_height: u32,
    quality: u8,
) -> Result<ScreenFrame, String> {
    let (screen_w, screen_h) = screen_size()?;
    let (target_w, target_h) = fit(screen_w, screen_h, max_width, max_height);
    let bgra = grab_scaled(screen_w, screen_h, target_w, target_h)?;
    let rgb = bgra_to_rgb(&bgra);

    use base64::Engine as _;
    let mut out = Vec::new();
    jpeg_encoder::Encoder::new(&mut out, quality.clamp(1, 100))
        .encode(&rgb, target_w as u16, target_h as u16, jpeg_encoder::ColorType::Rgb)
        .map_err(|err| format!("jpeg encode failed: {err}"))?;

    Ok(ScreenFrame {
        width: target_w,
        height: target_h,
        jpeg: base64::engine::general_purpose::STANDARD.encode(&out),
    })
}

/// Largest size that fits the limits and never exceeds the screen.
fn fit(screen_w: u32, screen_h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    let max_w = max_w.clamp(64, 3840) as f64;
    let max_h = max_h.clamp(64, 2160) as f64;
    let scale = (max_w / screen_w as f64)
        .min(max_h / screen_h as f64)
        .min(1.0);
    let w = ((screen_w as f64 * scale).round() as u32).max(1);
    let h = ((screen_h as f64 * scale).round() as u32).max(1);
    (w, h)
}

/// 32-bit BGRA (top-down rows) to packed RGB, for the JPEG encoder.
fn bgra_to_rgb(src: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(src.len() / 4 * 3);
    for px in src.chunks_exact(4) {
        out.push(px[2]);
        out.push(px[1]);
        out.push(px[0]);
    }
    out
}

#[cfg(windows)]
fn screen_size() -> Result<(u32, u32), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
    let w = unsafe { GetSystemMetrics(SM_CXSCREEN) };
    let h = unsafe { GetSystemMetrics(SM_CYSCREEN) };
    if w <= 0 || h <= 0 {
        return Err("no primary screen".into());
    }
    Ok((w as u32, h as u32))
}

#[cfg(not(windows))]
fn screen_size() -> Result<(u32, u32), String> {
    Err("live screen capture is only available on Windows".into())
}

#[cfg(windows)]
fn grab_scaled(sw: u32, sh: u32, tw: u32, th: u32) -> Result<Vec<u8>, String> {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::ptr::null_mut;
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        ReleaseDC, SelectObject, SetBrushOrgEx, SetStretchBltMode, StretchBlt, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HALFTONE, HGDIOBJ, SRCCOPY,
    };

    let (sw, sh, tw, th) = (sw as i32, sh as i32, tw as i32, th as i32);
    unsafe {
        let screen_dc = GetDC(null_mut());
        if screen_dc.is_null() {
            return Err("GetDC failed".into());
        }
        let mem_dc = CreateCompatibleDC(screen_dc);
        let bitmap = CreateCompatibleBitmap(screen_dc, tw, th);
        let mut result: Result<Vec<u8>, String> = Err("StretchBlt failed".into());

        if !mem_dc.is_null() && !bitmap.is_null() {
            let old = SelectObject(mem_dc, bitmap as HGDIOBJ);
            // HALFTONE gives a smooth shrink; the brush origin must be reset after it.
            SetStretchBltMode(mem_dc, HALFTONE);
            SetBrushOrgEx(mem_dc, 0, 0, null_mut());
            if StretchBlt(mem_dc, 0, 0, tw, th, screen_dc, 0, 0, sw, sh, SRCCOPY) != 0 {
                let mut bmi: BITMAPINFO = std::mem::zeroed();
                bmi.bmiHeader = BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: tw,
                    biHeight: -th, // negative = top-down rows
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB,
                    biSizeImage: 0,
                    biXPelsPerMeter: 0,
                    biYPelsPerMeter: 0,
                    biClrUsed: 0,
                    biClrImportant: 0,
                };
                let mut buf = vec![0u8; (tw as usize) * (th as usize) * 4];
                let lines = GetDIBits(
                    mem_dc,
                    bitmap,
                    0,
                    th as u32,
                    buf.as_mut_ptr() as *mut c_void,
                    &mut bmi,
                    DIB_RGB_COLORS,
                );
                result = if lines == th {
                    Ok(buf)
                } else {
                    Err("GetDIBits failed".into())
                };
            }
            SelectObject(mem_dc, old);
        }

        if !bitmap.is_null() {
            DeleteObject(bitmap as HGDIOBJ);
        }
        if !mem_dc.is_null() {
            DeleteDC(mem_dc);
        }
        ReleaseDC(null_mut(), screen_dc);
        result
    }
}

#[cfg(not(windows))]
fn grab_scaled(_sw: u32, _sh: u32, _tw: u32, _th: u32) -> Result<Vec<u8>, String> {
    Err("live screen capture is only available on Windows".into())
}
