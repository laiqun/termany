use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};

#[cfg(target_os = "macos")]
mod macos_services {
    use std::cell::OnceCell;

    use objc2::rc::Retained;
    use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSApp, NSPasteboard, NSPasteboardItem, NSPasteboardTypeFileURL,
    };
    use objc2_foundation::{NSObject, NSObjectProtocol, NSString};
    use tauri::{AppHandle, Url};

    use super::emit_open_paths;

    #[derive(Debug, Default)]
    struct ServiceProviderIvars {
        app_handle: OnceCell<AppHandle>,
    }

    define_class!(
        // SAFETY: NSObject has no additional subclassing requirements here, and
        // this object is intentionally leaked for the app lifetime.
        #[unsafe(super = NSObject)]
        #[thread_kind = MainThreadOnly]
        #[ivars = ServiceProviderIvars]
        struct TermanyServiceProvider;

        unsafe impl NSObjectProtocol for TermanyServiceProvider {}

        impl TermanyServiceProvider {
            #[unsafe(method(openInTermany:userData:error:))]
            fn open_in_termany(
                &self,
                pasteboard: &NSPasteboard,
                _user_data: Option<&NSString>,
                _error: *mut *mut NSString,
            ) {
                let Some(app_handle) = self.ivars().app_handle.get() else {
                    return;
                };
                let paths = paths_from_pasteboard(pasteboard);
                emit_open_paths(app_handle, paths);
            }
        }
    );

    impl TermanyServiceProvider {
        fn new(app_handle: AppHandle, mtm: MainThreadMarker) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(ServiceProviderIvars::default());
            let this: Retained<Self> = unsafe { msg_send![super(this), init] };
            let _ = this.ivars().app_handle.set(app_handle);
            this
        }
    }

    fn paths_from_pasteboard(pasteboard: &NSPasteboard) -> Vec<String> {
        let mut paths = Vec::new();
        let Some(items) = pasteboard.pasteboardItems() else {
            return paths;
        };

        for i in 0..items.count() {
            let item: Retained<NSPasteboardItem> = items.objectAtIndex(i);
            if let Some(file_url) = item.stringForType(unsafe { NSPasteboardTypeFileURL }) {
                if let Ok(url) = Url::parse(&file_url.to_string()) {
                    if let Ok(path) = url.to_file_path() {
                        paths.push(path.to_string_lossy().into_owned());
                    }
                }
            }
        }

        paths
    }

    pub fn install(app_handle: AppHandle) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let provider = TermanyServiceProvider::new(app_handle, mtm);
        let app = NSApp(mtm);
        unsafe { app.setServicesProvider(Some(provider.as_ref())) };
        let _: *const TermanyServiceProvider = Retained::into_raw(provider);
    }
}

/// Holds the bundled Node PTY/API server child so we can kill it on exit.
struct ServerProcess(Mutex<Option<Child>>);

/// Counts unexpected server exits (crash, lost the port race) so the restart
/// loop below can give up instead of spinning forever if the binary is broken.
struct ServerRestartAttempts(AtomicU32);
const MAX_AUTO_RESTARTS: u32 = 3;
const SERVER_PORT: u16 = 5174;

/// Set once the user confirms the quit-confirm dialog, so the `ExitRequested`
/// handler below can tell that apart from the original OS/menu request that
/// triggered it — `AppHandle::exit()` itself raises another `ExitRequested`,
/// and without this flag that second one gets intercepted just like the
/// first, so confirming Quit silently reopens the same dialog forever.
struct QuitState(AtomicBool);

#[tauri::command]
fn confirm_quit(app: tauri::AppHandle, quitting: tauri::State<'_, QuitState>) {
    quitting.0.store(true, Ordering::SeqCst);
    app.exit(0);
}

struct OpenPathState(Mutex<OpenPathStateInner>);

struct OpenPathStateInner {
    pending: Vec<String>,
    frontend_ready: bool,
}

#[tauri::command]
fn frontend_ready_for_open_paths(state: tauri::State<'_, OpenPathState>) -> Vec<String> {
    match state.0.lock() {
        Ok(mut guard) => {
            guard.frontend_ready = true;
            std::mem::take(&mut guard.pending)
        }
        Err(_) => Vec::new(),
    }
}

