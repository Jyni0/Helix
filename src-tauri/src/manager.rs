//! Live connections. Each connected server has metadata connections (one
//! per database on PostgreSQL) for the navigator, and every SQL editor gets
//! a session: a connection of its own with its own transaction state.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::Mutex as AsyncMutex;

use crate::drivers::{ConnectParams, Conn, Endpoint};
use crate::error::{AppError, AppResult};
use crate::meta;
use crate::models::*;
use crate::secrets::{password_key, SecretStore};
use crate::sqlscan::{self, quote_ident, TxEffect};
use crate::store::Store;

pub struct Session {
    conn: Option<Conn>,
    database: String,
    schema: Option<String>,
    auto_commit: bool,
    in_tx: bool,
    tx_statements: u32,
    backend_id: Option<String>,
}

impl Session {
    fn state(&self, id: &str) -> SessionState {
        SessionState {
            id: id.to_string(),
            database: self.database.clone(),
            schema: self.schema.clone(),
            auto_commit: self.auto_commit,
            in_transaction: self.in_tx,
            transaction_statements: self.tx_statements,
        }
    }
}

struct Running {
    abort: tokio::task::AbortHandle,
    session_id: String,
    backend_id: Option<String>,
}

type MetaSlot = Arc<AsyncMutex<Option<Conn>>>;

pub struct Live {
    pub cfg: ConnectionConfig,
    password: Option<String>,
    pub version: String,
    meta: Mutex<HashMap<String, MetaSlot>>,
    sessions: Mutex<HashMap<String, Arc<AsyncMutex<Session>>>>,
    running: Mutex<HashMap<String, Running>>,
    cancelled: Mutex<HashSet<String>>,
}

impl Live {
    pub async fn open_conn(&self, database: &str) -> AppResult<Conn> {
        Conn::open(ConnectParams {
            cfg: &self.cfg,
            password: self.password.as_deref(),
            database,
            endpoint: Endpoint { host: self.cfg.host.clone(), port: if self.cfg.port == 0 { self.cfg.driver.default_port() } else { self.cfg.port } },
        })
        .await
    }

    fn meta_key(&self, db: &str) -> String {
        if self.cfg.driver.connection_per_database() && !db.is_empty() {
            db.to_string()
        } else {
            String::new()
        }
    }

    /// The metadata connection for `db` (connected on first use).
    async fn meta_slot(&self, db: &str) -> AppResult<tokio::sync::OwnedMutexGuard<Option<Conn>>> {
        let key = self.meta_key(db);
        let slot = self.meta.lock().unwrap().entry(key.clone()).or_default().clone();
        let mut guard = slot.lock_owned().await;
        if guard.is_none() {
            let target = if key.is_empty() { self.cfg.default_database() } else { key };
            *guard = Some(self.open_conn(&target).await?);
        }
        Ok(guard)
    }

    fn session(&self, id: &str) -> AppResult<Arc<AsyncMutex<Session>>> {
        self.sessions.lock().unwrap().get(id).cloned().ok_or_else(|| AppError::NotFound("editor session (reconnect the editor)".into()))
    }
}

/// Runs a metadata call; a lost connection is reopened and the call retried once.
macro_rules! with_meta {
    ($live:expr, $db:expr, |$c:ident| $call:expr) => {{
        let mut guard = $live.meta_slot($db).await?;
        let first = {
            let $c = guard.as_mut().unwrap();
            $call.await
        };
        match first {
            Err(e) if e.is_connection_lost() => {
                *guard = None;
                drop(guard);
                let mut guard = $live.meta_slot($db).await?;
                let $c = guard.as_mut().unwrap();
                $call.await
            }
            other => other,
        }
    }};
}

pub struct Manager {
    pub store: Store,
    secrets: Arc<dyn SecretStore>,
    live: Mutex<HashMap<String, Arc<Live>>>,
    /// Passwords typed at connect time for connections that do not save them.
    typed_passwords: Mutex<HashMap<String, String>>,
}

