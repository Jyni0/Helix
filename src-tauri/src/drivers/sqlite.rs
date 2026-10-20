//! SQLite through sqlx (bundled libsqlite3).

use futures::future::BoxFuture;
use futures::TryStreamExt;
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection, SqliteRow};
use sqlx::{Column, ConnectOptions, Decode, Either, Executor, Row, Sqlite, TypeInfo, ValueRef};

use super::{column, hex, ConnectParams, Flow, RowSink};
use crate::error::{AppError, AppResult};
use crate::models::ColumnInfo;

pub fn connect<'a>(p: &'a ConnectParams<'a>) -> BoxFuture<'a, AppResult<SqliteConnection>> {
    Box::pin(async move {
    let path = p.cfg.file_path.trim();
    if path.is_empty() {
        return Err(AppError::invalid("Choose the SQLite database file"));
    }
    let create = !p.cfg.read_only && path != ":memory:";
    let o = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(create && !std::path::Path::new(path).exists())
        .read_only(p.cfg.read_only)
        // Plain SQLite semantics: foreign keys are enforced only when the user asks.
        .foreign_keys(false)
        .log_statements(log::LevelFilter::Off);
    Ok(o.connect().await?)
    })
}

fn columns(row: &SqliteRow) -> Vec<ColumnInfo> {
    row.columns().iter().map(|c| column(c.name(), c.type_info().name())).collect()
}

fn values(row: &SqliteRow) -> Vec<Option<String>> {
    (0..row.len())
        .map(|i| {
            let raw = row.try_get_raw(i).ok()?;
            if raw.is_null() {
                return None;
            }
            // The storage class of this very value (SQLite types are per value).
            if raw.type_info().name() == "BLOB" {
                return Some(hex(&<Vec<u8> as Decode<Sqlite>>::decode(raw).unwrap_or_default(), "0x"));
            }
            Some(<String as Decode<Sqlite>>::decode(raw).unwrap_or_else(|e| format!("<{e}>")))
        })
        .collect()
}

pub fn run<'a>(c: &'a mut SqliteConnection, sql: &'a str, sink: &'a mut dyn RowSink) -> BoxFuture<'a, AppResult<()>> {
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

pub fn describe<'a>(c: &'a mut SqliteConnection, sql: &'a str) -> BoxFuture<'a, Option<Vec<ColumnInfo>>> {
    Box::pin(async move {
        let d = (&mut *c).describe(sql).await.ok()?;
        Some(d.columns().iter().map(|col| column(col.name(), col.type_info().name())).collect())
    })
}