/// In a packaged build there is no `npm run dev` to start the backend, so the
/// app launches the bundled Node server itself (PTY over ws://localhost:5174 +
/// the /api/* endpoints). In dev (`debug_assertions`) the concurrently-run dev
/// server already owns that port, so we don't spawn — we'd just collide.
fn existing_server_responds() -> bool {
    let Ok(mut addrs) = ("127.0.0.1", SERVER_PORT).to_socket_addrs() else {
        return false;
    };
    let Some(addr) = addrs.next() else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(250)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(b"GET /api/state HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buf = [0u8; 64];
    matches!(stream.read(&mut buf), Ok(n) if std::str::from_utf8(&buf[..n]).is_ok_and(|s| s.starts_with("HTTP/1.1 200") || s.starts_with("HTTP/1.0 200")))
}

fn server_port_is_open() -> bool {
    let Ok(mut addrs) = ("127.0.0.1", SERVER_PORT).to_socket_addrs() else {
        return false;
    };
    let Some(addr) = addrs.next() else {
        return false;
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

#[cfg(unix)]
fn listening_pids_on_server_port() -> Vec<String> {
    let Ok(output) = Command::new("lsof")
        .args([
            "-nP",
            "-a",
            "-iTCP:5174",
            "-sTCP:LISTEN",
            "-Fp",
        ])
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.strip_prefix('p'))
        .filter(|pid| pid.chars().all(|c| c.is_ascii_digit()))
        .map(ToOwned::to_owned)
        .collect()
}

#[cfg(unix)]
fn command_for_pid(pid: &str) -> Option<String> {
    let output = Command::new("ps")
        .args(["-p", pid, "-o", "command="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn is_termany_server_command(command: &str) -> bool {
    command.contains("server.cjs")
        && (command.contains("/Termany.app/")
            || command.contains("/termany/")
            || command.contains("\\Termany\\")
            || command.contains("\\termany\\"))
}

#[cfg(unix)]
fn kill_unresponsive_termany_server() {
    if !server_port_is_open() {
        return;
    }

    for pid in listening_pids_on_server_port() {
        let Some(command) = command_for_pid(&pid) else {
            continue;
        };
        if !is_termany_server_command(&command) {
            eprintln!("[termany] localhost:{SERVER_PORT} is occupied by a non-Termany process: {command}");
            continue;
        }
        eprintln!("[termany] killing unresponsive PTY server pid {pid}: {command}");
        let _ = Command::new("kill").arg(&pid).status();
    }

    for _ in 0..20 {
        if !server_port_is_open() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(not(unix))]
fn kill_unresponsive_termany_server() {}

fn spawn_server_child(app: &tauri::AppHandle) -> Option<Child> {
    if existing_server_responds() {
        eprintln!("[termany] reusing existing PTY server on localhost:{SERVER_PORT}");
        return None;
    }
    kill_unresponsive_termany_server();

    let resource_dir = match app.path().resource_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[termany] no resource dir: {e}");
            return None;
        }
    };
    // The bundled Node runtime is `node` on unix, `node.exe` on Windows.
    let node_bin = if cfg!(windows) { "node.exe" } else { "node" };
    // Tauri's resource glob (`resources/server/**/*`) preserves the leading
    // `resources/` segment, so the bundle lands at <Resources>/resources/server.
    // Fall back to <Resources>/server in case the mapping ever changes.
    let bundled = resource_dir.join("resources").join("server");
    let server_dir = if bundled.join(node_bin).exists() {
        bundled
    } else {
        resource_dir.join("server")
    };
    let node = server_dir.join(node_bin);
    let entry = server_dir.join("server.cjs");

    let mut command = Command::new(&node);
    command.arg(&entry).current_dir(&server_dir);
    // On Windows, spawning a console subprocess flashes a black cmd window;
    // CREATE_NO_WINDOW (0x0800_0000) keeps the bundled server headless.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }

    match command.spawn() {
        Ok(child) => Some(child),
        Err(e) => {
            eprintln!("[termany] failed to start server ({node:?}): {e}");
            None
        }
    }
}

/// Spawns the bundled server and stores it in the already-managed
/// `ServerProcess` state, then starts a watchdog thread that auto-restarts it
/// if it exits on its own (e.g. it lost the port race against a not-yet-dead
/// previous instance and gave up — see apps/server's own listen retry/backoff).
/// A deliberate stop (`kill_server`) empties the state *before* killing, so the
/// watchdog sees `None` and treats it as intentional rather than a crash.
fn start_server(app: &tauri::AppHandle) {
    let Some(child) = spawn_server_child(app) else {
        return;
    };
    if let Some(state) = app.try_state::<ServerProcess>() {
        *state.0.lock().unwrap() = Some(child);
    } else {
        app.manage(ServerProcess(Mutex::new(Some(child))));
    }

    let watched = app.clone();
    std::thread::spawn(move || monitor_server(watched));
}

fn monitor_server(app: tauri::AppHandle) {
    loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let Some(state) = app.try_state::<ServerProcess>() else {
            return;
        };
        let mut guard = state.0.lock().unwrap();
        match guard.as_mut() {
            None => return, // stopped intentionally elsewhere (kill_server)
            Some(child) => match child.try_wait() {
                Ok(Some(_)) => *guard = None, // exited on its own — fall through to restart
                _ => continue,                // still running (or a transient wait() error)
            },
        }
        drop(guard);
        break;
    }

    let attempts = app
        .try_state::<ServerRestartAttempts>()
        .map(|s| s.0.fetch_add(1, Ordering::SeqCst) + 1)
        .unwrap_or(u32::MAX);
    if attempts > MAX_AUTO_RESTARTS {
        eprintln!("[termany] bundled server exited unexpectedly {attempts} times — giving up on auto-restart");
        return;
    }
    eprintln!("[termany] bundled server exited unexpectedly — restarting (attempt {attempts}/{MAX_AUTO_RESTARTS})");
    start_server(&app);
}

fn kill_server(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<ServerProcess>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
            }
        }
    }
}

