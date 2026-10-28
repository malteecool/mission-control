// Desktop shell for the dashboard: one window onto the local server, plus a tray icon so the app (and the Claude
// sessions the server runs) keeps going after the window is closed. The page is the same one a browser gets, served
// by the Node API, so the web code needs no Tauri-specific paths and gets no access to Tauri's IPC.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod approvals;
mod hotkey;
mod quit;
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

/// The API server this app started, if it had to start one; stopped when the app quits (see quit.rs).
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

/// Stops the server and the Claude processes it started. Windows has no SIGTERM, so the whole tree goes at once,
/// dev servers included; interrupted task sessions can be resumed from their cards next time. Quit asks the server to
/// shut down instead (quit.rs), so this is for when it won't, or the app exits some other way.
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

/// Shown while our own server starts, so the window appears at once instead of after the wait.
const SPLASH: &str = include_str!("splash.html");

fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2);
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The splash page as a `data:` URL, since it loads before anything is serving. An error goes in the fragment, for
/// the page to show once it has loaded (a script run into it could arrive before it has).
fn splash_url(error: Option<&str>) -> tauri::Url {
    let mut url = format!("data:text/html;charset=utf-8,{}", percent_encode(SPLASH));
    if let Some(error) = error {
        url.push_str("#error=");
        url.push_str(&percent_encode(error));
    }
    url.parse().expect("splash URL")
}

/// The dashboard: the Vite dev server under `tauri dev`, the API server (which serves the built page) otherwise.
fn dashboard_url(app: &AppHandle, port: u16) -> tauri::Url {
    match &app.config().build.dev_url {
        Some(dev) if cfg!(debug_assertions) => dev.clone(),
        _ => format!("http://127.0.0.1:{port}/").parse().expect("dashboard URL"),
    }
}

const INIT_SCRIPT: &str = include_str!("init.js");

fn create_window(app: &AppHandle, url: tauri::Url) -> tauri::Result<tauri::WebviewWindow> {
    let win = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::External(url))
        .title("Mission Control")
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .background_color(Color(5, 7, 13, 255))
        // Tells the page the shell sends approval alerts itself (see approvals.rs), so it doesn't send them twice,
        // and hides the browser's own right-click menu (Back, Reload, Save as…) except where it helps.
        .initialization_script(INIT_SCRIPT)
        // Tauri's native file-drop handler swallows HTML5 drag events on Windows, which breaks dragging tasks between lanes.
        .disable_drag_drop_handler()
        .theme(Some(tauri::Theme::Dark))
        .build()?;
    titlebar::paint(&win, true);
    Ok(win)
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
            "quit" => quit::quit(app),
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
            // terminal) or start our own. Starting one takes a few seconds, so the window opens straight away on a
            // splash page and moves to the dashboard once the server answers.
            thread::spawn(move || {
                let port = api_port();
                let dashboard = dashboard_url(&handle, port);
                if cfg!(debug_assertions) || api_up(port) {
                    if let Err(err) = create_window(&handle, dashboard) {
                        eprintln!("Couldn't open the window: {err}");
                    }
                } else {
                    let win = create_window(&handle, splash_url(None));
                    if let Err(err) = &win {
                        eprintln!("Couldn't open the window: {err}");
                    }
                    let started = match start_server(port) {
                        Ok(child) => {
                            *handle.state::<Server>().0.lock().unwrap() = Some(child);
                            true
                        }
                        Err(err) => {
                            eprintln!("Couldn't start the dashboard server: {err}");
                            false
                        }
                    };
                    // Wait for it to answer, but give up early if it exits (a syntax error, a missing dependency).
                    let exited = || {
                        let state = handle.state::<Server>();
                        let mut server = state.0.lock().unwrap();
                        server.as_mut().is_none_or(|c| !matches!(c.try_wait(), Ok(None)))
                    };
                    let deadline = Instant::now() + Duration::from_secs(60);
                    while started && !api_up(port) && !exited() && Instant::now() < deadline {
                        thread::sleep(Duration::from_millis(200));
                    }
                    if let Ok(win) = win {
                        if api_up(port) {
                            let _ = win.navigate(dashboard);
                        } else {
                            let log = repo_root().join("server/data/desktop-server.log");
                            let message = if started {
                                format!("The dashboard server didn't start. See {}", log.display())
                            } else {
                                "Couldn't start the dashboard server. Is node on your PATH?".to_string()
                            };
                            let _ = win.navigate(splash_url(Some(&message)));
                        }
                    }
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
