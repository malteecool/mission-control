// A global shortcut that shows or hides the window from anywhere. The shortcut is the `desktopHotkey` setting, so
// it's changed on the settings page; this follows the server's settings and re-registers when it changes, and tells
// the server whether that worked (another app may already own the combination).

use std::thread;
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

use crate::api;

const POLL: Duration = Duration::from_secs(2);
/// The server treats the app as gone after a minute without a report.
const REPORT_EVERY: Duration = Duration::from_secs(20);

/// Registers `accelerator` in place of whatever was registered. Returns the error to show, if any.
fn register(app: &AppHandle, accelerator: &str) -> Option<String> {
    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister_all();
    if accelerator.is_empty() {
        return None;
    }
    let shortcut: Shortcut = match accelerator.parse() {
        Ok(s) => s,
        Err(err) => return Some(format!("Couldn't read {accelerator}: {err}")),
    };
    match shortcuts.register(shortcut) {
        Ok(()) => None,
        // On Windows any failure here means another app holds the combination.
        Err(_) => Some(format!("Another app already uses {accelerator}. Pick a different shortcut.")),
    }
}

/// Follows the setting for the life of the app.
pub fn watch(app: AppHandle, port: u16) {
    thread::spawn(move || {
        let mut current: Option<String> = None;
        let mut error: Option<String> = None;
        let mut reported: Option<Instant> = None;
        loop {
            match api::get(port, "/api/settings") {
                Some(settings) => {
                    let wanted = settings["desktopHotkey"].as_str().unwrap_or("").to_string();
                    if current.as_deref() != Some(wanted.as_str()) {
                        error = register(&app, &wanted);
                        current = Some(wanted);
                        reported = None;
                    }
                    if reported.is_none_or(|at| at.elapsed() >= REPORT_EVERY) {
                        let hotkey = current.as_deref().filter(|h| !h.is_empty() && error.is_none());
                        let ok = api::put(port, "/api/desktop", &json!({ "hotkey": hotkey, "error": error }));
                        reported = ok.then(Instant::now);
                    }
                }
                // Server restarting: report again as soon as it's back.
                None => reported = None,
            }
            thread::sleep(POLL);
        }
    });
}
