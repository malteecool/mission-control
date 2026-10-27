// Alerts when Claude is waiting on you while the window is in the tray, minimised or behind other windows. The page's
// own popups and browser notifications can't do this: a hidden webview gets throttled, and the page has no Tauri IPC
// for native notifications. So the shell watches the server's runs itself, the same list the page polls.

use std::collections::HashSet;
use std::thread;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Manager, UserAttentionType};
use tauri_plugin_notification::NotificationExt;

use crate::{api, in_front, WINDOW};

const POLL: Duration = Duration::from_secs(2);

struct Request {
    id: String,
    question: bool,
    title: String,
}

/// Approvals and questions waiting on queued or running runs.
fn pending(runs: &Value) -> Vec<Request> {
    let active = |r: &&Value| matches!(r["status"].as_str(), Some("queued" | "running"));
    runs.as_array()
        .into_iter()
        .flatten()
        .filter(active)
        .flat_map(|run| {
            let title = run["title"].as_str().unwrap_or("Claude").to_string();
            run["permissions"].as_array().into_iter().flatten().filter_map(move |p| {
                Some(Request {
                    id: p["requestId"].as_str()?.to_string(),
                    question: p["toolName"].as_str() == Some("AskUserQuestion"),
                    title: title.clone(),
                })
            })
        })
        .collect()
}

fn alert(app: &AppHandle, new: &[&Request]) {
    let (title, body) = match new {
        [one] => (
            if one.question { "Claude has a question" } else { "Claude needs your approval" }.to_string(),
            one.title.clone(),
        ),
        many => (
            format!("Claude is waiting on {} requests", many.len()),
            many.iter().map(|r| r.title.as_str()).collect::<Vec<_>>().join("\n"),
        ),
    };
    let _ = app.notification().builder().title(title).body(body).show();
    // A minimised or background window can flash its taskbar button too; a hidden one has none.
    if let Some(win) = app.get_webview_window(WINDOW) {
        if win.is_visible().unwrap_or(false) {
            let _ = win.request_user_attention(Some(UserAttentionType::Critical));
        }
    }
}

fn set_tray_count(app: &AppHandle, waiting: usize) {
    if let Some(tray) = app.tray_by_id("main") {
        let tip = match waiting {
            0 => "Mission Control".to_string(),
            1 => "Mission Control · 1 request waiting".to_string(),
            n => format!("Mission Control · {n} requests waiting"),
        };
        let _ = tray.set_tooltip(Some(tip));
    }
}

/// Polls the server for the life of the app.
pub fn watch(app: AppHandle, port: u16) {
    thread::spawn(move || {
        // Requests already waiting at startup alert too: the window isn't up yet, so nothing else shows them.
        let mut seen: HashSet<String> = HashSet::new();
        let mut last_count = usize::MAX;
        loop {
            if let Some(runs) = api::get(port, "/api/runs") {
                let requests = pending(&runs);
                let new: Vec<&Request> = requests.iter().filter(|r| !seen.contains(&r.id)).collect();
                if !new.is_empty() && !in_front(&app) {
                    alert(&app, &new);
                }
                // Forget answered ones so the set doesn't grow forever.
                seen = requests.iter().map(|r| r.id.clone()).collect();
                if requests.len() != last_count {
                    last_count = requests.len();
                    set_tray_count(&app, last_count);
                }
            }
            thread::sleep(POLL);
        }
    });
}
