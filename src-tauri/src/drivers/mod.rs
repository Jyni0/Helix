//! One live database connection of any supported kind, and running SQL on it.
//!
//! Every value crosses over as text: what the server itself prints (numbers
//! keep their exact digits, dates their server format, binary becomes hex).

pub mod mssql;
pub mod mysql;
pub mod postgres;
pub mod sqlite;

use std::time::Instant;

use crate::error::{AppError, AppResult};
use crate::models::{ColumnInfo, ConnectionConfig, Driver, StatementResult};
use crate::sqlscan;

/// Where a connection should go.
#[derive(Clone, Debug)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
}

/// What to connect with.
pub struct ConnectParams<'a> {
    pub cfg: &'a ConnectionConfig,
    pub password: Option<&'a str>,
    pub database: &'a str,
    pub endpoint: Endpoint,
}

pub enum Conn {
    Postgres(sqlx::PgConnection),
    Mysql(sqlx::MySqlConnection),
    Sqlite(sqlx::SqliteConnection),
    Mssql(Box<mssql::Client>),
}

/// Whether a row sink wants more rows.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Flow {
    Continue,
    Stop,
}

/// Receives result sets as they stream in.
pub trait RowSink: Send {
    /// A new result set starts.
    fn begin(&mut self, columns: Vec<ColumnInfo>) -> AppResult<()>;
    fn row(&mut self, row: Vec<Option<String>>) -> AppResult<Flow>;
    /// The current result set is complete (`rows_affected` from the server, if known).
    fn end(&mut self, rows_affected: Option<u64>) -> AppResult<()>;
}

/// Collects results into memory, keeping at most `limit` rows per result.
pub struct Collect {
    pub limit: usize,
    pub results: Vec<StatementResult>,
    open: bool,
}

impl Collect {
    pub fn new(limit: usize) -> Self {
        Collect { limit, results: Vec::new(), open: false }
    }
}

impl RowSink for Collect {
    fn begin(&mut self, columns: Vec<ColumnInfo>) -> AppResult<()> {
        self.results.push(StatementResult { columns, ..Default::default() });
        self.open = true;
        Ok(())
    }
    fn row(&mut self, row: Vec<Option<String>>) -> AppResult<Flow> {
        let cur = self.results.last_mut().expect("begin before row");
        if cur.rows.len() >= self.limit {
            cur.has_more = true;
            return Ok(Flow::Stop);
        }
        cur.rows.push(row);
        Ok(Flow::Continue)
    }
    fn end(&mut self, rows_affected: Option<u64>) -> AppResult<()> {
        if self.open {
            if let Some(cur) = self.results.last_mut() {
                cur.rows_affected = rows_affected;
            }
        }
        self.open = false;
        Ok(())
    }
}

impl Conn {
    pub fn driver(&self) -> Driver {
        match self {
            Conn::Postgres(_) => Driver::Postgres,
            Conn::Mysql(_) => Driver::Mysql,
            Conn::Sqlite(_) => Driver::Sqlite,
            Conn::Mssql(_) => Driver::Mssql,
        }
    }

    pub async fn open(p: ConnectParams<'_>) -> AppResult<Conn> {
        let timeout = std::time::Duration::from_secs(p.cfg.connect_timeout.clamp(1, 600));
        let fut = async {
            Ok::<Conn, AppError>(match p.cfg.driver {
                Driver::Postgres => Conn::Postgres(postgres::connect(&p).await?),
                Driver::Mysql => Conn::Mysql(mysql::connect(&p).await?),
                Driver::Sqlite => Conn::Sqlite(sqlite::connect(&p).await?),
                Driver::Mssql => Conn::Mssql(Box::new(mssql::connect(&p).await?)),
            })
        };
        let mut conn = match tokio::time::timeout(timeout, fut).await {
            Ok(r) => r?,
            Err(_) => return Err(AppError::Connection(format!("Connection timed out after {}s", timeout.as_secs()))),
        };
        // Bootstrap statements of the connection.
        for stmt in split_init_sql(&p.cfg.init_sql) {
            conn.query_rows(&stmt).await.map_err(|e| AppError::Sql(format!("Init SQL failed ({stmt}): {e}")))?;
        }
        Ok(conn)
    }

