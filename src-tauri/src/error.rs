use serde::{Serialize, Serializer};

/// Unified error type for the whole core. Serialized to the frontend as
/// `{ kind, message }` so the UI can branch on the error category.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// The server rejected a statement (syntax, constraint, permission…).
    #[error("{0}")]
    Sql(String),
    /// Could not reach / lost the server.
    #[error("{0}")]
    Connection(String),
    #[error("{0}")]
    Auth(String),
    #[error("secure storage error: {0}")]
    Secret(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
    #[error("Query cancelled")]
    Cancelled,
    /// Refused by a safety rule (file access outside picked paths…).
    #[error("{0}")]
    Forbidden(String),
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization error: {0}")]
    Json(#[from] serde_json::Error),
}

impl AppError {
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::Sql(_) => "sql",
            AppError::Connection(_) => "connection",
            AppError::Auth(_) => "auth",
            AppError::Secret(_) => "secret",
            AppError::NotFound(_) => "not_found",
            AppError::Invalid(_) => "invalid",
            AppError::Cancelled => "cancelled",
            AppError::Forbidden(_) => "forbidden",
            AppError::Io(_) => "io",
            AppError::Json(_) => "json",
        }
    }

    pub fn invalid(m: impl Into<String>) -> Self {
        AppError::Invalid(m.into())
    }

    /// The connection itself is gone (not just one statement failing):
    /// the caller should drop it and reconnect.
    pub fn is_connection_lost(&self) -> bool {
        matches!(self, AppError::Connection(_) | AppError::Io(_))
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("AppError", 2)?;
        s.serialize_field("kind", self.kind())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        use sqlx::Error as E;
        match e {
            E::Database(db) => {
                let code = db.code().map(|c| c.to_string()).unwrap_or_default();
                // 28xxx: PostgreSQL auth; 1045: MySQL access denied.
                if code.starts_with("28") || code == "1045" {
                    return AppError::Auth(db.message().to_string());
                }
                let mut msg = db.message().to_string();
                if let Some(pg) = db.try_downcast_ref::<sqlx::postgres::PgDatabaseError>() {
                    if let Some(detail) = pg.detail() {
                        msg.push_str("\nDetail: ");
                        msg.push_str(detail);
                    }
                    if let Some(hint) = pg.hint() {
                        msg.push_str("\nHint: ");
                        msg.push_str(hint);
                    }
                    if let Some(sqlx::postgres::PgErrorPosition::Original(p)) = pg.position() {
                        msg.push_str(&format!("\nPosition: {p}"));
                    }
                }
                if !code.is_empty() {
                    msg = format!("[{code}] {msg}");
                }
                AppError::Sql(msg)
            }
            E::Io(io) => AppError::Connection(io.to_string()),
            E::Tls(t) => AppError::Connection(format!("TLS error: {t}")),
            E::PoolTimedOut | E::PoolClosed | E::WorkerCrashed => AppError::Connection(e.to_string()),
            E::Protocol(p) => AppError::Connection(format!("protocol error: {p}")),
            E::Configuration(c) => AppError::Invalid(c.to_string()),
            other => AppError::Sql(other.to_string()),
        }
    }
}

impl From<tiberius::error::Error> for AppError {
    fn from(e: tiberius::error::Error) -> Self {
        use tiberius::error::Error as E;
        match e {
            E::Server(t) => {
                // 18456: login failed.
                if t.code() == 18456 {
                    AppError::Auth(t.message().to_string())
                } else {
                    let line = if t.line() > 0 { format!(" (line {})", t.line()) } else { String::new() };
                    AppError::Sql(format!("[{}] {}{}", t.code(), t.message(), line))
                }
            }
            E::Io { message, .. } => AppError::Connection(message),
            E::Tls(m) => AppError::Connection(format!("TLS error: {m}")),
            E::Routing { host, port } => AppError::Connection(format!("server redirected to {host}:{port}")),
            other => AppError::Sql(other.to_string()),
        }
    }
}

impl From<keyring::Error> for AppError {
    fn from(e: keyring::Error) -> Self {
        AppError::Secret(e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