/// Explicitly stop the bundled server. Ordinary window/app close leaves it
/// running (see `run` below) so terminal sessions survive quitting and
/// reopening the app — but a self-update swaps the server binary underneath
/// it, so the frontend calls this right before `relaunch()` to make sure the
/// next launch starts a server that matches the new build instead of talking
/// to a stale one. No-op in dev (no bundled server, no managed state).
#[tauri::command]
fn stop_server(app: tauri::AppHandle) {
    kill_server(&app);
}

#[tauri::command]
fn webview_history(app: tauri::AppHandle, label: String, direction: String) -> Result<(), String> {
    if !label.starts_with("web_") {
        return Err("invalid webview label".into());
    }
    let script = match direction.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        _ => return Err("invalid history direction".into()),
    };
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "webview not found".to_string())?;
    webview.eval(script).map_err(|e| e.to_string())
}

fn focus_main_window(app_handle: &tauri::AppHandle) {
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn emit_open_paths(app_handle: &tauri::AppHandle, paths: Vec<String>) {
    focus_main_window(app_handle);
    if paths.is_empty() {
        return;
    }

    let mut frontend_ready = true;
    if let Some(state) = app_handle.try_state::<OpenPathState>() {
        if let Ok(mut guard) = state.0.lock() {
            frontend_ready = guard.frontend_ready;
            if !guard.frontend_ready {
                guard.pending.extend(paths.iter().cloned());
            }
        }
    }

    if frontend_ready {
        let _ = app_handle.emit_to("main", "open-paths", paths);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    // Must be the first plugin registered: a second launch attempt (double
    // Dock click, "reopen windows" after a reboot, etc.) is redirected here
    // instead of spawning a second app + a second bundled server that would
    // just fight the first one for port 5174.
    //
    // Debug builds share the same bundle identifier (tauri.conf.json) as the
    // installed release app, and this plugin locks by identifier alone — with
    // it active in dev, `tauri dev` would detect the already-running installed
    // Termany.app as "another instance" and exit immediately instead of
    // opening a dev window. Only guard release builds, where this is needed.
    #[cfg(desktop)]
    if !cfg!(debug_assertions) {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let paths: Vec<String> = argv
                .into_iter()
                .skip(1)
                .filter(|a| std::path::Path::new(a).exists())
                .collect();
            emit_open_paths(app, paths);
        }));
    }
    builder = builder
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            stop_server,
            frontend_ready_for_open_paths,
            webview_history,
            confirm_quit
        ]);
    // Self-update: version check + install (desktop only; mobile stores handle it).
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }
    builder
        .setup(|app| {
            app.manage(OpenPathState(Mutex::new(OpenPathStateInner {
                pending: Vec::new(),
                frontend_ready: false,
            })));
            app.manage(QuitState(AtomicBool::new(false)));
            #[cfg(target_os = "macos")]
            macos_services::install(app.handle().clone());

            // Tauri auto-creates a default macOS menu bar when none is set,
            // and three of its predefined items actively fight this app:
            //   - "Quit" calls exit() directly, bypassing RunEvent::ExitRequested
            //     entirely (tauri-apps/tauri#3124), so the quit-confirm dialog
            //     wired up below never gets a chance to run.
            //   - "Close Window" binds ⌘W at the OS menu layer, intercepting the
            //     keystroke before it ever reaches the webview — silently eating
            //     the app's own ⌘W "close pane" shortcut.
            //   - "Minimize" binds ⌘M the same way, eating the app's own ⌘M
            //     "maximize/restore pane" shortcut.
            // Replacing it with our own menu fixes all three: a custom Quit item
            // routes through the same "quit-requested" event as Dock → Quit,
            // Window has no Close item so ⌘W falls through as a normal keydown,
            // and Minimize is rebuilt without a keyEquivalent (still works from
            // the menu, click-only) so ⌘M falls through the same way.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

                let quit = MenuItemBuilder::new("Quit Termany")
                    .id("quit")
                    .accelerator("CmdOrCtrl+Q")
                    .build(app)?;
                let app_menu = SubmenuBuilder::new(app, "Termany")
                    .about(None)
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .item(&quit)
                    .build()?;
                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                let minimize = MenuItemBuilder::new("Minimize").id("minimize").build(app)?;
                let window_menu = SubmenuBuilder::new(app, "Window").item(&minimize).build()?;
                let menu = MenuBuilder::new(app)
                    .items(&[&app_menu, &edit_menu, &window_menu])
                    .build()?;
                app.set_menu(menu)?;
                app.on_menu_event(|app_handle, event| {
                    if event.id() == "quit" {
                        let _ = app_handle.emit_to("main", "quit-requested", ());
                    } else if event.id() == "minimize" {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.minimize();
                        }
                    }
                });
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            } else {
                app.manage(ServerRestartAttempts(AtomicU32::new(0)));
                start_server(app.handle());
            }

            Ok(())
        })
        // No window/app-exit server kill here on purpose: the bundled server
        // (and the shells it holds) is meant to keep running across an
        // ordinary quit + relaunch, so terminal sessions resume instead of
        // being lost. It only ever stops via `stop_server` (self-update) or by
        // the user killing the process directly.
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match event {
                // Always intercept the OS quit request (⌘Q, Dock → Quit, closing
                // the last window) and hand the decision to the frontend instead
                // of exiting immediately — guards against an accidental ⌘Q. The
                // frontend calls `confirm_quit` once the user confirms, which
                // sets `QuitState` before calling `AppHandle::exit()` — that
                // itself raises another `ExitRequested`, so this check is what
                // lets that second one through instead of re-prompting forever.
                tauri::RunEvent::ExitRequested { api, .. } => {
                    let quitting = app_handle.state::<QuitState>();
                    if !quitting.0.load(Ordering::SeqCst) {
                        api.prevent_exit();
                        let _ = app_handle.emit_to("main", "quit-requested", ());
                    }
                }
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Opened { urls } => {
                    let paths = urls
                        .into_iter()
                        .filter_map(|url| url.to_file_path().ok())
                        .map(|path| path.to_string_lossy().into_owned())
                        .collect::<Vec<_>>();
                    emit_open_paths(app_handle, paths);
                }
                _ => {}
            }
        });
}
