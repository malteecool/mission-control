// Desktop shell for the dashboard: one window onto the local server, plus a tray icon so the app (and the Claude
// sessions the server runs) keeps going after the window is closed. The page is the same one a browser gets, served
// by the Node API, so the web code needs no Tauri-specific paths and gets no access to Tauri's IPC.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod approvals;
mod hotkey;
mod titlebar;

use std::fs::{self, File};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::Color;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::ShortcutState;

const WINDOW: &str = "main";

/// The API server this app started, if it had to start one; stopped when the app quits.
struct Server(Mutex<Option<Child>>);

fn api_port() -> u16 {
    std::env::var("DASHBOARD_API_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(4317)
}

/// Whether the dashboard API answers. A bare TCP connect isn't enough: on Windows `connect_timeout` can report
/// success against a port nobody listens on yet, which opened the window onto a connection-refused page.
fn api_up(port: u16) -> bool {
    api::get(port, "/api/settings").is_some()
}

/// The repo the app was built from. `DASHBOARD_ROOT` overrides it, e.g. after moving the checkout.
fn repo_root() -> PathBuf {
    std::env::var_os("DASHBOARD_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
}

/// Starts the API the same way `npm start` does, logging to `server/data/desktop-server.log`.
fn start_server(port: u16) -> std::io::Result<Child> {
    let server_dir = repo_root().join("server");
    let data_dir = server_dir.join("data");
    fs::create_dir_all(&data_dir)?;
    let log = File::create(data_dir.join("desktop-server.log"))?;
    let mut cmd = Command::new("node");
    cmd.args(["--disable-warning=ExperimentalWarning", "--import", "tsx", "src/index.ts"])
        .current_dir(&server_dir)
        .env("DASHBOARD_API_PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
}

/// Stops the server and the Claude processes it started. Windows has no SIGTERM, so the whole tree goes at once;
/// interrupted task sessions can be resumed from their cards next time.
fn stop_server(mut child: Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn show_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(WINDOW) {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Whether the window is open and in front of everything else.
pub fn in_front(app: &AppHandle) -> bool {
    app.get_webview_window(WINDOW).is_some_and(|w| {
        w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) && w.is_focused().unwrap_or(false)
    })
}

fn toggle_window(app: &AppHandle) {
    match app.get_webview_window(WINDOW) {
        Some(win) if win.is_visible().unwrap_or(false) && !win.is_minimized().unwrap_or(false) => {
            let _ = win.hide();
        }
        _ => show_window(app),
    }
}

fn create_window(app: &AppHandle) -> tauri::Result<()> {
    // `App` URLs resolve to the Vite dev server under `tauri dev` and to the API server (frontendDist) otherwise.
    let win = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("/".into()))
        .title("Mission Control")
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .background_color(Color(5, 7, 13, 255))
        // Tells the page the shell sends approval alerts itself (see approvals.rs), so it doesn't send them twice.
        .initialization_script("window.__MISSION_CONTROL_DESKTOP__ = true;")
        // Tauri's native file-drop handler swallows HTML5 drag events on Windows, which breaks dragging tasks between lanes.
        .disable_drag_drop_handler()
        .theme(Some(tauri::Theme::Dark))
        .build()?;
    titlebar::paint(&win, true);
    Ok(())
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Mission Control", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Mission Control")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        // A second launch just brings the running window forward.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show_window(app)))
        .plugin(tauri_plugin_notification::init())
        // The global shortcut (see hotkey.rs) hides the window when it's in front and brings it forward otherwise.
        // The tray click can't use the same test: clicking the tray takes focus from the window first.
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _, event| {
                    if event.state() == ShortcutState::Pressed {
                        match app.get_webview_window(WINDOW) {
                            Some(win) if in_front(app) => {
                                let _ = win.hide();
                            }
                            _ => show_window(app),
                        }
                    }
                })
                .build(),
        )
        .manage(Server(Mutex::new(None)))
        .setup(|app| {
            setup_tray(app.handle())?;
            let handle = app.handle().clone();
            // Under `tauri dev`, `npm run dev` already runs the API. Otherwise reuse one that's running (say, from a
            // terminal) or start our own, and open the window once it answers.
            thread::spawn(move || {
                let port = api_port();
                if !cfg!(debug_assertions) && !api_up(port) {
                    match start_server(port) {
                        Ok(child) => *handle.state::<Server>().0.lock().unwrap() = Some(child),
                        Err(err) => eprintln!("Couldn't start the dashboard server: {err}"),
                    }
                    let deadline = Instant::now() + Duration::from_secs(30);
                    while !api_up(port) && Instant::now() < deadline {
                        thread::sleep(Duration::from_millis(200));
                    }
                }
                if let Err(err) = create_window(&handle) {
                    eprintln!("Couldn't open the window: {err}");
                }
                hotkey::watch(handle.clone(), port);
                approvals::watch(handle, port);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                // Closing the window keeps the app in the tray; Quit in the tray menu exits.
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                // The title text and border light up while the window is active, like the app's focus rings.
                WindowEvent::Focused(active) => {
                    if let Some(win) = window.app_handle().get_webview_window(WINDOW) {
                        titlebar::paint(&win, *active);
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the app");

    app.run(|app, event| match event {
        // No windows open (the main one is created late) mustn't end the app; only Quit does.
        RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
        RunEvent::Exit => {
            if let Some(child) = app.state::<Server>().0.lock().unwrap().take() {
                stop_server(child);
            }
        }
        _ => {}
    });
}