impl Manager {
    pub fn new(store: Store, secrets: Arc<dyn SecretStore>) -> Self {
        Manager { store, secrets, live: Mutex::new(HashMap::new()), typed_passwords: Mutex::new(HashMap::new()) }
    }

    // ------------------------------------------------------------ saved connections

    pub fn save_connection(&self, cfg: ConnectionConfig, secrets: Secrets) -> AppResult<ConnectionConfig> {
        let saved = self.store.upsert(cfg)?;
        if saved.save_password {
            if let Some(pw) = secrets.password {
                self.secrets.set(&password_key(&saved.id), &pw)?;
            }
        } else {
            self.secrets.delete(&password_key(&saved.id))?;
        }
        Ok(saved)
    }

    pub fn delete_connection(&self, id: &str) -> AppResult<()> {
        self.drop_live(id);
        self.store.delete(id)?;
        let _ = self.secrets.delete(&password_key(id));
        Ok(())
    }

    /// Whether a password is saved for the connection.
    pub fn has_password(&self, id: &str) -> bool {
        self.secrets.get(&password_key(id)).ok().flatten().is_some()
    }

    fn password_for(&self, cfg: &ConnectionConfig, typed: Option<String>) -> AppResult<Option<String>> {
        if typed.is_some() {
            return Ok(typed);
        }
        if let Some(p) = self.typed_passwords.lock().unwrap().get(&cfg.id) {
            return Ok(Some(p.clone()));
        }
        if cfg.id.is_empty() {
            return Ok(None);
        }
        self.secrets.get(&password_key(&cfg.id))
    }

    pub async fn test(&self, cfg: ConnectionConfig, secrets: Secrets) -> AppResult<TestReport> {
        let password = self.password_for(&cfg, secrets.password)?;
        let live = Live {
            password,
            version: String::new(),
            meta: Default::default(),
            sessions: Default::default(),
            running: Default::default(),
            cancelled: Default::default(),
            cfg,
        };
        let started = std::time::Instant::now();
        let mut conn = live.open_conn(&live.cfg.default_database()).await?;
        let server_version = conn.server_version().await?;
        let elapsed_ms = started.elapsed().as_millis() as u64;
        conn.close().await;
        Ok(TestReport { server_version, elapsed_ms })
    }

    // ------------------------------------------------------------ connect

    pub async fn connect(&self, id: &str, typed_password: Option<String>) -> AppResult<ServerInfo> {
        if let Some(l) = self.live.lock().unwrap().get(id).cloned() {
            return Ok(ServerInfo { driver: l.cfg.driver, version: l.version.clone(), database: l.cfg.default_database() });
        }
        let cfg = self.store.get(id)?;
        let password = self.password_for(&cfg, typed_password.clone())?;
        let mut live = Live {
            cfg: cfg.clone(),
            password: password.clone(),
            version: String::new(),
            meta: Default::default(),
            sessions: Default::default(),
            running: Default::default(),
            cancelled: Default::default(),
        };
        let db = cfg.default_database();
        let mut conn = live.open_conn(&db).await?;
        live.version = conn.server_version().await.unwrap_or_default();
        live.meta.lock().unwrap().insert(live.meta_key(&db), Arc::new(AsyncMutex::new(Some(conn))));
        if let Some(p) = typed_password {
            if cfg.save_password {
                self.secrets.set(&password_key(id), &p)?;
            } else {
                self.typed_passwords.lock().unwrap().insert(id.to_string(), p);
            }
        }
        let info = ServerInfo { driver: cfg.driver, version: live.version.clone(), database: db };
        self.live.lock().unwrap().insert(id.to_string(), Arc::new(live));
        self.store.touch(id);
        Ok(info)
    }

    fn drop_live(&self, id: &str) -> Option<Arc<Live>> {
        let live = self.live.lock().unwrap().remove(id)?;
        for r in live.running.lock().unwrap().values() {
            r.abort.abort();
        }
        Some(live)
    }

