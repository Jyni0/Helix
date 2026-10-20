use std::sync::Arc;
use std::time::Duration;

use crate::error::AppError;
use crate::export::{ExportOptions, FileSink};
use crate::manager::Manager;
use crate::models::*;
use crate::secrets::MemoryStore;
use crate::store::Store;

pub fn config(driver: Driver, host: &str, port: u16, database: &str, user: &str) -> ConnectionConfig {
    ConnectionConfig {
        id: String::new(),
        name: format!("test {}", driver.label()),
        driver,
        host: host.into(),
        port,
        database: database.into(),
        user: user.into(),
        file_path: String::new(),
        ssl_mode: "disable".into(),
        trust_server_certificate: true,
        windows_auth: false,
        save_password: true,
        read_only: false,
        environment: Environment::Development,
        color: None,
        folder: String::new(),
        show_all_databases: true,
        init_sql: String::new(),
        connect_timeout: 20,
        created_at: 0,
        last_used_at: None,
    }
}

/// Per-driver SQL for the suite.
pub struct Dialect {
    pub db: &'static str,
    pub schema: Option<&'static str>,
    pub setup: Vec<&'static str>,
    pub sleep: Option<&'static str>,
    pub count_customers: &'static str,
}

impl Dialect {
    pub fn sqlite() -> Self {
        Dialect {
            db: "main",
            schema: None,
            setup: vec![
                "DROP VIEW IF EXISTS h_big",
                "DROP TABLE IF EXISTS h_orders",
                "DROP TABLE IF EXISTS h_customers",
                "CREATE TABLE h_customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(100) NOT NULL, email VARCHAR(200), created DATE DEFAULT CURRENT_DATE)",
                "CREATE TABLE h_orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES h_customers(id) ON DELETE CASCADE, total NUMERIC(10,2), note TEXT, data BLOB)",
                "CREATE INDEX h_orders_cust ON h_orders(customer_id)",
                "CREATE VIEW h_big AS SELECT * FROM h_orders WHERE total > 100",
            ],
            sleep: None,
            count_customers: "SELECT COUNT(*) FROM h_customers",
        }
    }
    pub fn postgres() -> Self {
        Dialect {
            db: "postgres",
            schema: Some("public"),
            setup: vec![
                "DROP VIEW IF EXISTS h_big",
                "DROP TABLE IF EXISTS h_orders",
                "DROP TABLE IF EXISTS h_customers",
                "CREATE TABLE h_customers (id serial PRIMARY KEY, name varchar(100) NOT NULL, email varchar(200), created date DEFAULT CURRENT_DATE)",
                "COMMENT ON TABLE h_customers IS 'People who buy'",
                "CREATE TABLE h_orders (id serial PRIMARY KEY, customer_id int NOT NULL REFERENCES h_customers(id) ON DELETE CASCADE, total numeric(10,2), note text, data bytea)",
                "CREATE INDEX h_orders_cust ON h_orders(customer_id)",
                "CREATE VIEW h_big AS SELECT * FROM h_orders WHERE total > 100",
            ],
            sleep: Some("SELECT pg_sleep(20)"),
            count_customers: "SELECT COUNT(*) FROM h_customers",
        }
    }
    pub fn mysql() -> Self {
        Dialect {
            db: "helix",
            schema: None,
            setup: vec![
                "DROP VIEW IF EXISTS h_big",
                "DROP TABLE IF EXISTS h_orders",
                "DROP TABLE IF EXISTS h_customers",
                "CREATE TABLE h_customers (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, email VARCHAR(200), created DATE) COMMENT='People who buy'",
                "CREATE TABLE h_orders (id INT AUTO_INCREMENT PRIMARY KEY, customer_id INT NOT NULL, total DECIMAL(10,2), note TEXT, data BLOB, \
                 CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES h_customers(id) ON DELETE CASCADE)",
                "CREATE INDEX h_orders_cust ON h_orders(customer_id)",
                "CREATE VIEW h_big AS SELECT * FROM h_orders WHERE total > 100",
            ],
            sleep: Some("SELECT SLEEP(20)"),
            count_customers: "SELECT COUNT(*) FROM h_customers",
        }
    }
    pub fn mssql() -> Self {
        Dialect {
            db: "master",
            schema: Some("dbo"),
            setup: vec![
                "DROP VIEW IF EXISTS h_big",
                "DROP TABLE IF EXISTS h_orders",
                "DROP TABLE IF EXISTS h_customers",
                "CREATE TABLE h_customers (id INT IDENTITY(1,1) PRIMARY KEY, name NVARCHAR(100) NOT NULL, email NVARCHAR(200), created DATE DEFAULT GETDATE())",
                "CREATE TABLE h_orders (id INT IDENTITY(1,1) PRIMARY KEY, customer_id INT NOT NULL REFERENCES h_customers(id) ON DELETE CASCADE, total DECIMAL(10,2), note NVARCHAR(MAX), data VARBINARY(MAX))",
                "CREATE INDEX h_orders_cust ON h_orders(customer_id)",
                "CREATE VIEW h_big AS SELECT * FROM h_orders WHERE total > 100",
            ],
            sleep: Some("WAITFOR DELAY '00:00:20'"),
            count_customers: "SELECT COUNT(*) FROM h_customers",
        }
    }
}

