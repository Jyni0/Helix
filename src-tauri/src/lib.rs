//! Helix — Tauri core.

pub mod commands;
pub mod drivers;
pub mod error;
pub mod export;
pub mod files;
pub mod manager;
pub mod meta;
pub mod models;
pub mod secrets;
pub mod sqlscan;
pub mod store;
pub mod updater;

#[cfg(test)]
mod tests;

use std::sync::Arc;

use tauri::Manager as _;

use commands::AppState;

const KEYRING_SERVICE: &str = "dev.helix.db";

/// WebView2 handles Ctrl+P (print), Ctrl+F (find), Ctrl+R / F5 (reload),
/// Ctrl+wheel (zoom) before the page sees them; Helix owns those keys.
#[cfg(windows)]
fn disable_browser_shortcuts(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
        use windows_core::Interface;
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let Ok(settings) = core.Settings() else { return };
        let _ = settings.SetIsZoomControlEnabled(false);
        if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
            let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
        }
    });
}

#[cfg(not(windows))]
fn disable_browser_shortcuts(_window: &tauri::WebviewWindow) {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let store = store::Store::open(dir.join("connections.json"));
            let manager = manager::Manager::new(store, Arc::new(secrets::KeyringStore::new(KEYRING_SERVICE)));
            let files = files::FileAccess::open(dir.join("files.json"));
            app.manage(AppState { manager: Arc::new(manager), files, exports: Default::default() });
            if let Some(window) = app.get_webview_window("main") {
                disable_browser_shortcuts(&window);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_connections,
            commands::save_connection,
            commands::delete_connection,
            commands::reorder_connections,
            commands::test_connection,
            commands::connect,
            commands::disconnect,
            commands::list_databases,
            commands::list_schemas,
            commands::list_objects,
            commands::table_info,
            commands::object_ddl,
            commands::schema_model,
            commands::server_sessions,
            commands::kill_server_session,
            commands::meta_query,
            commands::open_session,
            commands::close_session,
            commands::session_state,
            commands::set_session_scope,
            commands::set_auto_commit,
            commands::end_transaction,
            commands::execute,
            commands::cancel_query,
            commands::explain,
            commands::execute_batch,
            commands::export_query,
            commands::export_cancel,
            commands::pick_open_file,
            commands::pick_save_file,
            commands::read_text_file,
            commands::write_text_file,
            commands::update_download,
            commands::update_install,
            commands::update_platform,
            commands::quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Helix");
}