    pub async fn disconnect(&self, id: &str) {
        let Some(live) = self.drop_live(id) else { return };
        let slots: Vec<MetaSlot> = live.meta.lock().unwrap().drain().map(|(_, s)| s).collect();
        let sessions: Vec<_> = live.sessions.lock().unwrap().drain().map(|(_, s)| s).collect();
        for s in slots {
            if let Some(c) = s.lock().await.take() {
                c.close().await;
            }
        }
        for s in sessions {
            let mut s = s.lock().await;
            if let Some(mut c) = s.conn.take() {
                if s.in_tx {
                    let _ = c.rollback().await;
                }
                c.close().await;
            }
        }
    }

    pub fn connected(&self) -> Vec<String> {
        self.live.lock().unwrap().keys().cloned().collect()
    }

    pub fn live(&self, id: &str) -> AppResult<Arc<Live>> {
        self.live.lock().unwrap().get(id).cloned().ok_or_else(|| AppError::Connection("Not connected".into()))
    }

    // ------------------------------------------------------------ metadata

    pub async fn databases(&self, id: &str) -> AppResult<Vec<DatabaseInfo>> {
        let live = self.live(id)?;
        if !live.cfg.show_all_databases && live.cfg.driver != Driver::Sqlite {
            return Ok(vec![DatabaseInfo { name: live.cfg.default_database(), system: false }]);
        }
        let mut list = with_meta!(live, "", |c| meta::list_databases(c))?;
        // The configured database is always listed (MySQL may connect without one).
        let def = live.cfg.default_database();
        if !def.is_empty() && !list.iter().any(|d| d.name == def) {
            list.insert(0, DatabaseInfo { name: def, system: false });
        }
        Ok(list)
    }

    pub async fn schemas(&self, id: &str, db: &str) -> AppResult<Vec<SchemaInfo>> {
        let live = self.live(id)?;
        with_meta!(live, db, |c| meta::list_schemas(c, db))
    }

    pub async fn objects(&self, id: &str, db: &str, schema: Option<&str>) -> AppResult<Vec<DbObject>> {
        let live = self.live(id)?;
        with_meta!(live, db, |c| meta::list_objects(c, db, schema))
    }

    pub async fn table_info(&self, id: &str, db: &str, schema: Option<&str>, table: &str) -> AppResult<TableInfo> {
        let live = self.live(id)?;
        with_meta!(live, db, |c| meta::table_info(c, db, schema, table))
    }

    pub async fn object_ddl(&self, id: &str, db: &str, schema: Option<&str>, name: &str, kind: &str, signature: Option<&str>) -> AppResult<String> {
        let live = self.live(id)?;
        with_meta!(live, db, |c| meta::object_ddl(c, db, schema, name, kind, signature))
    }

    pub async fn schema_model(&self, id: &str, db: &str, schema: Option<&str>) -> AppResult<Vec<ModelTable>> {
        let live = self.live(id)?;
        with_meta!(live, db, |c| meta::schema_model(c, db, schema))
    }

    pub async fn server_sessions(&self, id: &str) -> AppResult<Vec<ServerSession>> {
        let live = self.live(id)?;
        with_meta!(live, "", |c| meta::server_sessions(c))
    }

    pub async fn kill_session(&self, id: &str, session: &str, cancel_only: bool) -> AppResult<()> {
        let live = self.live(id)?;
        with_meta!(live, "", |c| meta::kill_session(c, session, cancel_only))
    }

    /// Runs a read-only query on the metadata connection of `db`.
    pub async fn meta_query(&self, id: &str, db: &str, sql: &str) -> AppResult<Vec<StatementResult>> {
        let live = self.live(id)?;
        with_meta!(live, db, |c| c.execute(sql, 10_000, false))
    }

    // ------------------------------------------------------------ sessions

