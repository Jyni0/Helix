//! Data shapes shared with the frontend (camelCase over IPC).

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Driver {
    Postgres,
    Mysql,
    Sqlite,
    Mssql,
}

impl Driver {
    pub fn label(self) -> &'static str {
        match self {
            Driver::Postgres => "PostgreSQL",
            Driver::Mysql => "MySQL",
            Driver::Sqlite => "SQLite",
            Driver::Mssql => "SQL Server",
        }
    }

    pub fn default_port(self) -> u16 {
        match self {
            Driver::Postgres => 5432,
            Driver::Mysql => 3306,
            Driver::Sqlite => 0,
            Driver::Mssql => 1433,
        }
    }

    /// PostgreSQL binds a connection to one database: browsing another one
    /// needs a connection of its own. The others switch with qualified names.
    pub fn connection_per_database(self) -> bool {
        self == Driver::Postgres
    }
}

/// DBeaver's "connection type": production connections confirm data changes.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Environment {
    #[default]
    Development,
    Test,
    Production,
}

/// A saved connection. Passwords are not part of it: they live in the
/// system keychain (see `secrets`).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub driver: Driver,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    /// Default database (PostgreSQL / MySQL / SQL Server).
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub user: String,
    /// SQLite database file.
    #[serde(default)]
    pub file_path: String,
    /// disable | prefer | require | verify-ca | verify-full
    #[serde(default = "default_ssl")]
    pub ssl_mode: String,
    /// SQL Server: accept the server certificate without validation.
    #[serde(default = "yes")]
    pub trust_server_certificate: bool,
    /// SQL Server: Windows integrated authentication.
    #[serde(default)]
    pub windows_auth: bool,
    /// Keep the password in the keychain (otherwise it is asked on connect).
    #[serde(default = "yes")]
    pub save_password: bool,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub environment: Environment,
    /// Accent color of the connection in the navigator and editor tabs.
    #[serde(default)]
    pub color: Option<String>,
    /// Navigator folder ("" = top level).
    #[serde(default)]
    pub folder: String,
    /// List every database of the server in the navigator, not only the default one.
    #[serde(default = "yes")]
    pub show_all_databases: bool,
    /// Statements run on every new connection (one per line / separated by `;`).
    #[serde(default)]
    pub init_sql: String,
    #[serde(default = "default_timeout")]
    pub connect_timeout: u64,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub last_used_at: Option<i64>,
}

fn yes() -> bool {
    true
}
fn default_ssl() -> String {
    "prefer".into()
}
fn default_timeout() -> u64 {
    15
}

impl ConnectionConfig {
    /// The database a fresh connection lands in.
    pub fn default_database(&self) -> String {
        match self.driver {
            Driver::Sqlite => "main".into(),
            Driver::Postgres if self.database.is_empty() => {
                if self.user.is_empty() {
                    "postgres".into()
                } else {
                    self.user.clone()
                }
            }
            _ => self.database.clone(),
        }
    }
}

/// Secrets sent along with a connection when it is saved or tested.
#[derive(Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Secrets {
    /// Database password (None = keep the saved one).
    pub password: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TestReport {
    pub server_version: String,
    pub elapsed_ms: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub driver: Driver,
    pub version: String,
    /// The database a session lands in.
    pub database: String,
}

// ---------- Query results ----------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub type_name: String,
    /// number | text | bool | date | json | binary | uuid | other
    pub kind: &'static str,
}

/// One result of a statement. Values travel as text — exactly what the
/// server prints — or null.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct StatementResult {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<Option<String>>>,
    /// Rows changed by DML (None when the server did not say).
    pub rows_affected: Option<u64>,
    /// The fetch stopped at the row limit: there are more rows.
    pub has_more: bool,
    pub elapsed_ms: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteResponse {
    pub results: Vec<StatementResult>,
    /// A transaction is open on the session (manual commit mode).
    pub in_transaction: bool,
    /// Statements run inside the open transaction.
    pub transaction_statements: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub id: String,
    pub database: String,
    pub schema: Option<String>,
    pub auto_commit: bool,
    pub in_transaction: bool,
    pub transaction_statements: u32,
}

// ---------- Metadata ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseInfo {
    pub name: String,
    pub system: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInfo {
    pub name: String,
    pub system: bool,
}

/// table | view | matview | foreign | function | procedure | sequence | trigger
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DbObject {
    pub name: String,
    pub kind: &'static str,
    pub comment: Option<String>,
    /// Estimated row count (tables).
    pub rows: Option<i64>,
    /// Argument list of a function / procedure (identifies overloads).
    pub signature: Option<String>,
    /// Table of a trigger.
    pub parent: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDef {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub primary_key: bool,
    pub auto_increment: bool,
    pub comment: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct IndexDef {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
    /// btree, hash, CLUSTERED…
    pub method: Option<String>,
    pub definition: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyDef {
    pub name: String,
    pub columns: Vec<String>,
    /// Schema (or database for MySQL) of the referenced table.
    pub ref_schema: Option<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    pub on_update: Option<String>,
    pub on_delete: Option<String>,
}

/// A foreign key of another table pointing at this one.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceDef {
    pub name: String,
    pub schema: Option<String>,
    pub table: String,
    pub columns: Vec<String>,
    pub ref_columns: Vec<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TriggerDef {
    pub name: String,
    /// "BEFORE INSERT", …
    pub event: Option<String>,
    pub definition: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConstraintDef {
    pub name: String,
    /// check | unique | exclude
    pub kind: String,
    pub definition: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    pub kind: String,
    pub comment: Option<String>,
    pub columns: Vec<ColumnDef>,
    pub primary_key: Vec<String>,
    pub indexes: Vec<IndexDef>,
    pub foreign_keys: Vec<ForeignKeyDef>,
    pub references: Vec<ReferenceDef>,
    pub triggers: Vec<TriggerDef>,
    pub constraints: Vec<ConstraintDef>,
    /// Key / value properties (rows, size, engine, collation…).
    pub properties: Vec<(String, String)>,
}

/// One table of a schema-wide model (ER diagram, autocomplete).
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelTable {
    pub name: String,
    pub kind: String,
    pub columns: Vec<ModelColumn>,
    pub foreign_keys: Vec<ForeignKeyDef>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelColumn {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub primary_key: bool,
}

/// A client session of the server (Database → Sessions).
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServerSession {
    pub id: String,
    pub user: Option<String>,
    pub database: Option<String>,
    pub client: Option<String>,
    pub application: Option<String>,
    pub state: Option<String>,
    pub started: Option<String>,
    pub query_start: Option<String>,
    pub wait: Option<String>,
    pub query: Option<String>,
}
