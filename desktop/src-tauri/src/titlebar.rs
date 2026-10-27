// Paints the native Windows title bar in the dashboard's colours (web/src/index.css): the void background, a neon
// title and a thin neon border while the window is active, dimmed when it isn't. The buttons and Snap Layouts stay
// native. Windows 11 only; earlier versions ignore the attributes and keep their default bar.

use tauri::WebviewWindow;

/// `#rrggbb` as a Windows COLORREF (0x00bbggrr).
const fn colorref(rgb: u32) -> u32 {
    ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff)
}

const VOID: u32 = colorref(0x05070d);
const NEON: u32 = colorref(0x22d3ee);
const NEON_DIM: u32 = colorref(0x0e7490);
const SLATE: u32 = colorref(0x64748b);
const EDGE: u32 = colorref(0x1e293b);

#[cfg(windows)]
mod dwm {
    use std::ffi::c_void;

    pub const USE_IMMERSIVE_DARK_MODE: u32 = 20;
    pub const BORDER_COLOR: u32 = 34;
    pub const CAPTION_COLOR: u32 = 35;
    pub const TEXT_COLOR: u32 = 36;

    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(hwnd: isize, attribute: u32, value: *const c_void, size: u32) -> i32;
    }

    pub fn set(hwnd: isize, attribute: u32, value: u32) {
        unsafe { DwmSetWindowAttribute(hwnd, attribute, &value as *const u32 as *const c_void, 4) };
    }
}

/// Applies the colours for an active (focused) or inactive window.
pub fn paint(win: &WebviewWindow, active: bool) {
    #[cfg(windows)]
    if let Ok(hwnd) = win.hwnd() {
        let hwnd = hwnd.0 as isize;
        dwm::set(hwnd, dwm::USE_IMMERSIVE_DARK_MODE, 1);
        dwm::set(hwnd, dwm::CAPTION_COLOR, VOID);
        dwm::set(hwnd, dwm::TEXT_COLOR, if active { NEON } else { SLATE });
        dwm::set(hwnd, dwm::BORDER_COLOR, if active { NEON_DIM } else { EDGE });
    }
    #[cfg(not(windows))]
    let _ = (win, active);
}