    pub async fn open_session(&self, id: &str, database: Option<String>, schema: Option<String>, auto_commit: bool) -> AppResult<SessionState> {
        let live = self.live(id)?;
        let database = database.filter(|d| !d.is_empty()).unwrap_or_else(|| live.cfg.default_database());
        let mut conn = live.open_conn(&database).await?;
        if let Some(s) = &schema {
            apply_schema(&mut conn, s).await?;
        }
        let backend_id = conn.backend_id().await;
        let session = Session { conn: Some(conn), database, schema, auto_commit, in_tx: false, tx_statements: 0, backend_id };
        let sid = uuid::Uuid::new_v4().to_string();
        let state = session.state(&sid);
        live.sessions.lock().unwrap().insert(sid, Arc::new(AsyncMutex::new(session)));
        Ok(state)
    }

    pub async fn close_session(&self, id: &str, session_id: &str) {
        let Ok(live) = self.live(id) else { return };
        let Some(s) = live.sessions.lock().unwrap().remove(session_id) else { return };
        let mut s = s.lock().await;
        if let Some(mut c) = s.conn.take() {
            if s.in_tx {
                let _ = c.rollback().await;
            }
            c.close().await;
        }
    }

    pub async fn session_state(&self, id: &str, session_id: &str) -> AppResult<SessionState> {
        let live = self.live(id)?;
        let s = live.session(session_id)?;
        let s = s.lock().await;
        Ok(s.state(session_id))
    }

    /// Switches the session's default database / schema.
    pub async fn set_session_scope(&self, id: &str, session_id: &str, database: String, schema: Option<String>) -> AppResult<SessionState> {
        let live = self.live(id)?;
        let s = live.session(session_id)?;
        let mut s = s.lock().await;
        let driver = live.cfg.driver;
        if database != s.database {
            if s.in_tx {
                return Err(AppError::invalid("Commit or roll back the open transaction first"));
            }
            match driver {
                Driver::Postgres => {
                    // A PostgreSQL connection belongs to one database.
                    let conn = live.open_conn(&database).await?;
                    if let Some(old) = s.conn.replace(conn) {
                        old.close().await;
                    }
                    s.backend_id = s.conn.as_mut().unwrap().backend_id().await;
                }
                Driver::Mysql | Driver::Mssql => {
                    ensure_conn(&live, &mut s).await?;
                    s.conn.as_mut().unwrap().query_rows(&format!("USE {}", quote_ident(driver, &database))).await?;
                }
                Driver::Sqlite => {}
            }
            s.database = database;
        }
        if let Some(schema) = &schema {
            if s.schema.as_ref() != Some(schema) || driver == Driver::Postgres {
                ensure_conn(&live, &mut s).await?;
                apply_schema(s.conn.as_mut().unwrap(), schema).await?;
            }
        }
        s.schema = schema;
        Ok(s.state(session_id))
    }

    pub async fn set_auto_commit(&self, id: &str, session_id: &str, auto_commit: bool) -> AppResult<SessionState> {
        let live = self.live(id)?;
        let s = live.session(session_id)?;
        let mut s = s.lock().await;
        // Switching to auto-commit commits what is pending (as JDBC does).
        if auto_commit && s.in_tx {
            if let Some(c) = s.conn.as_mut() {
                c.commit().await?;
            }
            s.in_tx = false;
            s.tx_statements = 0;
        }
        s.auto_commit = auto_commit;
        Ok(s.state(session_id))
    }

    pub async fn end_transaction(&self, id: &str, session_id: &str, commit: bool) -> AppResult<SessionState> {
        let live = self.live(id)?;
        let s = live.session(session_id)?;
        let mut s = s.lock().await;
        if let Some(c) = s.conn.as_mut() {
            if commit {
                c.commit().await?;
            } else {
                c.rollback().await?;
            }
        }
        s.in_tx = false;
        s.tx_statements = 0;
        Ok(s.state(session_id))
    }

