//! Integration tests: every driver goes through the same `Manager` calls the
//! UI makes. SQLite always runs; the servers run when HELIX_DB_TESTS=1 and
//! the containers from README are up:
//!   docker run -d --name helix-pg -e POSTGRES_PASSWORD=helixpw -p 55432:5432 postgres:16
//!   docker run -d --name helix-my -e MYSQL_ROOT_PASSWORD=helixpw -e MYSQL_DATABASE=helix -p 53306:3306 mysql:8.4
//!   docker run -d --name helix-ms -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD=Helix_pw123! -p 51433:1433 mcr.microsoft.com/mssql/server:2022-latest

mod harness;

use crate::models::Driver;
use harness::{config, run_suite, Dialect};

fn servers_enabled() -> bool {
    std::env::var("HELIX_DB_TESTS").map(|v| v == "1").unwrap_or(false)
}

#[tokio::test]
async fn sqlite_suite() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(Driver::Sqlite, "", 0, "", "");
    cfg.file_path = dir.path().join("t.db").to_string_lossy().into_owned();
    run_suite(cfg, None, Dialect::sqlite()).await;
}

#[tokio::test]
async fn postgres_suite() {
    if !servers_enabled() {
        return;
    }
    let cfg = config(Driver::Postgres, "127.0.0.1", 55432, "postgres", "postgres");
    run_suite(cfg, Some("helixpw".into()), Dialect::postgres()).await;
}

#[tokio::test]
async fn mysql_suite() {
    if !servers_enabled() {
        return;
    }
    let cfg = config(Driver::Mysql, "127.0.0.1", 53306, "helix", "root");
    run_suite(cfg, Some("helixpw".into()), Dialect::mysql()).await;
}

#[tokio::test]
async fn mssql_suite() {
    if !servers_enabled() {
        return;
    }
    let mut cfg = config(Driver::Mssql, "127.0.0.1", 51433, "master", "sa");
    cfg.ssl_mode = "prefer".into();
    run_suite(cfg, Some("Helix_pw123!".into()), Dialect::mssql()).await;
}


/// Hostile object names go through every catalog query as data, never as SQL.
async fn hostile_names(cfg: crate::models::ConnectionConfig, password: Option<String>, db: &str, schema: Option<&str>) {
    use crate::manager::Manager;
    use crate::models::Secrets;
    use std::sync::Arc;
    let m = Manager::new(crate::store::Store::in_memory(), Arc::new(crate::secrets::MemoryStore::default()));
    let id = m.save_connection(cfg.clone(), Secrets { password }).unwrap().id;
    m.connect(&id, None).await.unwrap();
    let s = m.open_session(&id, Some(db.into()), schema.map(Into::into), true).await.unwrap();
    let name = "h_o'dd\"; DROP TABLE h_guard; --";
    let q = crate::sqlscan::quote_ident(cfg.driver, name);
    for sql in ["DROP TABLE IF EXISTS h_guard".to_string(), format!("DROP TABLE IF EXISTS {q}"), "CREATE TABLE h_guard (id INT)".into(), format!("CREATE TABLE {q} (id INT PRIMARY KEY, \"x'y\" INT)")] {
        let sql = if cfg.driver == Driver::Mysql { sql.replace("\"x'y\"", "`x'y`") } else if cfg.driver == Driver::Mssql { sql.replace("\"x'y\"", "[x'y]") } else { sql };
        m.execute(&id, &s.id, "q", sql.clone(), 10).await.unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
    let objs = m.objects(&id, db, schema).await.unwrap();
    assert!(objs.iter().any(|o| o.name == name), "{:?}", cfg.driver);
    let info = m.table_info(&id, db, schema, name).await.unwrap();
    assert_eq!(info.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["id", "x'y"]);
    let ddl = m.object_ddl(&id, db, schema, name, "table", None).await.unwrap();
    assert!(ddl.contains("x'y"));
    assert!(m.schema_model(&id, db, schema).await.unwrap().iter().any(|t| t.name == name));
    // The guard table survived every one of those calls.
    assert!(m.objects(&id, db, schema).await.unwrap().iter().any(|o| o.name == "h_guard"));
    m.execute(&id, &s.id, "q", format!("DROP TABLE {q}"), 10).await.unwrap();
    m.execute(&id, &s.id, "q", "DROP TABLE h_guard".into(), 10).await.unwrap();
}

#[tokio::test]
async fn sqlite_hostile_names() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(Driver::Sqlite, "", 0, "", "");
    cfg.file_path = dir.path().join("h.db").to_string_lossy().into_owned();
    hostile_names(cfg, None, "main", None).await;
}

#[tokio::test]
async fn server_hostile_names() {
    if !servers_enabled() {
        return;
    }
    hostile_names(config(Driver::Postgres, "127.0.0.1", 55432, "postgres", "postgres"), Some("helixpw".into()), "postgres", Some("public")).await;
    hostile_names(config(Driver::Mysql, "127.0.0.1", 53306, "helix", "root"), Some("helixpw".into()), "helix", None).await;
    hostile_names(config(Driver::Mssql, "127.0.0.1", 51433, "master", "sa"), Some("Helix_pw123!".into()), "master", Some("dbo")).await;
}
