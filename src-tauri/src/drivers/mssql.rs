//! Microsoft SQL Server through tiberius (TDS 7.3+). Statements go as SQL
//! batches, so session state (USE, temp tables, SET options) persists.

use futures::TryStreamExt;
use tiberius::{AuthMethod, ColumnData, ColumnType, Config, EncryptionLevel, FromSql, QueryItem};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use super::{column, ConnectParams, Flow, RowSink};
use crate::error::{AppError, AppResult};
use crate::models::{ColumnInfo, Driver};
use crate::sqlscan;

pub type Client = tiberius::Client<Compat<TcpStream>>;

/// Name of the extra result carrying @@ROWCOUNT after DML.
const ROWCOUNT_COL: &str = "helix_rowcount";

pub async fn connect(p: &ConnectParams<'_>) -> AppResult<Client> {
    let mut config = Config::new();
    // "server\instance": a named instance found through SQL Browser
    // (unless an explicit port is given).
    let (host, instance) = match p.endpoint.host.split_once('\\') {
        Some((h, i)) => (h.to_string(), Some(i.to_string())),
        None => (p.endpoint.host.clone(), None),
    };
    config.host(&host);
    let named = instance.is_some() && p.cfg.port == 0;
    if let Some(i) = &instance {
        config.instance_name(i);
    }
    if !named {
        config.port(if p.endpoint.port == 0 { 1433 } else { p.endpoint.port });
    }
    if !p.database.is_empty() {
        config.database(p.database);
    }
    config.application_name("Helix");
    if p.cfg.windows_auth {
        #[cfg(windows)]
        config.authentication(AuthMethod::Integrated);
        #[cfg(not(windows))]
        return Err(AppError::invalid("Windows authentication is only available on Windows"));
    } else {
        config.authentication(AuthMethod::sql_server(&p.cfg.user, p.password.unwrap_or("")));
    }
    // verify-ca / verify-full always validate the certificate.
    if p.cfg.trust_server_certificate && !p.cfg.ssl_mode.starts_with("verify") {
        config.trust_cert();
    }
    config.encryption(match p.cfg.ssl_mode.as_str() {
        "disable" => EncryptionLevel::NotSupported,
        "require" | "verify-ca" | "verify-full" => EncryptionLevel::Required,
        _ => EncryptionLevel::Off,
    });

    let tcp = open_tcp(&config, named).await?;
    match Client::connect(config.clone(), tcp.compat_write()).await {
        Ok(c) => Ok(c),
        // Azure SQL redirects to the node that holds the database.
        Err(tiberius::error::Error::Routing { host, port }) => {
            config.host(&host);
            config.port(port);
            let tcp = open_tcp(&config, false).await?;
            Ok(Client::connect(config, tcp.compat_write()).await?)
        }
        Err(e) => Err(e.into()),
    }
}

async fn open_tcp(config: &Config, named: bool) -> AppResult<TcpStream> {
    let tcp = if named {
        use tiberius::SqlBrowser;
        TcpStream::connect_named(config).await?
    } else {
        TcpStream::connect(config.get_addr()).await.map_err(|e| AppError::Connection(format!("{}: {e}", config.get_addr())))?
    };
    tcp.set_nodelay(true)?;
    Ok(tcp)
}

fn type_name(t: ColumnType) -> &'static str {
    use ColumnType as T;
    match t {
        T::Null => "null",
        T::Bit | T::Bitn => "bit",
        T::Int1 => "tinyint",
        T::Int2 => "smallint",
        T::Int4 | T::Intn => "int",
        T::Int8 => "bigint",
        T::Float4 => "real",
        T::Float8 | T::Floatn => "float",
        T::Money | T::Money4 => "money",
        T::Datetime | T::Datetimen => "datetime",
        T::Datetime4 => "smalldatetime",
        T::Daten => "date",
        T::Timen => "time",
        T::Datetime2 => "datetime2",
        T::DatetimeOffsetn => "datetimeoffset",
        T::Guid => "uniqueidentifier",
        T::Decimaln => "decimal",
        T::Numericn => "numeric",
        T::BigVarBin => "varbinary",
        T::BigBinary => "binary",
        T::BigVarChar => "varchar",
        T::BigChar => "char",
        T::NVarchar => "nvarchar",
        T::NChar => "nchar",
        T::Xml => "xml",
        T::Udt => "udt",
        T::Text => "text",
        T::Image => "image",
        T::NText => "ntext",
        T::SSVariant => "sql_variant",
    }
}