    /// Runs one statement on an editor session. `query_id` lets `cancel` find it.
    pub async fn execute(&self, id: &str, session_id: &str, query_id: &str, sql: String, limit: usize) -> AppResult<ExecuteResponse> {
        let live = self.live(id)?;
        let session = live.session(session_id)?;
        let driver = live.cfg.driver;
        // Read before the statement takes the session (cancel needs it meanwhile).
        let backend_id = session.lock().await.backend_id.clone();
        let task_live = live.clone();
        let task_session = session.clone();
        let task = tokio::spawn(async move {
            let mut s = task_session.lock().await;
            ensure_conn(&task_live, &mut s).await?;
            let effect = sqlscan::tx_effect(&sql, driver);
            if !s.auto_commit && !s.in_tx && effect.is_none() {
                s.conn.as_mut().unwrap().begin().await?;
                s.in_tx = true;
                s.tx_statements = 0;
            }
            let in_tx = s.in_tx;
            let result = s.conn.as_mut().unwrap().execute(&sql, limit.max(1), in_tx).await;
            match effect {
                Some(TxEffect::Begin) if result.is_ok() => {
                    s.in_tx = true;
                    s.tx_statements = 0;
                }
                Some(TxEffect::End) if result.is_ok() => {
                    s.in_tx = false;
                    s.tx_statements = 0;
                }
                _ => {}
            }
            if s.in_tx && effect.is_none() && !sqlscan::returns_rows(&sql, driver) {
                s.tx_statements += 1;
            }
            if let Err(e) = &result {
                if e.is_connection_lost() {
                    s.conn = None;
                    s.in_tx = false;
                    s.tx_statements = 0;
                }
            }
            let (in_transaction, transaction_statements) = (s.in_tx, s.tx_statements);
            result.map(|results| ExecuteResponse { results, in_transaction, transaction_statements })
        });
        live.running.lock().unwrap().insert(query_id.to_string(), Running { abort: task.abort_handle(), session_id: session_id.to_string(), backend_id });
        let outcome = task.await;
        live.running.lock().unwrap().remove(query_id);
        let was_cancelled = live.cancelled.lock().unwrap().remove(query_id);
        match outcome {
            Ok(Ok(r)) => Ok(r),
            Ok(Err(_)) if was_cancelled => Err(AppError::Cancelled),
            Ok(Err(e)) => Err(e),
            Err(_) => {
                // Aborted mid-statement: the connection's state is unknown.
                let mut s = session.lock().await;
                s.conn = None;
                s.in_tx = false;
                s.tx_statements = 0;
                Err(AppError::Cancelled)
            }
        }
    }

