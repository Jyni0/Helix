//! Tauri IPC commands — thin wrappers over `Manager`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::error::{AppError, AppResult};
use crate::export::{ExportOptions, FileSink};
use crate::manager::Manager;
use crate::models::*;

pub struct AppState {
    pub manager: Arc<Manager>,
    /// Paths the user picked in file dialogs (the only ones the UI may touch).
    pub files: crate::files::FileAccess,
    /// Running exports (id → cancel flag).
    pub exports: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

type Cmd<'a> = State<'a, AppState>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionEntry {
    #[serde(flatten)]
    pub config: ConnectionConfig,
    pub has_password: bool,
    pub connected: bool,
}

// ---------------------------------------------------------------- connections

#[tauri::command]
pub fn list_connections(state: Cmd<'_>) -> AppResult<Vec<ConnectionEntry>> {
    let m = &state.manager;
    let live = m.connected();
    Ok(m.store
        .list()
        .into_iter()
        .map(|c| ConnectionEntry { has_password: c.save_password && m.has_password(&c.id), connected: live.contains(&c.id), config: c })
        .collect())
}

#[tauri::command]
pub async fn save_connection(state: Cmd<'_>, config: ConnectionConfig, secrets: Option<Secrets>) -> AppResult<ConnectionConfig> {
    let id = config.id.clone();
    let saved = state.manager.save_connection(config, secrets.unwrap_or_default())?;
    // Settings changed: the next use reconnects with them.
    if !id.is_empty() {
        state.manager.disconnect(&id).await;
    }
    Ok(saved)
}

#[tauri::command]
pub fn delete_connection(state: Cmd<'_>, id: String) -> AppResult<()> {
    state.manager.delete_connection(&id)
}

#[tauri::command]
pub fn reorder_connections(state: Cmd<'_>, ids: Vec<String>) -> AppResult<()> {
    state.manager.store.reorder(&ids)
}

#[tauri::command]
pub async fn test_connection(state: Cmd<'_>, config: ConnectionConfig, secrets: Option<Secrets>) -> AppResult<TestReport> {
    state.manager.test(config, secrets.unwrap_or_default()).await
}

#[tauri::command]
pub async fn connect(state: Cmd<'_>, id: String, password: Option<String>) -> AppResult<ServerInfo> {
    state.manager.connect(&id, password).await
}

#[tauri::command]
pub async fn disconnect(state: Cmd<'_>, id: String) -> AppResult<()> {
    state.manager.disconnect(&id).await;
    Ok(())
}

// ---------------------------------------------------------------- metadata

#[tauri::command]
pub async fn list_databases(state: Cmd<'_>, id: String) -> AppResult<Vec<DatabaseInfo>> {
    state.manager.databases(&id).await
}

#[tauri::command]
pub async fn list_schemas(state: Cmd<'_>, id: String, database: String) -> AppResult<Vec<SchemaInfo>> {
    state.manager.schemas(&id, &database).await
}

#[tauri::command]
pub async fn list_objects(state: Cmd<'_>, id: String, database: String, schema: Option<String>) -> AppResult<Vec<DbObject>> {
    state.manager.objects(&id, &database, schema.as_deref()).await
}

#[tauri::command]
pub async fn table_info(state: Cmd<'_>, id: String, database: String, schema: Option<String>, table: String) -> AppResult<TableInfo> {
    state.manager.table_info(&id, &database, schema.as_deref(), &table).await
}

#[tauri::command]
pub async fn object_ddl(
    state: Cmd<'_>,
    id: String,
    database: String,
    schema: Option<String>,
    name: String,
    kind: String,
    signature: Option<String>,
) -> AppResult<String> {
    state.manager.object_ddl(&id, &database, schema.as_deref(), &name, &kind, signature.as_deref()).await
}

#[tauri::command]
pub async fn schema_model(state: Cmd<'_>, id: String, database: String, schema: Option<String>) -> AppResult<Vec<ModelTable>> {
    state.manager.schema_model(&id, &database, schema.as_deref()).await
}

#[tauri::command]
pub async fn server_sessions(state: Cmd<'_>, id: String) -> AppResult<Vec<ServerSession>> {
    state.manager.server_sessions(&id).await
}

#[tauri::command]
pub async fn kill_server_session(state: Cmd<'_>, id: String, session: String, cancel_only: bool) -> AppResult<()> {
    state.manager.kill_session(&id, &session, cancel_only).await
}

#[tauri::command]
pub async fn meta_query(state: Cmd<'_>, id: String, database: String, sql: String) -> AppResult<Vec<StatementResult>> {
    state.manager.meta_query(&id, &database, &sql).await
}

// ---------------------------------------------------------------- sessions

#[tauri::command]
pub async fn open_session(state: Cmd<'_>, id: String, database: Option<String>, schema: Option<String>, auto_commit: bool) -> AppResult<SessionState> {
    state.manager.open_session(&id, database, schema, auto_commit).await
}

#[tauri::command]
pub async fn close_session(state: Cmd<'_>, id: String, session_id: String) -> AppResult<()> {
    state.manager.close_session(&id, &session_id).await;
    Ok(())
}

#[tauri::command]
pub async fn session_state(state: Cmd<'_>, id: String, session_id: String) -> AppResult<SessionState> {
    state.manager.session_state(&id, &session_id).await
}

#[tauri::command]
pub async fn set_session_scope(state: Cmd<'_>, id: String, session_id: String, database: String, schema: Option<String>) -> AppResult<SessionState> {
    state.manager.set_session_scope(&id, &session_id, database, schema).await
}

#[tauri::command]
pub async fn set_auto_commit(state: Cmd<'_>, id: String, session_id: String, auto_commit: bool) -> AppResult<SessionState> {
    state.manager.set_auto_commit(&id, &session_id, auto_commit).await
}

#[tauri::command]
pub async fn end_transaction(state: Cmd<'_>, id: String, session_id: String, commit: bool) -> AppResult<SessionState> {
    state.manager.end_transaction(&id, &session_id, commit).await
}

#[tauri::command]
pub async fn execute(state: Cmd<'_>, id: String, session_id: String, query_id: String, sql: String, limit: usize) -> AppResult<ExecuteResponse> {
    state.manager.execute(&id, &session_id, &query_id, sql, limit).await
}

#[tauri::command]
pub async fn cancel_query(state: Cmd<'_>, id: String, query_id: String) -> AppResult<()> {
    state.manager.cancel(&id, &query_id).await
}

#[tauri::command]
pub async fn explain(state: Cmd<'_>, id: String, session_id: String, sql: String, analyze: bool) -> AppResult<Vec<StatementResult>> {
    state.manager.explain(&id, &session_id, &sql, analyze).await
}

#[tauri::command]
pub async fn execute_batch(state: Cmd<'_>, id: String, session_id: String, statements: Vec<String>) -> AppResult<Vec<Option<u64>>> {
    state.manager.execute_batch(&id, &session_id, statements).await
}

// ---------------------------------------------------------------- export & files

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportProgress {
    export_id: String,
    rows: u64,
}

/// Streams the full result of `sql` into a file; returns the number of rows.
#[tauri::command]
pub async fn export_query(
    app: AppHandle,
    state: Cmd<'_>,
    id: String,
    database: String,
    sql: String,
    options: ExportOptions,
    export_id: String,
) -> AppResult<u64> {
    state.files.check(&options.path)?;
    let cancel = Arc::new(AtomicBool::new(false));
    state.exports.lock().unwrap().insert(export_id.clone(), cancel.clone());
    let manager = state.manager.clone();
    let result = async {
        let mut conn = manager.dedicated_conn(&id, &database).await?;
        let eid = export_id.clone();
        let progress = Box::new(move |rows| {
            let _ = app.emit("export:progress", ExportProgress { export_id: eid.clone(), rows });
        });
        let mut sink = FileSink::create(options.clone(), conn.driver(), cancel.clone(), progress)?;
        let run = conn.run(&sql, &mut sink).await;
        conn.close().await;
        match run {
            Ok(()) => sink.finish(),
            Err(e) => {
                drop(sink);
                let _ = std::fs::remove_file(&options.path);
                Err(e)
            }
        }
    }
    .await;
    state.exports.lock().unwrap().remove(&export_id);
    result
}

#[tauri::command]
pub fn export_cancel(state: Cmd<'_>, export_id: String) {
    if let Some(flag) = state.exports.lock().unwrap().get(&export_id) {
        flag.store(true, Ordering::Relaxed);
    }
}

#[derive(serde::Deserialize)]
pub struct FileFilter {
    name: String,
    extensions: Vec<String>,
}

fn dialog_with(app: &AppHandle, filters: &[FileFilter]) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    use tauri_plugin_dialog::DialogExt;
    let mut d = app.dialog().file();
    for f in filters {
        let exts: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
        d = d.add_filter(&f.name, &exts);
    }
    d
}

