//! Tauri desktop shell entrypoint.
//!
//! Responsibilities:
//!   1. On startup, spawn the desktop-bridge as a child Bun process.
//!   2. Poll `/api/v1/health` until ready (or timeout).
//!   3. Reveal the main window once the bridge is healthy.
//!   4. Kill the bridge on app exit.
//!
//! The bridge is a *plain child process*, not a Tauri sidecar — that lets the
//! shell ship with whatever Bun is on PATH without per-platform precompiled
//! binaries. Production builds may swap to `bun build --compile` sidecars
//! later, but this layout keeps Phase-5 honest about scope.

mod bridge;

use std::sync::Arc;
use std::time::Duration;
use tauri::{Manager, RunEvent};
use tokio::sync::Mutex;

const BRIDGE_PORT: u16 = 8787;
const BRIDGE_HEALTH_TIMEOUT: Duration = Duration::from_secs(20);

type SharedBridge = Arc<Mutex<Option<bridge::BridgeProcess>>>;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shared: SharedBridge = Arc::new(Mutex::new(None));
    let shared_for_setup = shared.clone();
    let shared_for_exit = shared.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let shared = shared_for_setup.clone();

            // Spawn off-thread; setup() must return promptly so the runtime
            // can start servicing the WebView.
            tauri::async_runtime::spawn(async move {
                let install_dir = bridge::resolve_install_dir(&app_handle);
                let started = bridge::spawn_and_wait(&app_handle, install_dir, BRIDGE_PORT, BRIDGE_HEALTH_TIMEOUT).await;
                match started {
                    Ok(child) => {
                        {
                            let mut guard = shared.lock().await;
                            *guard = Some(child);
                        }
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    Err(err) => {
                        eprintln!("[desktop-shell] bridge failed to start: {err:#}");
                        // Surface the window anyway so the user sees the failure mode.
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.show();
                        }
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app_handle, event| {
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                // Synchronously block on bridge teardown — short-lived.
                let shared = shared_for_exit.clone();
                tauri::async_runtime::block_on(async move {
                    let mut guard = shared.lock().await;
                    if let Some(child) = guard.take() {
                        let _ = child.kill().await;
                    }
                });
            }
        });
}