    /// Stops a running statement: the server is asked to cancel it; if it is
    /// still running a few seconds later (or the server cannot cancel), the
    /// session's connection is dropped.
    pub async fn cancel(&self, id: &str, query_id: &str) -> AppResult<()> {
        let live = self.live(id)?;
        let Some((abort, backend_id)) = live.running.lock().unwrap().get(query_id).map(|r| (r.abort.clone(), r.backend_id.clone())) else {
            return Ok(());
        };
        live.cancelled.lock().unwrap().insert(query_id.to_string());
        let graceful = matches!(live.cfg.driver, Driver::Postgres | Driver::Mysql);
        if let (true, Some(pid)) = (graceful, backend_id.clone()) {
            let pid2 = pid.clone();
            let _ = tokio::time::timeout(Duration::from_secs(3), async { with_meta!(live, "", |c| meta::kill_session(c, &pid2, true)) }).await;
            for _ in 0..30 {
                if !live.running.lock().unwrap().contains_key(query_id) {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        abort.abort();
        if live.cfg.driver == Driver::Mssql {
            if let Some(spid) = backend_id {
                let _ = tokio::time::timeout(Duration::from_secs(3), async { with_meta!(live, "", |c| meta::kill_session(c, &spid, false)) }).await;
            }
        }
        Ok(())
    }

    /// Queries running right now (query id → session id).
    pub fn running(&self, id: &str) -> Vec<(String, String)> {
        self.live(id).map(|l| l.running.lock().unwrap().iter().map(|(q, r)| (q.clone(), r.session_id.clone())).collect()).unwrap_or_default()
    }

    /// The execution plan of `sql`.
    pub async fn explain(&self, id: &str, session_id: &str, sql: &str, analyze: bool) -> AppResult<Vec<StatementResult>> {
        let live = self.live(id)?;
        let s = live.session(session_id)?;
        let mut s = s.lock().await;
        ensure_conn(&live, &mut s).await?;
        let c = s.conn.as_mut().unwrap();
        let stmts = meta::explain_statements(live.cfg.driver, sql, analyze);
        if stmts.len() == 1 {
            return c.execute(&stmts[0], 100_000, false).await;
        }
        c.query_rows(&stmts[0]).await?;
        let res = c.execute(&stmts[1], 100_000, false).await;
        let off = c.query_rows(&stmts[2]).await;
        let res = res?;
        off?;
        Ok(res)
    }

    /// Runs statements as one unit (data editor saves, imports): inside the
    /// session's open transaction, or in a transaction of their own.
    pub async fn execute_batch(&self, id: &str, session_id: &str, statements: Vec<String>) -> AppResult<Vec<Option<u64>>> {
        let live = self.live(id)?;
        let s = live.session(session_id)?;
        let mut s = s.lock().await;
        ensure_conn(&live, &mut s).await?;
        let own_tx = !s.in_tx;
        if own_tx && s.auto_commit {
            s.conn.as_mut().unwrap().begin().await?;
        } else if own_tx {
            // Manual-commit mode: the batch opens the transaction and leaves it open.
            s.conn.as_mut().unwrap().begin().await?;
            s.in_tx = true;
            s.tx_statements = 0;
        }
        let mut counts = Vec::with_capacity(statements.len());
        for (i, stmt) in statements.iter().enumerate() {
            let r = s.conn.as_mut().unwrap().execute(stmt, 1, true).await;
            match r {
                Ok(res) => {
                    counts.push(res.first().and_then(|r| r.rows_affected));
                    if !s.auto_commit {
                        s.tx_statements += 1;
                    }
                }
                Err(e) => {
                    if s.auto_commit {
                        let _ = s.conn.as_mut().unwrap().rollback().await;
                    }
                    return Err(match e {
                        AppError::Sql(m) => AppError::Sql(format!("Statement {} of {}: {m}", i + 1, statements.len())),
                        other => other,
                    });
                }
            }
        }
        if s.auto_commit {
            s.conn.as_mut().unwrap().commit().await?;
        }
        Ok(counts)
    }

    /// A fresh connection to `database` (exports run on their own).
    pub async fn dedicated_conn(&self, id: &str, database: &str) -> AppResult<Conn> {
        let live = self.live(id)?;
        let db = if database.is_empty() { live.cfg.default_database() } else { database.to_string() };
        live.open_conn(&db).await
    }
}

async fn ensure_conn(live: &Live, s: &mut Session) -> AppResult<()> {
    if s.conn.is_none() {
        let mut conn = live.open_conn(&s.database).await?;
        if let Some(schema) = &s.schema {
            let _ = apply_schema(&mut conn, schema).await;
        }
        s.backend_id = conn.backend_id().await;
        s.conn = Some(conn);
    }
    Ok(())
}

/// Makes `schema` the session's default for unqualified names (PostgreSQL;
/// the other servers have no per-session default schema).
async fn apply_schema(conn: &mut Conn, schema: &str) -> AppResult<()> {
    if conn.driver() == Driver::Postgres {
        let q = quote_ident(Driver::Postgres, schema);
        let path = if schema == "public" { q } else { format!("{q}, public") };
        conn.query_rows(&format!("SET search_path TO {path}")).await?;
    }
    Ok(())
}
