//! Live screen (remote view, phase 1): one JPEG frame of the primary screen, on request.
//!
//! The webview asks for a frame at the rate the server sets (`server.stream`); nothing here runs
//! on its own. Capture uses GDI BitBlt (works without a GPU and inside an RDP-free desktop
//! session). Read-only: there is no input path in this module.

use serde::Serialize;

#[derive(Serialize)]
pub struct ScreenFrame {
    pub width: u32,
    pub height: u32,
    /// JPEG bytes, base64 encoded (standard alphabet).
    pub jpeg: String,
}

/// Captures the primary screen as a JPEG no wider than `max_width` (aspect ratio kept).
/// `quality` is 1–100; 60 is a good default for a 960 px preview.
#[tauri::command]
pub fn capture_screen_frame(max_width: u32, quality: u8) -> Result<ScreenFrame, String> {
    let (screen_w, screen_h, bgra) = grab_screen()?;
    let target_w = max_width.clamp(64, screen_w.max(64)).min(screen_w);
    let target_h = ((screen_h as u64 * target_w as u64) / screen_w as u64).max(1) as u32;
    let rgb = bgra_to_rgb_scaled(&bgra, screen_w, screen_h, target_w, target_h);

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

/// Nearest-neighbour downscale from 32-bit BGRA (top-down rows) to packed RGB.
fn bgra_to_rgb_scaled(src: &[u8], sw: u32, sh: u32, tw: u32, th: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity((tw * th * 3) as usize);
    for y in 0..th {
        let sy = (y as u64 * sh as u64 / th as u64) as u32;
        for x in 0..tw {
            let sx = (x as u64 * sw as u64 / tw as u64) as u32;
            let i = ((sy * sw + sx) * 4) as usize;
            out.push(src[i + 2]); // R
            out.push(src[i + 1]); // G
            out.push(src[i]); // B
        }
    }
    out
}

#[cfg(windows)]
fn grab_screen() -> Result<(u32, u32, Vec<u8>), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

    let w = unsafe { GetSystemMetrics(SM_CXSCREEN) };
    let h = unsafe { GetSystemMetrics(SM_CYSCREEN) };
    if w <= 0 || h <= 0 {
        return Err("no primary screen".into());
    }
    let pixels = grab_gdi(w, h)?;
    Ok((w as u32, h as u32, pixels))
}

#[cfg(not(windows))]
fn grab_screen() -> Result<(u32, u32, Vec<u8>), String> {
    Err("live screen capture is only available on Windows".into())
}

#[cfg(windows)]
fn grab_gdi(w: i32, h: i32) -> Result<Vec<u8>, String> {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::ptr::null_mut;
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS, HGDIOBJ, SRCCOPY,
    };

    unsafe {
        let screen_dc = GetDC(null_mut());
        if screen_dc.is_null() {
            return Err("GetDC failed".into());
        }
        let mem_dc = CreateCompatibleDC(screen_dc);
        let bitmap = CreateCompatibleBitmap(screen_dc, w, h);
        let mut result: Result<Vec<u8>, String> = Err("BitBlt failed".into());

        if !mem_dc.is_null() && !bitmap.is_null() {
            let old = SelectObject(mem_dc, bitmap as HGDIOBJ);
            if BitBlt(mem_dc, 0, 0, w, h, screen_dc, 0, 0, SRCCOPY) != 0 {
                let mut bmi: BITMAPINFO = std::mem::zeroed();
                bmi.bmiHeader = BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h, // negative = top-down rows
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB,
                    biSizeImage: 0,
                    biXPelsPerMeter: 0,
                    biYPelsPerMeter: 0,
                    biClrUsed: 0,
                    biClrImportant: 0,
                };
                let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
                let lines = GetDIBits(
                    mem_dc,
                    bitmap,
                    0,
                    h as u32,
                    buf.as_mut_ptr() as *mut c_void,
                    &mut bmi,
                    DIB_RGB_COLORS,
                );
                if lines == h {
                    result = Ok(buf);
                } else {
                    result = Err("GetDIBits failed".into());
                }
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
