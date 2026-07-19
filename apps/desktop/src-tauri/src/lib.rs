mod oauth;
mod shell;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _cwd| {
                shell::show_main_window(app);
            },
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_websocket::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            oauth::start_server_oauth,
            shell::set_call_controls,
            shell::quit_desktop
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            shell::setup(app)?;
            Ok(())
        })
        .on_window_event(shell::handle_window_event)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
