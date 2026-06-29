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
    let server_dir = resource_dir.join("server");
    let node = server_dir.join("node");
    let entry = server_dir.join("server.cjs");

    match Command::new(&node)
        .arg(&entry)
        .current_dir(&server_dir)
        .spawn()
    {
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
    tauri::Builder::default()
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
