//! MySQL / MariaDB through sqlx. Statements without parameters use the text
//! protocol, so values arrive as the server prints them.

use futures::future::BoxFuture;
use futures::TryStreamExt;
use sqlx::mysql::{MySqlConnectOptions, MySqlConnection, MySqlRow, MySqlSslMode};
use sqlx::{Column, ConnectOptions, Decode, Either, Executor, MySql, Row, TypeInfo, ValueRef};

use super::{column, hex, ConnectParams, Flow, RowSink};
use crate::error::AppResult;
use crate::models::ColumnInfo;

fn ssl(mode: &str) -> MySqlSslMode {
    match mode {
        "disable" => MySqlSslMode::Disabled,
        "require" => MySqlSslMode::Required,
        "verify-ca" => MySqlSslMode::VerifyCa,
        "verify-full" => MySqlSslMode::VerifyIdentity,
        _ => MySqlSslMode::Preferred,
    }
}

pub fn connect<'a>(p: &'a ConnectParams<'a>) -> BoxFuture<'a, AppResult<MySqlConnection>> {
    Box::pin(async move {
    let mut o = MySqlConnectOptions::new()
        .host(&p.endpoint.host)
        .port(p.endpoint.port)
        .username(&p.cfg.user)
        .ssl_mode(ssl(&p.cfg.ssl_mode))
        .charset("utf8mb4")
        // A database client must not change the session's SQL semantics.
        .pipes_as_concat(false)
        .no_engine_substitution(false)
        .timezone(None)
        .log_statements(log::LevelFilter::Off);
    if !p.database.is_empty() {
        o = o.database(p.database);
    }
    if let Some(pw) = p.password {
        o = o.password(pw);
    }
    let mut c = o.connect().await?;
    if p.cfg.read_only {
        run(&mut c, "SET SESSION TRANSACTION READ ONLY", &mut super::Collect::new(0)).await?;
    }
    Ok(c)
    })
}

fn columns(row: &MySqlRow) -> Vec<ColumnInfo> {
    row.columns().iter().map(|c| column(c.name(), c.type_info().name())).collect()
}

fn is_binary(type_name: &str) -> bool {
    matches!(type_name, "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "BINARY" | "VARBINARY" | "GEOMETRY")
}

fn values(row: &MySqlRow) -> Vec<Option<String>> {
    row.columns()
        .iter()
        .enumerate()
        .map(|(i, col)| {
            let raw = row.try_get_raw(i).ok()?;
            if raw.is_null() {
                return None;
            }
            let ty = col.type_info().name().to_string();
            if ty == "BIT" {
                // BIT(n) arrives as big-endian bytes.
                let bytes = <Vec<u8> as Decode<MySql>>::decode(raw).unwrap_or_default();
                return Some(bytes.iter().fold(0u64, |acc, b| (acc << 8) | *b as u64).to_string());
            }
            if is_binary(&ty) {
                // sqlx flags *_bin-collated text (all of information_schema) as
                // binary: printable UTF-8 is shown as text, anything else as hex.
                let bytes = <Vec<u8> as Decode<MySql>>::decode(raw).unwrap_or_default();
                return Some(match String::from_utf8(bytes) {
                    Ok(s) if s.chars().all(|c| !c.is_control() || matches!(c, '\t' | '\n' | '\r')) => s,
                    Ok(s) => hex(s.as_bytes(), "0x"),
                    Err(e) => hex(e.as_bytes(), "0x"),
                });
            }
            match <String as Decode<MySql>>::decode(raw.clone()) {
                Ok(s) => Some(s),
                Err(_) => Some(hex(&<Vec<u8> as Decode<MySql>>::decode(raw).unwrap_or_default(), "0x")),
            }
        })
        .collect()
}

pub fn run<'a>(c: &'a mut MySqlConnection, sql: &'a str, sink: &'a mut dyn RowSink) -> BoxFuture<'a, AppResult<()>> {
    Box::pin(async move {
    let mut stream = sqlx::raw_sql(sql).fetch_many(&mut *c);
    let mut begun = false;
    while let Some(item) = stream.try_next().await? {
        match item {
            Either::Left(done) => {
                if !begun {
                    sink.begin(Vec::new())?;
                }
                sink.end(Some(done.rows_affected()))?;
                begun = false;
            }
            Either::Right(row) => {
                if !begun {
                    sink.begin(columns(&row))?;
                    begun = true;
                }
                if sink.row(values(&row))? == Flow::Stop {
                    sink.end(None)?;
                    return Ok(());
                }
            }
        }
    }
    if begun {
        sink.end(None)?;
    }
    Ok(())
    })
}

pub fn describe<'a>(c: &'a mut MySqlConnection, sql: &'a str) -> BoxFuture<'a, Option<Vec<ColumnInfo>>> {
    Box::pin(async move {
        let d = (&mut *c).describe(sql).await.ok()?;
        Some(d.columns().iter().map(|col| column(col.name(), col.type_info().name())).collect())
    })
}