    /// Streams every result of `sql` into `sink`.
    pub async fn run(&mut self, sql: &str, sink: &mut dyn RowSink) -> AppResult<()> {
        match self {
            Conn::Postgres(c) => postgres::run(c, sql, sink).await,
            Conn::Mysql(c) => mysql::run(c, sql, sink).await,
            Conn::Sqlite(c) => sqlite::run(c, sql, sink).await,
            Conn::Mssql(c) => mssql::run(c, sql, sink).await,
        }
    }

    /// Column names / types of a query without running it (for empty results).
    pub async fn describe(&mut self, sql: &str) -> Option<Vec<ColumnInfo>> {
        match self {
            Conn::Postgres(c) => postgres::describe(c, sql).await,
            Conn::Mysql(c) => mysql::describe(c, sql).await,
            Conn::Sqlite(c) => sqlite::describe(c, sql).await,
            Conn::Mssql(_) => None,
        }
    }

    /// Runs one statement (or a batch the server takes as one) and returns
    /// its results, at most `limit` rows each. `in_tx`: a transaction is open
    /// (a failed attempt must not abort it).
    pub async fn execute(&mut self, sql: &str, limit: usize, in_tx: bool) -> AppResult<Vec<StatementResult>> {
        let driver = self.driver();
        let started = Instant::now();
        let mut sink = Collect::new(limit);
        // Ask the server for limit+1 rows: one extra tells us there are more.
        let limited = if in_tx && driver == Driver::Postgres { None } else { sqlscan::limit_query(sql, driver, limit + 1) };
        let mut ran = false;
        if let Some(wrapped) = &limited {
            match self.run(wrapped, &mut sink).await {
                Ok(()) => ran = true,
                Err(e) if e.is_connection_lost() => return Err(e),
                Err(_) => sink = Collect::new(limit), // run the statement as written
            }
        }
        if !ran {
            self.run(sql, &mut sink).await?;
        }
        let mut results = sink.results;
        if results.is_empty() {
            results.push(StatementResult::default());
        }
        // An empty result still shows its columns.
        if results.len() == 1 && results[0].columns.is_empty() && results[0].rows.is_empty() && sqlscan::returns_rows(sql, driver) {
            let first = sqlscan::first_keyword(sql, driver);
            if matches!(first.as_str(), "SELECT" | "WITH" | "VALUES" | "TABLE") {
                if let Some(cols) = self.describe(sqlscan::trim_statement(sql)).await {
                    results[0].columns = cols;
                    results[0].rows_affected = None;
                }
            }
        }
        let elapsed = started.elapsed().as_millis() as u64;
        for r in &mut results {
            r.elapsed_ms = elapsed;
        }
        Ok(results)
    }

    /// Runs a (catalog) query and returns all its rows.
    pub async fn query_rows(&mut self, sql: &str) -> AppResult<Vec<Vec<Option<String>>>> {
        let mut sink = Collect::new(usize::MAX);
        self.run(sql, &mut sink).await?;
        Ok(sink.results.into_iter().find(|r| !r.columns.is_empty()).map(|r| r.rows).unwrap_or_default())
    }

    /// First column of the first row.
    pub async fn query_value(&mut self, sql: &str) -> AppResult<Option<String>> {
        Ok(self.query_rows(sql).await?.into_iter().next().and_then(|r| r.into_iter().next()).flatten())
    }

    pub async fn server_version(&mut self) -> AppResult<String> {
        let sql = match self.driver() {
            Driver::Postgres => "SELECT version()",
            Driver::Mysql => "SELECT CONCAT(@@version_comment, ' ', VERSION())",
            Driver::Sqlite => "SELECT 'SQLite ' || sqlite_version()",
            Driver::Mssql => "SELECT @@VERSION",
        };
        let v = self.query_value(sql).await?.unwrap_or_default();
        // SQL Server's banner is several lines long.
        Ok(v.lines().next().unwrap_or("").trim().to_string())
    }

    /// Server-side id of this connection (to cancel its running query from another one).
    pub async fn backend_id(&mut self) -> Option<String> {
        let sql = match self.driver() {
            Driver::Postgres => "SELECT pg_backend_pid()",
            Driver::Mysql => "SELECT CONNECTION_ID()",
            Driver::Mssql => "SELECT @@SPID",
            Driver::Sqlite => return None,
        };
        self.query_value(sql).await.ok().flatten()
    }

    pub async fn begin(&mut self) -> AppResult<()> {
        let sql = match self.driver() {
            Driver::Mysql => "START TRANSACTION",
            Driver::Mssql => "BEGIN TRANSACTION",
            _ => "BEGIN",
        };
        self.query_rows(sql).await.map(|_| ())
    }