/// Native "open file" dialog; the chosen file becomes readable by the UI.
#[tauri::command]
pub async fn pick_open_file(app: AppHandle, state: Cmd<'_>, filters: Vec<FileFilter>, title: Option<String>) -> AppResult<Option<String>> {
    let mut d = dialog_with(&app, &filters);
    if let Some(t) = title {
        d = d.set_title(t);
    }
    let picked = tokio::task::spawn_blocking(move || d.blocking_pick_file()).await.map_err(|e| AppError::invalid(e.to_string()))?;
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
    state.files.allow(&path);
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Native "save file" dialog; the chosen file becomes writable by the UI.
#[tauri::command]
pub async fn pick_save_file(app: AppHandle, state: Cmd<'_>, default_path: String, filters: Vec<FileFilter>) -> AppResult<Option<String>> {
    let mut d = dialog_with(&app, &filters);
    let default = PathBuf::from(&default_path);
    if let Some(name) = default.file_name() {
        d = d.set_file_name(name.to_string_lossy());
    }
    if let Some(dir) = default.parent().filter(|p| p.is_dir()) {
        d = d.set_directory(dir);
    }
    let picked = tokio::task::spawn_blocking(move || d.blocking_save_file()).await.map_err(|e| AppError::invalid(e.to_string()))?;
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
    state.files.allow(&path);
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn read_text_file(state: Cmd<'_>, path: String) -> AppResult<String> {
    let path = state.files.check(&path)?;
    let bytes = tokio::fs::read(&path).await?;
    // Tolerates a BOM and non-UTF-8 bytes.
    let text = String::from_utf8_lossy(bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes)).into_owned();
    Ok(text)
}

#[tauri::command]
pub async fn write_text_file(state: Cmd<'_>, path: String, contents: String) -> AppResult<()> {
    let path = state.files.check(&path)?;
    tokio::fs::write(&path, contents).await?;
    Ok(())
}

// ---------------------------------------------------------------- updates

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| AppError::invalid(e.to_string()))?
}

#[derive(Clone, Serialize)]
struct UpdateProgress {
    received: u64,
    total: Option<u64>,
}

/// Downloads a release installer (see `updater`), reporting `update-progress` events.
#[tauri::command]
pub async fn update_download(app: AppHandle, url: String, name: String, digest: Option<String>) -> AppResult<String> {
    blocking(move || {
        crate::updater::download(&url, &name, digest.as_deref(), |received, total| {
            let _ = app.emit("update-progress", UpdateProgress { received, total });
        })
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(AppError::Invalid)
    })
    .await
}

/// Runs a downloaded installer; on Windows the app then quits so it can be replaced.
#[tauri::command]
pub async fn update_install(app: AppHandle, path: String) -> AppResult<()> {
    let quit = crate::updater::launch(&PathBuf::from(path)).map_err(AppError::Invalid)?;
    if quit {
        // A moment for the installer to start before the app (and its files) go away.
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(800));
            app.exit(0);
        });
    }
    Ok(())
}

/// `(os, arch)` as Rust sees them: picks the right installer.
#[tauri::command]
pub fn update_platform() -> (String, String) {
    (std::env::consts::OS.to_string(), std::env::consts::ARCH.to_string())
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}
