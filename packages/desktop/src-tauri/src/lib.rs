mod rpc;

use rpc::EngineState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(EngineState::new())
        .invoke_handler(tauri::generate_handler![
            rpc::start_engine,
            rpc::send_rpc,
            rpc::stop_engine,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
