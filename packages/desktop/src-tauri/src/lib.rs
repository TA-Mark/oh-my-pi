mod rpc;

use rpc::EngineState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());

    // Updater + process (relaunch after install) are desktop-only; mobile has no
    // sideloaded-update path.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    builder
        .manage(EngineState::new())
        .invoke_handler(tauri::generate_handler![
            rpc::start_engine,
            rpc::send_rpc,
            rpc::stop_engine,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
