use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

/// Holds the bundled Node PTY/API server child so we can kill it on exit.
struct ServerProcess(Mutex<Option<Child>>);

/// In a packaged build there is no `npm run dev` to start the backend, so the
/// app launches the bundled Node server itself (PTY over ws://localhost:5174 +
/// the /api/* endpoints). In dev (`debug_assertions`) the concurrently-run dev
/// server already owns that port, so we don't spawn — we'd just collide.
fn start_server(app: &tauri::App) {
    let resource_dir = match app.path().resource_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[termany] no resource dir: {e}");
            return;
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
        Ok(child) => {
            app.manage(ServerProcess(Mutex::new(Some(child))));
        }
        Err(e) => eprintln!("[termany] failed to start server ({node:?}): {e}"),
    }
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());
    // Self-update: version check + install (desktop only; mobile stores handle it).
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }
    builder
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            } else {
                start_server(app);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                kill_server(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                kill_server(app);
            }
        });
}
