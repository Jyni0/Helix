//! PostgreSQL through sqlx. Statements go over the simple-query protocol, so
//! every value arrives in PostgreSQL's own text format.

use futures::future::BoxFuture;
use futures::TryStreamExt;
use sqlx::postgres::{PgConnectOptions, PgConnection, PgRow, PgSslMode};
use sqlx::{Column, ConnectOptions, Decode, Either, Executor, Postgres, Row, TypeInfo, ValueRef};

use super::{column, ConnectParams, Flow, RowSink};
use crate::error::AppResult;
use crate::models::ColumnInfo;

fn ssl(mode: &str) -> PgSslMode {
    match mode {
        "disable" => PgSslMode::Disable,
        "allow" => PgSslMode::Allow,
        "require" => PgSslMode::Require,
        "verify-ca" => PgSslMode::VerifyCa,
        "verify-full" => PgSslMode::VerifyFull,
        _ => PgSslMode::Prefer,
    }
}

pub fn connect<'a>(p: &'a ConnectParams<'a>) -> BoxFuture<'a, AppResult<PgConnection>> {
    Box::pin(async move {
    let mut o = PgConnectOptions::new()
        .host(&p.endpoint.host)
        .port(p.endpoint.port)
        .database(p.database)
        .application_name("Helix")
        .ssl_mode(ssl(&p.cfg.ssl_mode))
        .log_statements(log::LevelFilter::Off);
    if !p.cfg.user.is_empty() {
        o = o.username(&p.cfg.user);
    }
    if let Some(pw) = p.password {
        o = o.password(pw);
    }
    let mut c = o.connect().await?;
    if p.cfg.read_only {
        run(&mut c, "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY", &mut super::Collect::new(0)).await?;
    }
    Ok(c)
    })
}

fn columns(row: &PgRow) -> Vec<ColumnInfo> {
    row.columns().iter().map(|c| column(c.name(), c.type_info().name())).collect()
}

fn values(row: &PgRow) -> Vec<Option<String>> {
    (0..row.len())
        .map(|i| {
            let raw = row.try_get_raw(i).ok()?;
            if raw.is_null() {
                return None;
            }
            Some(<String as Decode<Postgres>>::decode(raw).unwrap_or_else(|e| format!("<{e}>")))
        })
        .collect()
}

pub fn run<'a>(c: &'a mut PgConnection, sql: &'a str, sink: &'a mut dyn RowSink) -> BoxFuture<'a, AppResult<()>> {
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

pub fn describe<'a>(c: &'a mut PgConnection, sql: &'a str) -> BoxFuture<'a, Option<Vec<ColumnInfo>>> {
    Box::pin(async move {
        let d = (&mut *c).describe(sql).await.ok()?;
        Some(d.columns().iter().map(|col| column(col.name(), col.type_info().name())).collect())
    })
}
