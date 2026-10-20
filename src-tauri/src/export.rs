//! Data export: a query's full result streamed straight into a file
//! (CSV, TSV, JSON, SQL INSERTs, Markdown, XML, HTML).

use std::fs::File;
use std::io::{BufWriter, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Deserialize;

use crate::drivers::{Flow, RowSink};
use crate::error::{AppError, AppResult};
use crate::models::{ColumnInfo, Driver};
use crate::sqlscan::{quote_ident, quote_lit};

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportOptions {
    /// csv | tsv | json | sql | markdown | xml | html
    pub format: String,
    pub path: String,
    /// CSV delimiter (default ",").
    pub delimiter: String,
    pub header: bool,
    /// Text written for NULL (CSV / TSV / Markdown).
    pub null_text: String,
    pub quote_all: bool,
    /// Target table of INSERT statements.
    pub table_name: String,
    /// Rows per INSERT statement (SQL format).
    pub batch_size: usize,
    /// Write a UTF-8 byte order mark (Excel opens such CSV files correctly).
    pub bom: bool,
}

impl Default for ExportOptions {
    fn default() -> Self {
        ExportOptions {
            format: "csv".into(),
            path: String::new(),
            delimiter: ",".into(),
            header: true,
            null_text: String::new(),
            quote_all: false,
            table_name: "exported".into(),
            batch_size: 1,
            bom: false,
        }
    }
}

pub struct FileSink {
    w: BufWriter<File>,
    o: ExportOptions,
    driver: Driver,
    columns: Vec<ColumnInfo>,
    started: bool,
    /// Only the first result set is exported.
    done: bool,
    pub rows: u64,
    pending: Vec<String>,
    cancel: Arc<AtomicBool>,
    progress: Box<dyn FnMut(u64) + Send>,
}

impl FileSink {
    pub fn create(o: ExportOptions, driver: Driver, cancel: Arc<AtomicBool>, progress: Box<dyn FnMut(u64) + Send>) -> AppResult<Self> {
        if o.path.trim().is_empty() {
            return Err(AppError::invalid("Choose a file to export to"));
        }
        let mut w = BufWriter::with_capacity(256 * 1024, File::create(&o.path)?);
        if o.bom {
            w.write_all(b"\xEF\xBB\xBF")?;
        }
        Ok(FileSink { w, o, driver, columns: Vec::new(), started: false, done: false, rows: 0, pending: Vec::new(), cancel, progress })
    }

    fn csv_field(&self, v: &Option<String>, delim: &str) -> String {
        match v {
            None => self.o.null_text.clone(),
            Some(s) => {
                if self.o.quote_all || s.contains(delim) || s.contains('"') || s.contains('\n') || s.contains('\r') {
                    format!("\"{}\"", s.replace('"', "\"\""))
                } else {
                    s.clone()
                }
            }
        }
    }

    fn sql_value(&self, v: &Option<String>, col: &ColumnInfo) -> String {
        match v {
            None => "NULL".into(),
            Some(s) if col.kind == "number" && s.parse::<f64>().is_ok() => s.clone(),
            Some(s) if col.kind == "binary" && s.starts_with("0x") => match self.driver {
                Driver::Sqlite => format!("X'{}'", &s[2..]),
                Driver::Postgres => format!("'\\x{}'", &s[2..]),
                _ => s.clone(),
            },
            Some(s) => quote_lit(self.driver, s),
        }
    }

    fn json_value(v: &Option<String>, col: &ColumnInfo) -> String {
        match v {
            None => "null".into(),
            Some(s) if col.kind == "number" && s.parse::<f64>().map(|f| f.is_finite()).unwrap_or(false) && !s.starts_with('+') => s.clone(),
            Some(s) if col.kind == "bool" => match s.as_str() {
                "t" | "true" | "1" => "true".into(),
                "f" | "false" | "0" => "false".into(),
                _ => serde_json::to_string(s).unwrap_or_default(),
            },
            Some(s) if col.kind == "json" && serde_json::from_str::<serde_json::Value>(s).is_ok() => s.clone(),
            Some(s) => serde_json::to_string(s).unwrap_or_default(),
        }
    }

    fn header(&mut self) -> AppResult<()> {
        let names: Vec<String> = self.columns.iter().map(|c| c.name.clone()).collect();
        match self.o.format.as_str() {
            "csv" | "tsv" => {
                if self.o.header {
                    let d = self.delim();
                    let line: Vec<String> = names.iter().map(|n| self.csv_field(&Some(n.clone()), &d)).collect();
                    writeln!(self.w, "{}", line.join(&d))?;
                }
            }
            "json" => write!(self.w, "[")?,
            "markdown" => {
                writeln!(self.w, "| {} |", names.iter().map(|n| md(n)).collect::<Vec<_>>().join(" | "))?;
                writeln!(self.w, "|{}", names.iter().map(|_| " --- |").collect::<String>())?;
            }
            "xml" => writeln!(self.w, "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<rows>")?,
            "html" => {
                writeln!(
                    self.w,
                    "<!doctype html>\n<html><head><meta charset=\"utf-8\"><title>{}</title>\
                     <style>body{{font:13px system-ui,sans-serif}}table{{border-collapse:collapse}}th,td{{border:1px solid #ccc;padding:4px 8px;text-align:left}}th{{background:#f3f3f3}}</style>\
                     </head><body>\n<table>\n<tr>{}</tr>",
                    xml(&self.o.table_name),
                    names.iter().map(|n| format!("<th>{}</th>", xml(n))).collect::<String>()
                )?;
            }
            _ => {}
        }
        Ok(())
    }

    fn delim(&self) -> String {
        if self.o.format == "tsv" {
            "\t".into()
        } else if self.o.delimiter.is_empty() {
            ",".into()
        } else {
            self.o.delimiter.clone()
        }
    }

    fn flush_inserts(&mut self) -> AppResult<()> {
        if self.pending.is_empty() {
            return Ok(());
        }
        let table = self.o.table_name.split('.').map(|p| quote_ident(self.driver, p)).collect::<Vec<_>>().join(".");
        let cols = self.columns.iter().map(|c| quote_ident(self.driver, &c.name)).collect::<Vec<_>>().join(", ");
        writeln!(self.w, "INSERT INTO {table} ({cols}) VALUES\n{};", self.pending.join(",\n"))?;
        self.pending.clear();
        Ok(())
    }

    /// Writes the closing part of the file.
    pub fn finish(mut self) -> AppResult<u64> {
        if !self.started {
            self.header()?;
        }
        match self.o.format.as_str() {
            "json" => writeln!(self.w, "{}]", if self.rows > 0 { "\n" } else { "" })?,
            "xml" => writeln!(self.w, "</rows>")?,
            "html" => writeln!(self.w, "</table>\n</body></html>")?,
            "sql" => self.flush_inserts()?,
            _ => {}
        }
        self.w.flush()?;
        Ok(self.rows)
    }
}

fn md(s: &str) -> String {
    s.replace('|', "\\|").replace(['\n', '\r'], " ")
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

impl RowSink for FileSink {
    fn begin(&mut self, columns: Vec<ColumnInfo>) -> AppResult<()> {
        if !self.started && !columns.is_empty() {
            self.columns = columns;
            self.started = true;
            self.header()?;
        }
        Ok(())
    }

    fn row(&mut self, row: Vec<Option<String>>) -> AppResult<Flow> {
        if self.done {
            return Ok(Flow::Stop);
        }
        if self.cancel.load(Ordering::Relaxed) {
            return Err(AppError::Cancelled);
        }
        match self.o.format.as_str() {
            "csv" | "tsv" => {
                let d = self.delim();
                let line: Vec<String> = row.iter().map(|v| self.csv_field(v, &d)).collect();
                writeln!(self.w, "{}", line.join(&d))?;
            }
            "json" => {
                let fields: Vec<String> = self
                    .columns
                    .iter()
                    .zip(&row)
                    .map(|(c, v)| format!("{}: {}", serde_json::to_string(&c.name).unwrap_or_default(), Self::json_value(v, c)))
                    .collect();
                write!(self.w, "{}\n  {{{}}}", if self.rows > 0 { "," } else { "" }, fields.join(", "))?;
            }
            "sql" => {
                let vals: Vec<String> = self.columns.iter().zip(&row).map(|(c, v)| self.sql_value(v, c)).collect();
                self.pending.push(format!("\t({})", vals.join(", ")));
                if self.pending.len() >= self.o.batch_size.max(1) {
                    self.flush_inserts()?;
                }
            }
            "markdown" => {
                let cells: Vec<String> = row.iter().map(|v| v.as_deref().map(md).unwrap_or_else(|| self.o.null_text.clone())).collect();
                writeln!(self.w, "| {} |", cells.join(" | "))?;
            }
            "xml" => {
                writeln!(self.w, "  <row>")?;
                for (c, v) in self.columns.iter().zip(&row) {
                    match v {
                        None => writeln!(self.w, "    <column name=\"{}\" null=\"true\"/>", xml(&c.name))?,
                        Some(s) => writeln!(self.w, "    <column name=\"{}\">{}</column>", xml(&c.name), xml(s))?,
                    }
                }
                writeln!(self.w, "  </row>")?;
            }
            "html" => {
                let cells: String = row.iter().map(|v| format!("<td>{}</td>", v.as_deref().map(xml).unwrap_or_default())).collect();
                writeln!(self.w, "<tr>{cells}</tr>")?;
            }
            other => return Err(AppError::invalid(format!("Unknown export format {other}"))),
        }
        self.rows += 1;
        if self.rows % 2000 == 0 {
            (self.progress)(self.rows);
        }
        Ok(Flow::Continue)
    }

    fn end(&mut self, _rows_affected: Option<u64>) -> AppResult<()> {
        if self.started {
            self.done = true;
        }
        Ok(())
    }
}
