// Quit from the tray. Dev servers started from the dashboard outlive it on purpose, so a restart doesn't take them down,
// but quitting the app is usually meant for good: if any are running, ask whether to stop them too. Then the server
// this app started is asked to shut down rather than killed with its process tree, which would take the dev servers
// with it even when they were meant to stay.

use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::{api, api_port, stop_server, Server};

/// Stopping a dev server that survived a restart means listing processes with PowerShell first, which can be slow.
const STOP_WAIT: Duration = Duration::from_secs(30);
/// How long the server gets to exit by itself before it's killed.
const EXIT_WAIT: Duration = Duration::from_secs(10);

static QUITTING: AtomicBool = AtomicBool::new(false);

/// One line per running dev server, for the question.
fn running_dev_servers(port: u16) -> Vec<String> {
    let list = api::get(port, "/api/dev").unwrap_or(Value::Null);
    list.as_array()
        .into_iter()
        .flatten()
        .filter(|s| s["status"].as_str() == Some("running"))
        .map(|s| {
            let command = s["command"].as_str().unwrap_or("dev server");
            match s["url"].as_str() {
                Some(url) => format!("• {command}  ({url})"),
                None => format!("• {command}"),
            }
        })
        .collect()
}

/// Whether to stop the dev servers too; None to not quit after all.
#[cfg(windows)]
fn ask(servers: &[String]) -> Option<bool> {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, kind: u32) -> i32;
    }
    const MB_YESNOCANCEL: u32 = 0x3;
    const MB_ICONQUESTION: u32 = 0x20;
    const MB_SETFOREGROUND: u32 = 0x1_0000;
    const MB_TOPMOST: u32 = 0x4_0000;
    const IDYES: i32 = 6;
    const IDNO: i32 = 7;

    let (count, them) = match servers.len() {
        1 => ("A dev server started from the dashboard is".to_string(), "it"),
        n => (format!("{n} dev servers started from the dashboard are"), "them"),
    };
    let text = format!(
        "{count} still running:\n\n{}\n\nStop {them} too? Choose No to leave {them} running; the dashboard picks {them} up \
         again the next time it starts.",
        servers.join("\n")
    );
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (text, caption) = (wide(&text), wide("Quit Mission Control"));
    let kind = MB_YESNOCANCEL | MB_ICONQUESTION | MB_SETFOREGROUND | MB_TOPMOST;
    match unsafe { MessageBoxW(0, text.as_ptr(), caption.as_ptr(), kind) } {
        IDYES => Some(true),
        IDNO => Some(false),
        _ => None,
    }
}

/// No native dialog elsewhere yet: leave them running, as a restart does.
#[cfg(not(windows))]
fn ask(_: &[String]) -> Option<bool> {
    Some(false)
}

/// Asks the server this app started to shut down, and waits for it; kills it if it won't.
fn shut_down(port: u16, mut child: Child, stop_dev_servers: bool) {
    if api::post(port, "/api/shutdown", &json!({ "stopDevServers": stop_dev_servers }), STOP_WAIT) {
        let deadline = Instant::now() + EXIT_WAIT;
        while Instant::now() < deadline {
            if !matches!(child.try_wait(), Ok(None)) {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    stop_server(child);
}

pub fn quit(app: &AppHandle) {
    // A second Quit while the question is up does nothing.
    if QUITTING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    // Off the event loop: the server calls and the question both block.
    thread::spawn(move || {
        let port = api_port();
        let servers = running_dev_servers(port);
        let stop_dev_servers = if servers.is_empty() {
            false
        } else {
            match ask(&servers) {
                Some(stop) => stop,
                None => {
                    QUITTING.store(false, Ordering::SeqCst);
                    return;
                }
            }
        };
        let owned = app.state::<Server>().0.lock().unwrap().take();
        match owned {
            Some(child) => shut_down(port, child, stop_dev_servers),
            // Someone else's server (say, `npm run dev` in a terminal) keeps running; only the dev servers go.
            None if stop_dev_servers => {
                api::post(port, "/api/dev/stop-all", &json!({}), STOP_WAIT);
            }
            None => {}
        }
        app.exit(0);
    });
}