    pub async fn commit(&mut self) -> AppResult<()> {
        let sql = if self.driver() == Driver::Mssql { "IF @@TRANCOUNT > 0 COMMIT TRANSACTION" } else { "COMMIT" };
        self.query_rows(sql).await.map(|_| ())
    }

    pub async fn rollback(&mut self) -> AppResult<()> {
        let sql = if self.driver() == Driver::Mssql { "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION" } else { "ROLLBACK" };
        self.query_rows(sql).await.map(|_| ())
    }

    pub async fn ping(&mut self) -> AppResult<()> {
        self.query_rows("SELECT 1").await.map(|_| ())
    }

    pub async fn close(self) {
        use sqlx::Connection;
        match self {
            Conn::Postgres(c) => {
                let _ = c.close().await;
            }
            Conn::Mysql(c) => {
                let _ = c.close().await;
            }
            Conn::Sqlite(c) => {
                let _ = c.close().await;
            }
            Conn::Mssql(c) => mssql::close(*c).await,
        }
    }
}

/// Init SQL: statements separated by `;` at line ends or blank lines.
pub fn split_init_sql(sql: &str) -> Vec<String> {
    sql.split(";\n")
        .flat_map(|s| s.split("\n\n"))
        .map(|s| s.trim().trim_end_matches(';').trim().to_string())
        .filter(|s| !s.is_empty() && !s.starts_with("--"))
        .collect()
}

/// The kind of a column for the UI (alignment, editors), from its type name.
pub fn kind_of(type_name: &str) -> &'static str {
    let t = type_name.to_ascii_lowercase();
    let t = t.trim_start_matches('_');
    let base = t.split(['(', ' ']).next().unwrap_or("");
    if t.ends_with("[]") {
        return "other";
    }
    match base {
        "int" | "int2" | "int4" | "int8" | "integer" | "smallint" | "bigint" | "tinyint" | "mediumint" | "serial" | "bigserial" | "smallserial"
        | "decimal" | "numeric" | "real" | "float" | "float4" | "float8" | "double" | "money" | "smallmoney" | "number" | "oid" | "year" => "number",
        "bool" | "boolean" | "bit" => "bool",
        "date" | "time" | "timetz" | "timestamp" | "timestamptz" | "datetime" | "datetime2" | "smalldatetime" | "datetimeoffset" | "interval" => "date",
        "json" | "jsonb" => "json",
        "bytea" | "blob" | "tinyblob" | "mediumblob" | "longblob" | "binary" | "varbinary" | "image" | "geometry" | "geography" => "binary",
        "uuid" | "uniqueidentifier" => "uuid",
        "text" | "varchar" | "char" | "character" | "nvarchar" | "nchar" | "ntext" | "bpchar" | "name" | "citext" | "tinytext" | "mediumtext" | "longtext"
        | "string" | "clob" | "enum" | "set" | "xml" | "sysname" | "inet" | "cidr" | "macaddr" => "text",
        _ if base.starts_with("int") || base.starts_with("uint") => "number",
        _ => "other",
    }
}

pub fn column(name: impl Into<String>, type_name: impl Into<String>) -> ColumnInfo {
    let type_name = type_name.into();
    ColumnInfo { name: name.into(), kind: kind_of(&type_name), type_name }
}

/// Lowercase hex with a prefix ("\x…" for PostgreSQL style, "0x…" otherwise).
pub fn hex(bytes: &[u8], prefix: &str) -> String {
    let mut s = String::with_capacity(prefix.len() + bytes.len() * 2);
    s.push_str(prefix);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds() {
        assert_eq!(kind_of("integer"), "number");
        assert_eq!(kind_of("numeric(10,2)"), "number");
        assert_eq!(kind_of("character varying(20)"), "text");
        assert_eq!(kind_of("timestamp with time zone"), "date");
        assert_eq!(kind_of("BIGINT UNSIGNED"), "number");
        assert_eq!(kind_of("jsonb"), "json");
        assert_eq!(kind_of("int4[]"), "other");
        assert_eq!(kind_of("uniqueidentifier"), "uuid");
    }

    #[test]
    fn init_sql_splits() {
        assert_eq!(split_init_sql("SET a = 1;\nSET b = 2;\n\n-- note\n"), vec!["SET a = 1", "SET b = 2"]);
    }
}