async fn count(m: &Manager, id: &str, sid: &str, sql: &str) -> i64 {
    let r = m.execute(id, sid, "count", sql.into(), 10).await.unwrap();
    r.results[0].rows[0][0].clone().unwrap().parse().unwrap()
}

pub async fn run_suite(cfg: ConnectionConfig, password: Option<String>, d: Dialect) {
    let driver = cfg.driver;
    let m = Arc::new(Manager::new(Store::in_memory(), Arc::new(MemoryStore::default())));

    // Test + save + connect.
    let report = m.test(cfg.clone(), Secrets { password: password.clone() }).await.expect("test connection");
    assert!(!report.server_version.is_empty());
    let saved = m.save_connection(cfg, Secrets { password }).unwrap();
    let id = saved.id.clone();
    let info = m.connect(&id, None).await.expect("connect");
    assert_eq!(info.driver, driver);

    let session = m.open_session(&id, Some(d.db.into()), d.schema.map(Into::into), true).await.expect("open session");
    let sid = session.id.clone();
    for stmt in &d.setup {
        m.execute(&id, &sid, "setup", (*stmt).into(), 10).await.unwrap_or_else(|e| panic!("{stmt}: {e}"));
    }

    // Insert 250 customers in one statement; DML reports its row count.
    let values: Vec<String> = (1..=250).map(|i| format!("('c{i}', 'c{i}@example.com')")).collect();
    let r = m.execute(&id, &sid, "ins", format!("INSERT INTO h_customers (name, email) VALUES {}", values.join(", ")), 10).await.unwrap();
    assert_eq!(r.results[0].rows_affected, Some(250), "{driver:?} insert count");
    let bin = match driver {
        Driver::Postgres => "'\\x0102ff'::bytea",
        Driver::Mssql => "0x0102FF",
        _ => "X'0102ff'",
    };
    m.execute(
        &id,
        &sid,
        "ins2",
        format!("INSERT INTO h_orders (customer_id, total, note, data) VALUES (1, 12.50, 'it''s', {bin}), (1, 150.00, NULL, NULL), (2, 99.99, 'x', NULL)"),
        10,
    )
    .await
    .unwrap();

    // Row limit: 200 of 250, more available.
    let r = m.execute(&id, &sid, "sel", "SELECT * FROM h_customers ORDER BY id".into(), 200).await.unwrap();
    let res = &r.results[0];
    assert_eq!(res.rows.len(), 200, "{driver:?} limited rows");
    assert!(res.has_more, "{driver:?} has_more");
    assert_eq!(res.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["id", "name", "email", "created"]);
    assert_eq!(res.columns[0].kind, "number", "{driver:?} id kind: {}", res.columns[0].type_name);
    assert_eq!(res.rows[0][1].as_deref(), Some("c1"));
    // Unlimited enough: all rows, no more.
    let r = m.execute(&id, &sid, "sel2", "SELECT id FROM h_customers".into(), 1000).await.unwrap();
    assert_eq!(r.results[0].rows.len(), 250);
    assert!(!r.results[0].has_more);

    // Values as text: NULLs, decimals, quotes, binary.
    let r = m.execute(&id, &sid, "sel3", "SELECT total, note, data FROM h_orders ORDER BY id".into(), 10).await.unwrap();
    let rows = &r.results[0].rows;
    assert_eq!(rows[0][0].as_deref().unwrap().parse::<f64>().unwrap(), 12.5);
    assert_eq!(rows[0][1].as_deref(), Some("it's"));
    assert_eq!(rows[1][1], None);
    let hex = rows[0][2].as_deref().unwrap().to_ascii_lowercase();
    assert!(hex.ends_with("0102ff"), "{driver:?} binary {hex}");
    // Text from information_schema is text, not hex.
    if driver == Driver::Mysql {
        let r = m.execute(&id, &sid, "is", "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_NAME = 'h_orders'".into(), 10).await.unwrap();
        assert_eq!(r.results[0].rows[0][0].as_deref(), Some("h_orders"));
    }

    // An empty result still has its columns.
    let r = m.execute(&id, &sid, "empty", "SELECT id, name FROM h_customers WHERE 1 = 0".into(), 10).await.unwrap();
    assert_eq!(r.results[0].columns.len(), 2, "{driver:?} empty result columns");
    assert!(r.results[0].rows.is_empty());

    // SQL errors come back as Sql errors and the session stays usable.
    let e = m.execute(&id, &sid, "bad", "SELECT nope FROM h_customers".into(), 10).await.unwrap_err();
    assert!(matches!(e, AppError::Sql(_)), "{driver:?}: {e:?}");
    assert_eq!(count(&m, &id, &sid, d.count_customers).await, 250);

    // Navigator metadata.
    let dbs = m.databases(&id).await.unwrap();
    assert!(dbs.iter().any(|x| x.name == d.db), "{driver:?} databases {dbs:?}");
    if let Some(schema) = d.schema {
        let schemas = m.schemas(&id, d.db).await.unwrap();
        assert!(schemas.iter().any(|s| s.name == schema && !s.system));
    }
    let objs = m.objects(&id, d.db, d.schema).await.unwrap();
    let kind_of = |n: &str| objs.iter().find(|o| o.name == n).map(|o| o.kind);
    assert_eq!(kind_of("h_customers"), Some("table"), "{driver:?} objects");
    assert_eq!(kind_of("h_big"), Some("view"));

    let t = m.table_info(&id, d.db, d.schema, "h_orders").await.unwrap();
    assert_eq!(t.primary_key, vec!["id"], "{driver:?} pk");
    assert_eq!(t.columns.len(), 5);
    assert!(t.columns[0].auto_increment, "{driver:?} auto increment");
    assert!(!t.columns[1].nullable);
    assert_eq!(t.foreign_keys.len(), 1);
    assert_eq!(t.foreign_keys[0].ref_table, "h_customers");
    assert_eq!(t.foreign_keys[0].columns, vec!["customer_id"]);
    assert_eq!(t.foreign_keys[0].ref_columns, vec!["id"]);
    assert!(t.indexes.iter().any(|i| i.name == "h_orders_cust" && i.columns == vec!["customer_id"]), "{driver:?} indexes {:?}", t.indexes);
    let c = m.table_info(&id, d.db, d.schema, "h_customers").await.unwrap();
    assert_eq!(c.references.len(), 1, "{driver:?} references");
    assert_eq!(c.references[0].table, "h_orders");
    assert!(m.table_info(&id, d.db, d.schema, "no_such_table").await.is_err());

    let ddl = m.object_ddl(&id, d.db, d.schema, "h_orders", "table", None).await.unwrap();
    assert!(ddl.to_ascii_uppercase().contains("CREATE TABLE"), "{driver:?} ddl {ddl}");
    assert!(ddl.contains("customer_id"));
    let vddl = m.object_ddl(&id, d.db, d.schema, "h_big", "view", None).await.unwrap();
    assert!(vddl.contains("100"), "{driver:?} view ddl {vddl}");

    let model = m.schema_model(&id, d.db, d.schema).await.unwrap();
    let orders = model.iter().find(|t| t.name == "h_orders").expect("model has orders");
    assert_eq!(orders.foreign_keys.len(), 1);
    assert!(orders.columns.iter().any(|c| c.name == "id" && c.primary_key), "{driver:?} model pk");

    // Manual commit: changes vanish on rollback, stay on commit.
    let st = m.set_auto_commit(&id, &sid, false).await.unwrap();
    assert!(!st.auto_commit);
    let r = m.execute(&id, &sid, "tx1", "DELETE FROM h_customers WHERE id > 200".into(), 10).await.unwrap();
    assert!(r.in_transaction);
    assert_eq!(r.transaction_statements, 1);
    assert_eq!(count(&m, &id, &sid, d.count_customers).await, 200);
    m.end_transaction(&id, &sid, false).await.unwrap();
    assert_eq!(count(&m, &id, &sid, d.count_customers).await, 250);
    m.execute(&id, &sid, "tx2", "DELETE FROM h_customers WHERE id > 249".into(), 10).await.unwrap();
    let st = m.end_transaction(&id, &sid, true).await.unwrap();
    assert!(!st.in_transaction);
    m.set_auto_commit(&id, &sid, true).await.unwrap();
    assert_eq!(count(&m, &id, &sid, d.count_customers).await, 249);

    // A failing batch leaves nothing behind.
    let e = m
        .execute_batch(&id, &sid, vec!["DELETE FROM h_customers WHERE id = 10".into(), "UPDATE h_customers SET nope = 1".into()])
        .await
        .unwrap_err();
    assert!(e.to_string().contains("Statement 2 of 2"), "{e}");
    assert_eq!(count(&m, &id, &sid, d.count_customers).await, 249);
    let counts = m.execute_batch(&id, &sid, vec!["UPDATE h_customers SET email = NULL WHERE id IN (1, 2)".into()]).await.unwrap();
    assert_eq!(counts, vec![Some(2)], "{driver:?} batch counts");

    // Explain.
    let plan = m.explain(&id, &sid, "SELECT * FROM h_orders WHERE customer_id = 1", false).await.unwrap();
    assert!(plan.iter().any(|r| !r.rows.is_empty()), "{driver:?} plan");

    // Cancel a long statement; the session still works afterwards.
    if let Some(sleep) = d.sleep {
        let m2 = m.clone();
        let (id2, sid2) = (id.clone(), sid.clone());
        let started = std::time::Instant::now();
        let run = tokio::spawn(async move { m2.execute(&id2, &sid2, "sleepy", sleep.into(), 10).await });
        tokio::time::sleep(Duration::from_millis(800)).await;
        m.cancel(&id, "sleepy").await.unwrap();
        let out = run.await.unwrap();
        assert!(matches!(out, Err(AppError::Cancelled)), "{driver:?} cancel: {out:?}");
        assert!(started.elapsed() < Duration::from_secs(10), "{driver:?} cancel took {:?}", started.elapsed());
        assert_eq!(count(&m, &id, &sid, d.count_customers).await, 249);
    }

    // Server sessions.
    if driver != Driver::Sqlite {
        let sessions = m.server_sessions(&id).await.unwrap();
        assert!(!sessions.is_empty(), "{driver:?} sessions");
    }

    // Export the whole table.
    let dir = tempfile::tempdir().unwrap();
    for format in ["csv", "json", "sql", "markdown", "xml", "html"] {
        let path = dir.path().join(format!("out.{format}"));
        let opts = ExportOptions { format: format.into(), path: path.to_string_lossy().into_owned(), table_name: "h_customers".into(), ..Default::default() };
        let mut conn = m.dedicated_conn(&id, d.db).await.unwrap();
        let mut sink = FileSink::create(opts, driver, Default::default(), Box::new(|_| {})).unwrap();
        conn.run("SELECT id, name, email FROM h_customers ORDER BY id", &mut sink).await.unwrap();
        assert_eq!(sink.finish().unwrap(), 249);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("c249"), "{format}");
        if format == "json" {
            let v: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(v.as_array().unwrap().len(), 249);
            assert_eq!(v[0]["email"], serde_json::Value::Null);
        }
        if format == "csv" {
            assert!(text.starts_with("id,name,email\n1,c1,\n"), "{text:.40}");
        }
    }

    // Switching the session's database (MySQL / SQL Server: USE).
    let st = m.set_session_scope(&id, &sid, d.db.into(), d.schema.map(Into::into)).await.unwrap();
    assert_eq!(st.database, d.db);

    for stmt in d.setup.iter().take(3) {
        m.execute(&id, &sid, "cleanup", (*stmt).into(), 10).await.unwrap();
    }
    m.close_session(&id, &sid).await;
    m.disconnect(&id).await;
    assert!(m.live(&id).is_err());
}
