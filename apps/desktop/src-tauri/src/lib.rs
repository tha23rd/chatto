mod oauth;
mod realtime;
mod shell;
mod updates;

use tauri::Manager;

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
        .plugin(tauri_plugin_http::init())
        .plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(updates::updater_public_key())
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            oauth::start_server_oauth,
            realtime::realtime_connect,
            realtime::realtime_receive,
            realtime::realtime_send,
            realtime::realtime_disconnect,
            shell::set_call_controls,
            updates::get_desktop_update_state,
            updates::set_desktop_update_channel,
            updates::check_for_desktop_update,
            updates::install_desktop_update,
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
            app.manage(realtime::RealtimeConnectionManager::default());
            shell::setup(app)?;
            app.manage(updates::DesktopUpdateManager::new(
                app.package_info().version.to_string(),
            ));
            Ok(())
        })
        .on_window_event(shell::handle_window_event)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