fn fmt_dt(v: Option<chrono::NaiveDateTime>) -> Option<String> {
    v.map(|d| d.format("%Y-%m-%d %H:%M:%S%.f").to_string())
}

/// One value in SQL Server's usual text form.
pub fn cell(data: &ColumnData<'static>) -> Option<String> {
    use ColumnData as D;
    match data {
        D::U8(v) => v.map(|x| x.to_string()),
        D::I16(v) => v.map(|x| x.to_string()),
        D::I32(v) => v.map(|x| x.to_string()),
        D::I64(v) => v.map(|x| x.to_string()),
        D::F32(v) => v.map(|x| x.to_string()),
        D::F64(v) => v.map(|x| x.to_string()),
        D::Bit(v) => v.map(|x| if x { "1".into() } else { "0".into() }),
        D::String(v) => v.as_ref().map(|s| s.to_string()),
        D::Guid(v) => v.map(|g| g.to_string().to_uppercase()),
        D::Binary(v) => v.as_ref().map(|b| super::hex(b, "0x")),
        D::Numeric(v) => v.map(|n| n.to_string()),
        D::Xml(v) => v.as_ref().map(|x| x.to_string()),
        D::DateTime(_) | D::SmallDateTime(_) | D::DateTime2(_) => fmt_dt(chrono::NaiveDateTime::from_sql(data).ok().flatten()),
        D::Date(_) => chrono::NaiveDate::from_sql(data).ok().flatten().map(|d| d.format("%Y-%m-%d").to_string()),
        D::Time(_) => chrono::NaiveTime::from_sql(data).ok().flatten().map(|t| t.format("%H:%M:%S%.f").to_string()),
        D::DateTimeOffset(_) => chrono::DateTime::<chrono::FixedOffset>::from_sql(data)
            .ok()
            .flatten()
            .map(|d| d.format("%Y-%m-%d %H:%M:%S%.f %:z").to_string()),
    }
}

pub async fn run(c: &mut Client, sql: &str, sink: &mut dyn RowSink) -> AppResult<()> {
    let words = sqlscan::top_level_words(sql, Driver::Mssql);
    let dml = matches!(words.first().map(|w| w.text.as_str()), Some("INSERT" | "UPDATE" | "DELETE" | "MERGE"))
        && !words.iter().any(|w| w.text == "OUTPUT");
    // A SQL batch does not report affected rows through tiberius: ask for @@ROWCOUNT.
    let text = if dml { format!("{}\n;SELECT @@ROWCOUNT AS {ROWCOUNT_COL}", sqlscan::trim_statement(sql)) } else { sql.to_string() };

    let mut stream = c.simple_query(text).await?;
    let mut begun = false;
    let mut rowcount_result = false;
    while let Some(item) = stream.try_next().await? {
        match item {
            QueryItem::Metadata(meta) => {
                if begun {
                    sink.end(None)?;
                    begun = false;
                }
                let cols: Vec<ColumnInfo> = meta.columns().iter().map(|c| column(c.name(), type_name(c.column_type()))).collect();
                rowcount_result = dml && cols.len() == 1 && cols[0].name == ROWCOUNT_COL;
                if !rowcount_result {
                    sink.begin(cols)?;
                    begun = true;
                }
            }
            QueryItem::Row(row) => {
                let vals: Vec<Option<String>> = row.into_iter().map(|d| cell(&d)).collect();
                if rowcount_result {
                    let n = vals.first().cloned().flatten().and_then(|v| v.parse::<u64>().ok());
                    sink.begin(Vec::new())?;
                    sink.end(n)?;
                    continue;
                }
                if !begun {
                    sink.begin(Vec::new())?;
                    begun = true;
                }
                if sink.row(vals)? == Flow::Stop {
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
}

pub async fn close(c: Client) {
    let _ = c.close().await;
}
