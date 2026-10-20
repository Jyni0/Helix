//! Database metadata: databases, schemas, objects, table structure, DDL,
//! schema-wide models (ER diagram / autocomplete) and server sessions —
//! read from each server's catalog.

use std::collections::BTreeMap;

use crate::drivers::Conn;
use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::sqlscan::{quote_ident, quote_lit};


/// Typed access to a text row.
trait RowExt {
    fn s(&self, i: usize) -> String;
    fn o(&self, i: usize) -> Option<String>;
    fn b(&self, i: usize) -> bool;
    fn n(&self, i: usize) -> Option<i64>;
    fn list(&self, i: usize) -> Vec<String>;
}

impl RowExt for Vec<Option<String>> {
    fn s(&self, i: usize) -> String {
        self.get(i).cloned().flatten().unwrap_or_default()
    }
    fn o(&self, i: usize) -> Option<String> {
        self.get(i).cloned().flatten().filter(|v| !v.is_empty())
    }
    fn b(&self, i: usize) -> bool {
        matches!(self.s(i).to_ascii_lowercase().as_str(), "t" | "true" | "1" | "yes" | "y" | "on")
    }
    fn n(&self, i: usize) -> Option<i64> {
        self.o(i).and_then(|v| v.split('.').next().and_then(|x| x.parse().ok()))
    }
    /// A JSON array of strings (from json_agg / json_group_array).
    fn list(&self, i: usize) -> Vec<String> {
        self.o(i).and_then(|v| serde_json::from_str::<Vec<Option<String>>>(&v).ok()).unwrap_or_default().into_iter().flatten().collect()
    }
}

fn pg_action(code: &str) -> Option<String> {
    Some(
        match code {
            "a" => "NO ACTION",
            "r" => "RESTRICT",
            "c" => "CASCADE",
            "n" => "SET NULL",
            "d" => "SET DEFAULT",
            _ => return None,
        }
        .to_string(),
    )
}

fn mssql_action(desc: Option<String>) -> Option<String> {
    desc.map(|d| d.replace('_', " "))
}

/// "nvarchar(50)", "decimal(10,2)", "varchar(max)"…
fn mssql_type(name: &str, max_length: i64, precision: i64, scale: i64) -> String {
    match name {
        "varchar" | "char" | "varbinary" | "binary" => {
            if max_length == -1 {
                format!("{name}(max)")
            } else {
                format!("{name}({max_length})")
            }
        }
        "nvarchar" | "nchar" => {
            if max_length == -1 {
                format!("{name}(max)")
            } else {
                format!("{name}({})", max_length / 2)
            }
        }
        "decimal" | "numeric" => format!("{name}({precision},{scale})"),
        "datetime2" | "time" | "datetimeoffset" => format!("{name}({scale})"),
        _ => name.to_string(),
    }
}

fn mssql_prefix(db: &str) -> String {
    if db.is_empty() {
        String::new()
    } else {
        format!("{}.", quote_ident(Driver::Mssql, db))
    }
}

fn mssql_oid(db: &str, schema: &str, name: &str) -> String {
    let full = if db.is_empty() {
        format!("{}.{}", quote_ident(Driver::Mssql, schema), quote_ident(Driver::Mssql, name))
    } else {
        format!("{}.{}.{}", quote_ident(Driver::Mssql, db), quote_ident(Driver::Mssql, schema), quote_ident(Driver::Mssql, name))
    };
    format!("OBJECT_ID({})", quote_lit(Driver::Mssql, &full))
}

fn pg_oid(schema: &str, table: &str) -> String {
    format!(
        "(SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = {} AND c.relname = {})",
        quote_lit(Driver::Postgres, schema),
        quote_lit(Driver::Postgres, table)
    )
}

// ---------------------------------------------------------------- databases

pub async fn list_databases(c: &mut Conn) -> AppResult<Vec<DatabaseInfo>> {
    let (sql, sys_col): (&str, bool) = match c.driver() {
        Driver::Postgres => ("SELECT datname, false FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname", true),
        Driver::Mysql => (
            "SELECT SCHEMA_NAME, SCHEMA_NAME IN ('information_schema','mysql','performance_schema','sys') FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME",
            true,
        ),
        Driver::Sqlite => ("SELECT name, 0 FROM pragma_database_list ORDER BY seq", true),
        Driver::Mssql => (
            "SELECT name, CASE WHEN database_id <= 4 THEN 1 ELSE 0 END FROM sys.databases WHERE state = 0 AND HAS_DBACCESS(name) = 1 ORDER BY name",
            true,
        ),
    };
    Ok(c.query_rows(sql).await?.into_iter().map(|r| DatabaseInfo { name: r.s(0), system: sys_col && r.b(1) }).collect())
}

pub async fn list_schemas(c: &mut Conn, db: &str) -> AppResult<Vec<SchemaInfo>> {
    let sql = match c.driver() {
        Driver::Postgres => "SELECT nspname, (nspname IN ('pg_catalog','information_schema') OR nspname LIKE 'pg\\_%') AS sys \
             FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp\\_%' \
             ORDER BY 2, nspname"
            .to_string(),
        Driver::Mssql => format!(
            "SELECT s.name, CASE WHEN s.name IN ('sys','INFORMATION_SCHEMA','guest') OR s.name LIKE 'db[_]%' THEN 1 ELSE 0 END AS sys \
             FROM {}sys.schemas s ORDER BY 2, s.name",
            mssql_prefix(db)
        ),
        // MySQL databases are schemas; SQLite has none.
        Driver::Mysql | Driver::Sqlite => return Ok(Vec::new()),
    };
    Ok(c.query_rows(&sql).await?.into_iter().map(|r| SchemaInfo { name: r.s(0), system: r.b(1) }).collect())
}

// ---------------------------------------------------------------- objects

fn obj(name: String, kind: &'static str) -> DbObject {
    DbObject { name, kind, comment: None, rows: None, signature: None, parent: None }
}

pub async fn list_objects(c: &mut Conn, db: &str, schema: Option<&str>) -> AppResult<Vec<DbObject>> {
    let d = c.driver();
    let mut out = Vec::new();
    match d {
        Driver::Postgres => {
            let s = quote_lit(d, schema.unwrap_or("public"));
            let rels = c
                .query_rows(&format!(
                    "SELECT c.relname, c.relkind, obj_description(c.oid, 'pg_class'), c.reltuples::bigint \
                     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                     WHERE n.nspname = {s} AND c.relkind IN ('r','p','v','m','f','S') AND NOT c.relispartition ORDER BY c.relname"
                ))
                .await?;
            for r in rels {
                let kind = match r.s(1).as_str() {
                    "r" | "p" => "table",
                    "v" => "view",
                    "m" => "matview",
                    "f" => "foreign",
                    _ => "sequence",
                };
                let mut o = obj(r.s(0), kind);
                o.comment = r.o(2);
                o.rows = r.n(3).filter(|n| *n >= 0 && kind == "table");
                out.push(o);
            }
            let procs = c
                .query_rows(&format!(
                    "SELECT p.proname, pg_get_function_identity_arguments(p.oid), p.prokind, obj_description(p.oid, 'pg_proc') \
                     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
                     WHERE n.nspname = {s} AND p.prokind IN ('f','p') \
                     AND NOT EXISTS (SELECT 1 FROM pg_depend dep WHERE dep.objid = p.oid AND dep.deptype = 'e') ORDER BY 1, 2"
                ))
                .await?;
            for r in procs {
                let mut o = obj(r.s(0), if r.s(2) == "p" { "procedure" } else { "function" });
                o.signature = Some(r.s(1));
                o.comment = r.o(3);
                out.push(o);
            }
            let trg = c
                .query_rows(&format!(
                    "SELECT t.tgname, c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid \
                     JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = {s} AND NOT t.tgisinternal ORDER BY 1"
                ))
                .await?;
            for r in trg {
                let mut o = obj(r.s(0), "trigger");
                o.parent = r.o(1);
                out.push(o);
            }
        }
        Driver::Mysql => {
            let s = quote_lit(d, db);
            for r in c
                .query_rows(&format!(
                    "SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = {s} ORDER BY TABLE_NAME"
                ))
                .await?
            {
                let view = r.s(1).contains("VIEW");
                let mut o = obj(r.s(0), if view { "view" } else { "table" });
                o.comment = if view { None } else { r.o(2) };
                o.rows = if view { None } else { r.n(3) };
                out.push(o);
            }
            for r in c
                .query_rows(&format!(
                    "SELECT ROUTINE_NAME, ROUTINE_TYPE, ROUTINE_COMMENT FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = {s} ORDER BY ROUTINE_NAME"
                ))
                .await?
            {
                let mut o = obj(r.s(0), if r.s(1) == "PROCEDURE" { "procedure" } else { "function" });
                o.comment = r.o(2);
                out.push(o);
            }
            for r in c
                .query_rows(&format!(
                    "SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = {s} ORDER BY TRIGGER_NAME"
                ))
                .await?
            {
                let mut o = obj(r.s(0), "trigger");
                o.parent = r.o(1);
                out.push(o);
            }
        }
        Driver::Sqlite => {
            let q = quote_ident(d, if db.is_empty() { "main" } else { db });
            for r in c.query_rows(&format!("SELECT name, type, tbl_name FROM {q}.sqlite_master WHERE type IN ('table','view','trigger') ORDER BY name")).await? {
                let kind = match r.s(1).as_str() {
                    "view" => "view",
                    "trigger" => "trigger",
                    _ => "table",
                };
                let mut o = obj(r.s(0), kind);
                if kind == "trigger" {
                    o.parent = r.o(2);
                }
                out.push(o);
            }
        }
        Driver::Mssql => {
            let p = mssql_prefix(db);
            let s = quote_lit(d, schema.unwrap_or("dbo"));
            let dbid = if db.is_empty() { "DB_ID()".to_string() } else { format!("DB_ID({})", quote_lit(d, db)) };
            for r in c
                .query_rows(&format!(
                    "SELECT o.name, RTRIM(o.type), CAST(ep.value AS nvarchar(4000)), \
                     (SELECT SUM(pt.rows) FROM {p}sys.partitions pt WHERE pt.object_id = o.object_id AND pt.index_id IN (0,1)), \
                     OBJECT_NAME(o.parent_object_id, {dbid}) \
                     FROM {p}sys.objects o JOIN {p}sys.schemas s ON s.schema_id = o.schema_id \
                     LEFT JOIN {p}sys.extended_properties ep ON ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.class = 1 AND ep.name = 'MS_Description' \
                     WHERE s.name = {s} AND o.type IN ('U','V','P','FN','IF','TF','SO','TR') AND o.is_ms_shipped = 0 ORDER BY o.name"
                ))
                .await?
            {
                let kind = match r.s(1).as_str() {
                    "U" => "table",
                    "V" => "view",
                    "P" => "procedure",
                    "SO" => "sequence",
                    "TR" => "trigger",
                    _ => "function",
                };
                let mut o = obj(r.s(0), kind);
                o.comment = r.o(2);
                if kind == "table" {
                    o.rows = r.n(3);
                }
                if kind == "trigger" {
                    o.parent = r.o(4);
                }
                out.push(o);
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------- table info

pub async fn table_info(c: &mut Conn, db: &str, schema: Option<&str>, table: &str) -> AppResult<TableInfo> {
    let info = match c.driver() {
        Driver::Postgres => pg_table(c, schema.unwrap_or("public"), table).await?,
        Driver::Mysql => mysql_table(c, db, table).await?,
        Driver::Sqlite => sqlite_table(c, if db.is_empty() { "main" } else { db }, table).await?,
        Driver::Mssql => mssql_table(c, db, schema.unwrap_or("dbo"), table).await?,
    };
    if info.columns.is_empty() {
        return Err(AppError::NotFound(format!("table {table}")));
    }
    Ok(info)
}

async fn pg_table(c: &mut Conn, schema: &str, table: &str) -> AppResult<TableInfo> {
    let oid = pg_oid(schema, table);
    let mut t = TableInfo { name: table.to_string(), ..Default::default() };

    let pk: Vec<String> = c
        .query_rows(&format!(
            "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) \
             WHERE i.indrelid = {oid} AND i.indisprimary ORDER BY array_position(i.indkey::int2[], a.attnum)"
        ))
        .await?
        .into_iter()
        .map(|r| r.s(0))
        .collect();
    for r in c
        .query_rows(&format!(
            "SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, pg_get_expr(ad.adbin, ad.adrelid), \
             col_description(a.attrelid, a.attnum), a.attidentity \
             FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
             WHERE a.attrelid = {oid} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum"
        ))
        .await?
    {
        let default_value = r.o(3);
        let identity = r.o(5);
        t.columns.push(ColumnDef {
            primary_key: pk.contains(&r.s(0)),
            auto_increment: identity.is_some() || default_value.as_deref().is_some_and(|v| v.starts_with("nextval(")),
            name: r.s(0),
            data_type: r.s(1),
            nullable: r.b(2),
            default_value,
            comment: r.o(4),
        });
    }
    t.primary_key = pk;

    for r in c
        .query_rows(&format!(
            "SELECT ic.relname, ix.indisunique, ix.indisprimary, am.amname, pg_get_indexdef(ix.indexrelid), \
             (SELECT json_agg(pg_get_indexdef(ix.indexrelid, k, true) ORDER BY k) FROM generate_series(1, ix.indnatts) k)::text \
             FROM pg_index ix JOIN pg_class ic ON ic.oid = ix.indexrelid JOIN pg_am am ON am.oid = ic.relam \
             WHERE ix.indrelid = {oid} ORDER BY ix.indisprimary DESC, ic.relname"
        ))
        .await?
    {
        t.indexes.push(IndexDef { name: r.s(0), unique: r.b(1), primary: r.b(2), method: r.o(3), definition: r.o(4), columns: r.list(5) });
    }

    let cols_of = |rel: &str, keys: &str| {
        format!(
            "(SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(con.{keys}) WITH ORDINALITY k(n, ord) \
             JOIN pg_attribute a ON a.attrelid = con.{rel} AND a.attnum = k.n)::text"
        )
    };
    for r in c
        .query_rows(&format!(
            "SELECT con.conname, {}, fn.nspname, fc.relname, {}, con.confupdtype, con.confdeltype \
             FROM pg_constraint con JOIN pg_class fc ON fc.oid = con.confrelid JOIN pg_namespace fn ON fn.oid = fc.relnamespace \
             WHERE con.contype = 'f' AND con.conrelid = {oid} ORDER BY con.conname",
            cols_of("conrelid", "conkey"),
            cols_of("confrelid", "confkey")
        ))
        .await?
    {
        t.foreign_keys.push(ForeignKeyDef {
            name: r.s(0),
            columns: r.list(1),
            ref_schema: r.o(2),
            ref_table: r.s(3),
            ref_columns: r.list(4),
            on_update: pg_action(&r.s(5)),
            on_delete: pg_action(&r.s(6)),
        });
    }
    for r in c
        .query_rows(&format!(
            "SELECT con.conname, sn.nspname, sc.relname, {}, {} \
             FROM pg_constraint con JOIN pg_class sc ON sc.oid = con.conrelid JOIN pg_namespace sn ON sn.oid = sc.relnamespace \
             WHERE con.contype = 'f' AND con.confrelid = {oid} ORDER BY sc.relname, con.conname",
            cols_of("conrelid", "conkey"),
            cols_of("confrelid", "confkey")
        ))
        .await?
    {
        t.references.push(ReferenceDef { name: r.s(0), schema: r.o(1), table: r.s(2), columns: r.list(3), ref_columns: r.list(4) });
    }
    for r in c
        .query_rows(&format!(
            "SELECT con.conname, con.contype, pg_get_constraintdef(con.oid, true) FROM pg_constraint con \
             WHERE con.conrelid = {oid} AND con.contype IN ('c','u','x') ORDER BY con.conname"
        ))
        .await?
    {
        let kind = match r.s(1).as_str() {
            "c" => "check",
            "u" => "unique",
            _ => "exclude",
        };
        t.constraints.push(ConstraintDef { name: r.s(0), kind: kind.into(), definition: r.s(2) });
    }
    for r in c
        .query_rows(&format!(
            "SELECT t.tgname, pg_get_triggerdef(t.oid, true) FROM pg_trigger t WHERE t.tgrelid = {oid} AND NOT t.tgisinternal ORDER BY 1"
        ))
        .await?
    {
        let def = r.s(1);
        let event = def.split_whitespace().skip_while(|w| !matches!(*w, "BEFORE" | "AFTER" | "INSTEAD")).take_while(|w| *w != "ON").collect::<Vec<_>>().join(" ");
        t.triggers.push(TriggerDef { name: r.s(0), event: Some(event).filter(|e| !e.is_empty()), definition: Some(def) });
    }
    if let Some(r) = c
        .query_rows(&format!(
            "SELECT c.relkind, obj_description(c.oid, 'pg_class'), c.reltuples::bigint, pg_size_pretty(pg_total_relation_size(c.oid)), \
             pg_size_pretty(pg_relation_size(c.oid)), pg_get_userbyid(c.relowner), ts.spcname, c.relpersistence \
             FROM pg_class c LEFT JOIN pg_tablespace ts ON ts.oid = c.reltablespace WHERE c.oid = {oid}"
        ))
        .await?
        .into_iter()
        .next()
    {
        t.kind = match r.s(0).as_str() {
            "r" => "table",
            "p" => "partitioned table",
            "v" => "view",
            "m" => "materialized view",
            "f" => "foreign table",
            _ => "relation",
        }
        .into();
        t.comment = r.o(1);
        let mut props = vec![("Type".to_string(), t.kind.clone())];
        if let Some(n) = r.n(2).filter(|n| *n >= 0) {
            props.push(("Estimated rows".into(), n.to_string()));
        }
        props.push(("Total size".into(), r.s(3)));
        props.push(("Table size".into(), r.s(4)));
        props.push(("Owner".into(), r.s(5)));
        props.push(("Tablespace".into(), r.o(6).unwrap_or_else(|| "pg_default".into())));
        props.push((
            "Persistence".into(),
            match r.s(7).as_str() {
                "u" => "unlogged",
                "t" => "temporary",
                _ => "permanent",
            }
            .into(),
        ));
        t.properties = props;
    }
    Ok(t)
}

async fn mysql_table(c: &mut Conn, db: &str, table: &str) -> AppResult<TableInfo> {
    let d = Driver::Mysql;
    let (s, tn) = (quote_lit(d, db), quote_lit(d, table));
    let mut t = TableInfo { name: table.to_string(), ..Default::default() };
    for r in c
        .query_rows(&format!(
            "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT, COLUMN_KEY, EXTRA \
             FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = {s} AND TABLE_NAME = {tn} ORDER BY ORDINAL_POSITION"
        ))
        .await?
    {
        t.columns.push(ColumnDef {
            name: r.s(0),
            data_type: r.s(1),
            nullable: r.b(2),
            default_value: r.get(3).cloned().flatten(),
            comment: r.o(4),
            primary_key: r.s(5) == "PRI",
            auto_increment: r.s(6).contains("auto_increment"),
        });
    }
    let mut idx: Vec<IndexDef> = Vec::new();
    for r in c
        .query_rows(&format!(
            "SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, INDEX_TYPE FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = {s} AND TABLE_NAME = {tn} ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX"
        ))
        .await?
    {
        let name = r.s(0);
        if idx.last().map(|i| i.name != name).unwrap_or(true) {
            idx.push(IndexDef { primary: name == "PRIMARY", unique: !r.b(1), method: r.o(3), name: name.clone(), ..Default::default() });
        }
        idx.last_mut().unwrap().columns.push(r.o(2).unwrap_or_else(|| "(expression)".into()));
    }
    t.primary_key = idx.iter().find(|i| i.primary).map(|i| i.columns.clone()).unwrap_or_default();
    t.indexes = idx;

    let fk_sql = |filter: &str| {
        format!(
            "SELECT k.CONSTRAINT_NAME, k.TABLE_SCHEMA, k.TABLE_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, \
             k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE \
             FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r \
             ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME \
             WHERE {filter} AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION"
        )
    };
    for r in c.query_rows(&fk_sql(&format!("k.TABLE_SCHEMA = {s} AND k.TABLE_NAME = {tn}"))).await? {
        let name = r.s(0);
        if t.foreign_keys.last().map(|f| f.name != name).unwrap_or(true) {
            t.foreign_keys.push(ForeignKeyDef {
                name: name.clone(),
                ref_schema: r.o(4),
                ref_table: r.s(5),
                on_update: r.o(7),
                on_delete: r.o(8),
                ..Default::default()
            });
        }
        let fk = t.foreign_keys.last_mut().unwrap();
        fk.columns.push(r.s(3));
        fk.ref_columns.push(r.s(6));
    }
    for r in c.query_rows(&fk_sql(&format!("k.REFERENCED_TABLE_SCHEMA = {s} AND k.REFERENCED_TABLE_NAME = {tn}"))).await? {
        let (name, table) = (r.s(0), r.s(2));
        if t.references.last().map(|f| f.name != name || f.table != table).unwrap_or(true) {
            t.references.push(ReferenceDef { name, schema: r.o(1), table, ..Default::default() });
        }
        let rf = t.references.last_mut().unwrap();
        rf.columns.push(r.s(3));
        rf.ref_columns.push(r.s(6));
    }
    for r in c
        .query_rows(&format!(
            "SELECT TRIGGER_NAME, CONCAT(ACTION_TIMING, ' ', EVENT_MANIPULATION), ACTION_STATEMENT FROM information_schema.TRIGGERS \
             WHERE EVENT_OBJECT_SCHEMA = {s} AND EVENT_OBJECT_TABLE = {tn} ORDER BY TRIGGER_NAME"
        ))
        .await?
    {
        t.triggers.push(TriggerDef { name: r.s(0), event: r.o(1), definition: r.o(2) });
    }
    // CHECK constraints exist from MySQL 8.0.16 / MariaDB 10.2.
    if let Ok(rows) = c
        .query_rows(&format!(
            "SELECT cc.CONSTRAINT_NAME, cc.CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS cc \
             JOIN information_schema.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME \
             WHERE tc.TABLE_SCHEMA = {s} AND tc.TABLE_NAME = {tn} AND tc.CONSTRAINT_TYPE = 'CHECK'"
        ))
        .await
    {
        for r in rows {
            t.constraints.push(ConstraintDef { name: r.s(0), kind: "check".into(), definition: r.s(1) });
        }
    }
    for i in t.indexes.iter().filter(|i| i.unique && !i.primary) {
        t.constraints.push(ConstraintDef { name: i.name.clone(), kind: "unique".into(), definition: format!("UNIQUE ({})", i.columns.join(", ")) });
    }
    if let Some(r) = c
        .query_rows(&format!(
            "SELECT TABLE_TYPE, ENGINE, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, AUTO_INCREMENT, TABLE_COLLATION, CREATE_TIME, UPDATE_TIME, TABLE_COMMENT \
             FROM information_schema.TABLES WHERE TABLE_SCHEMA = {s} AND TABLE_NAME = {tn}"
        ))
        .await?
        .into_iter()
        .next()
    {
        let view = r.s(0).contains("VIEW");
        t.kind = if view { "view".into() } else { "table".into() };
        t.comment = if view { None } else { r.o(9) };
        let mut props = vec![("Type".to_string(), r.s(0))];
        let mut add = |k: &str, v: Option<String>| {
            if let Some(v) = v {
                props.push((k.to_string(), v));
            }
        };
        add("Engine", r.o(1));
        add("Estimated rows", r.o(2));
        add("Data size", r.n(3).map(human_bytes));
        add("Index size", r.n(4).map(human_bytes));
        add("Auto increment", r.o(5));
        add("Collation", r.o(6));
        add("Created", r.o(7));
        add("Updated", r.o(8));
        t.properties = props;
    }
    Ok(t)
}

async fn sqlite_table(c: &mut Conn, db: &str, table: &str) -> AppResult<TableInfo> {
    let d = Driver::Sqlite;
    let (dl, dq, tn) = (quote_lit(d, db), quote_ident(d, db), quote_lit(d, table));
    let mut t = TableInfo { name: table.to_string(), ..Default::default() };
    let create_sql = c.query_value(&format!("SELECT sql FROM {dq}.sqlite_master WHERE name = {tn} AND type IN ('table','view')")).await?.unwrap_or_default();
    let autoinc = create_sql.to_ascii_uppercase().contains("AUTOINCREMENT");
    let mut pk: Vec<(i64, String)> = Vec::new();
    for r in c.query_rows(&format!("SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info({tn}, {dl}) ORDER BY cid")).await? {
        let pk_pos = r.n(4).unwrap_or(0);
        if pk_pos > 0 {
            pk.push((pk_pos, r.s(0)));
        }
        t.columns.push(ColumnDef {
            name: r.s(0),
            data_type: r.s(1),
            nullable: !r.b(2),
            default_value: r.o(3),
            primary_key: pk_pos > 0,
            auto_increment: pk_pos > 0 && (autoinc || r.s(1).eq_ignore_ascii_case("integer")),
            comment: None,
        });
    }
    pk.sort();
    t.primary_key = pk.into_iter().map(|(_, n)| n).collect();
    if t.primary_key.len() > 1 {
        for col in &mut t.columns {
            col.auto_increment = false;
        }
    }
    for r in c
        .query_rows(&format!(
            "SELECT il.name, il.\"unique\", il.origin, \
             (SELECT json_group_array(name) FROM (SELECT ii.name FROM pragma_index_info(il.name, {dl}) ii ORDER BY ii.seqno)), \
             (SELECT m.sql FROM {dq}.sqlite_master m WHERE m.type = 'index' AND m.name = il.name) \
             FROM pragma_index_list({tn}, {dl}) il ORDER BY il.origin = 'pk' DESC, il.name"
        ))
        .await?
    {
        t.indexes.push(IndexDef {
            name: r.s(0),
            unique: r.b(1),
            primary: r.s(2) == "pk",
            method: None,
            columns: r.list(3),
            definition: r.o(4),
        });
    }
    let mut fks: BTreeMap<i64, ForeignKeyDef> = BTreeMap::new();
    for r in c
        .query_rows(&format!(
            "SELECT id, \"table\", \"from\", \"to\", on_update, on_delete FROM pragma_foreign_key_list({tn}, {dl}) ORDER BY id, seq"
        ))
        .await?
    {
        let fk = fks.entry(r.n(0).unwrap_or(0)).or_insert_with(|| ForeignKeyDef {
            name: String::new(),
            ref_table: r.s(1),
            on_update: r.o(4),
            on_delete: r.o(5),
            ..Default::default()
        });
        fk.columns.push(r.s(2));
        fk.ref_columns.push(r.o(3).unwrap_or_default());
    }
    for (_, mut fk) in fks {
        fk.name = format!("fk_{}_{}", table, fk.ref_table);
        t.foreign_keys.push(fk);
    }
    let mut refs: BTreeMap<(String, i64), ReferenceDef> = BTreeMap::new();
    for r in c
        .query_rows(&format!(
            "SELECT m.name, f.id, f.\"from\", f.\"to\" FROM {dq}.sqlite_master m JOIN pragma_foreign_key_list(m.name, {dl}) f \
             WHERE m.type = 'table' AND f.\"table\" = {tn} COLLATE NOCASE ORDER BY m.name, f.id, f.seq"
        ))
        .await?
    {
        let rf = refs.entry((r.s(0), r.n(1).unwrap_or(0))).or_insert_with(|| ReferenceDef {
            name: format!("fk_{}_{}", r.s(0), table),
            table: r.s(0),
            ..Default::default()
        });
        rf.columns.push(r.s(2));
        rf.ref_columns.push(r.o(3).unwrap_or_default());
    }
    t.references = refs.into_values().collect();
    for r in c.query_rows(&format!("SELECT name, sql FROM {dq}.sqlite_master WHERE type = 'trigger' AND tbl_name = {tn} ORDER BY name")).await? {
        let def = r.s(1);
        let up = def.to_ascii_uppercase();
        let timing = ["BEFORE", "AFTER", "INSTEAD OF"].into_iter().find(|w| up.contains(w));
        let event = ["INSERT", "UPDATE", "DELETE"].into_iter().find(|w| up.contains(&format!(" {w}")));
        t.triggers.push(TriggerDef {
            name: r.s(0),
            event: Some([timing.unwrap_or(""), event.unwrap_or("")].join(" ").trim().to_string()).filter(|e| !e.is_empty()),
            definition: Some(def),
        });
    }
    let kind = c.query_value(&format!("SELECT type FROM {dq}.sqlite_master WHERE name = {tn}")).await?.unwrap_or_else(|| "table".into());
    t.kind = kind.clone();
    t.properties = vec![("Type".into(), kind)];
    if create_sql.to_ascii_uppercase().contains("WITHOUT ROWID") {
        t.properties.push(("Rowid".into(), "WITHOUT ROWID".into()));
    }
    for i in t.indexes.iter().filter(|i| i.unique && !i.primary) {
        t.constraints.push(ConstraintDef { name: i.name.clone(), kind: "unique".into(), definition: format!("UNIQUE ({})", i.columns.join(", ")) });
    }
    Ok(t)
}

async fn mssql_table(c: &mut Conn, db: &str, schema: &str, table: &str) -> AppResult<TableInfo> {
    let p = mssql_prefix(db);
    let oid = mssql_oid(db, schema, table);
    let mut t = TableInfo { name: table.to_string(), ..Default::default() };
    let mut idx: Vec<IndexDef> = Vec::new();
    for r in c
        .query_rows(&format!(
            "SELECT i.name, i.is_unique, i.is_primary_key, i.type_desc, c.name, ic.is_descending_key, ic.is_included_column \
             FROM {p}sys.indexes i JOIN {p}sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
             JOIN {p}sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
             WHERE i.object_id = {oid} AND i.type > 0 ORDER BY i.is_primary_key DESC, i.name, ic.is_included_column, ic.key_ordinal"
        ))
        .await?
    {
        let name = r.s(0);
        if idx.last().map(|i| i.name != name).unwrap_or(true) {
            idx.push(IndexDef { name: name.clone(), unique: r.b(1), primary: r.b(2), method: r.o(3), ..Default::default() });
        }
        let col = if r.b(6) { format!("{} (included)", r.s(4)) } else if r.b(5) { format!("{} DESC", r.s(4)) } else { r.s(4) };
        idx.last_mut().unwrap().columns.push(col);
    }
    t.primary_key = idx.iter().find(|i| i.primary).map(|i| i.columns.iter().map(|c| c.trim_end_matches(" DESC").to_string()).collect()).unwrap_or_default();
    for r in c
        .query_rows(&format!(
            "SELECT c.name, ty.name, c.max_length, c.precision, c.scale, c.is_nullable, dc.definition, c.is_identity, \
             CAST(ep.value AS nvarchar(4000)), cc.definition, CAST(idc.seed_value AS nvarchar(40)), CAST(idc.increment_value AS nvarchar(40)) \
             FROM {p}sys.columns c JOIN {p}sys.types ty ON ty.user_type_id = c.user_type_id \
             LEFT JOIN {p}sys.default_constraints dc ON dc.object_id = c.default_object_id \
             LEFT JOIN {p}sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id \
             LEFT JOIN {p}sys.identity_columns idc ON idc.object_id = c.object_id AND idc.column_id = c.column_id \
             LEFT JOIN {p}sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.class = 1 AND ep.name = 'MS_Description' \
             WHERE c.object_id = {oid} ORDER BY c.column_id"
        ))
        .await?
    {
        let mut data_type = mssql_type(&r.s(1), r.n(2).unwrap_or(0), r.n(3).unwrap_or(0), r.n(4).unwrap_or(0));
        if let Some(expr) = r.o(9) {
            data_type = format!("AS {expr}");
        } else if r.b(7) {
            data_type = format!("{data_type} IDENTITY({},{})", r.o(10).unwrap_or_else(|| "1".into()), r.o(11).unwrap_or_else(|| "1".into()));
        }
        t.columns.push(ColumnDef {
            primary_key: t.primary_key.contains(&r.s(0)),
            name: r.s(0),
            data_type,
            nullable: r.b(5),
            default_value: r.o(6),
            auto_increment: r.b(7),
            comment: r.o(8),
        });
    }
    t.indexes = idx;
    let fk_sql = |filter: &str| {
        format!(
            "SELECT fk.name, ps.name, pt.name, pc.name, rs.name, rt.name, rc.name, fk.update_referential_action_desc, fk.delete_referential_action_desc \
             FROM {p}sys.foreign_keys fk JOIN {p}sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
             JOIN {p}sys.objects pt ON pt.object_id = fkc.parent_object_id JOIN {p}sys.schemas ps ON ps.schema_id = pt.schema_id \
             JOIN {p}sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id \
             JOIN {p}sys.objects rt ON rt.object_id = fkc.referenced_object_id JOIN {p}sys.schemas rs ON rs.schema_id = rt.schema_id \
             JOIN {p}sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id \
             WHERE {filter} ORDER BY pt.name, fk.name, fkc.constraint_column_id"
        )
    };
    for r in c.query_rows(&fk_sql(&format!("fk.parent_object_id = {oid}"))).await? {
        let name = r.s(0);
        if t.foreign_keys.last().map(|f| f.name != name).unwrap_or(true) {
            t.foreign_keys.push(ForeignKeyDef {
                name: name.clone(),
                ref_schema: r.o(4),
                ref_table: r.s(5),
                on_update: mssql_action(r.o(7)),
                on_delete: mssql_action(r.o(8)),
                ..Default::default()
            });
        }
        let fk = t.foreign_keys.last_mut().unwrap();
        fk.columns.push(r.s(3));
        fk.ref_columns.push(r.s(6));
    }
    for r in c.query_rows(&fk_sql(&format!("fk.referenced_object_id = {oid}"))).await? {
        let name = r.s(0);
        if t.references.last().map(|f| f.name != name).unwrap_or(true) {
            t.references.push(ReferenceDef { name, schema: r.o(1), table: r.s(2), ..Default::default() });
        }
        let rf = t.references.last_mut().unwrap();
        rf.columns.push(r.s(3));
        rf.ref_columns.push(r.s(6));
    }
    for r in c
        .query_rows(&format!(
            "SELECT tr.name, CASE WHEN tr.is_instead_of_trigger = 1 THEN 'INSTEAD OF' ELSE 'AFTER' END, m.definition \
             FROM {p}sys.triggers tr LEFT JOIN {p}sys.sql_modules m ON m.object_id = tr.object_id WHERE tr.parent_id = {oid} ORDER BY tr.name"
        ))
        .await?
    {
        t.triggers.push(TriggerDef { name: r.s(0), event: r.o(1), definition: r.o(2) });
    }
    for r in c.query_rows(&format!("SELECT name, definition FROM {p}sys.check_constraints WHERE parent_object_id = {oid} ORDER BY name")).await? {
        t.constraints.push(ConstraintDef { name: r.s(0), kind: "check".into(), definition: format!("CHECK {}", r.s(1)) });
    }
    for i in t.indexes.iter().filter(|i| i.unique && !i.primary) {
        t.constraints.push(ConstraintDef { name: i.name.clone(), kind: "unique".into(), definition: format!("UNIQUE ({})", i.columns.join(", ")) });
    }
    if let Some(r) = c
        .query_rows(&format!(
            "SELECT o.type_desc, CONVERT(nvarchar(30), o.create_date, 120), CONVERT(nvarchar(30), o.modify_date, 120), \
             (SELECT SUM(pt.rows) FROM {p}sys.partitions pt WHERE pt.object_id = o.object_id AND pt.index_id IN (0,1)), \
             (SELECT SUM(a.total_pages) * 8192 FROM {p}sys.partitions pt JOIN {p}sys.allocation_units a ON a.container_id = pt.partition_id WHERE pt.object_id = o.object_id), \
             CAST(ep.value AS nvarchar(4000)) \
             FROM {p}sys.objects o LEFT JOIN {p}sys.extended_properties ep ON ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.class = 1 AND ep.name = 'MS_Description' \
             WHERE o.object_id = {oid}"
        ))
        .await?
        .into_iter()
        .next()
    {
        t.kind = if r.s(0).contains("VIEW") { "view".into() } else { "table".into() };
        t.comment = r.o(5);
        let mut props = vec![("Type".to_string(), r.s(0).replace('_', " ").to_lowercase())];
        if let Some(n) = r.o(3) {
            props.push(("Rows".into(), n));
        }
        if let Some(n) = r.n(4) {
            props.push(("Size".into(), human_bytes(n)));
        }
        props.push(("Created".into(), r.s(1)));
        props.push(("Modified".into(), r.s(2)));
        t.properties = props;
    }
    Ok(t)
}

pub fn human_bytes(n: i64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut u = 0;
    while v >= 1024.0 && u < units.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", units[u])
    }
}

// ---------------------------------------------------------------- DDL

/// Source (CREATE statement) of an object.
pub async fn object_ddl(c: &mut Conn, db: &str, schema: Option<&str>, name: &str, kind: &str, signature: Option<&str>) -> AppResult<String> {
    let d = c.driver();
    let not_found = || AppError::NotFound(format!("{kind} {name}"));
    match d {
        Driver::Postgres => {
            let schema = schema.unwrap_or("public");
            let (s, n) = (quote_lit(d, schema), quote_lit(d, name));
            let qn = format!("{}.{}", quote_ident(d, schema), quote_ident(d, name));
            match kind {
                "table" | "foreign" => pg_table_ddl(c, schema, name).await,
                "view" => {
                    let def = c.query_value(&format!("SELECT pg_get_viewdef({}, true)", pg_oid(schema, name))).await?.ok_or_else(not_found)?;
                    Ok(format!("CREATE OR REPLACE VIEW {qn} AS\n{}", def.trim_end()))
                }
                "matview" => {
                    let def = c.query_value(&format!("SELECT pg_get_viewdef({}, true)", pg_oid(schema, name))).await?.ok_or_else(not_found)?;
                    Ok(format!("CREATE MATERIALIZED VIEW {qn} AS\n{}", def.trim_end()))
                }
                "function" | "procedure" => {
                    let sig = quote_lit(d, signature.unwrap_or(""));
                    c.query_value(&format!(
                        "SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace \
                         WHERE ns.nspname = {s} AND p.proname = {n} AND pg_get_function_identity_arguments(p.oid) = {sig} LIMIT 1"
                    ))
                    .await?
                    .ok_or_else(not_found)
                }
                "sequence" => {
                    let r = c
                        .query_rows(&format!(
                            "SELECT data_type, increment_by, min_value, max_value, start_value, cache_size, cycle \
                             FROM pg_sequences WHERE schemaname = {s} AND sequencename = {n}"
                        ))
                        .await?
                        .into_iter()
                        .next()
                        .ok_or_else(not_found)?;
                    Ok(format!(
                        "CREATE SEQUENCE {qn}\n\tAS {}\n\tINCREMENT BY {}\n\tMINVALUE {}\n\tMAXVALUE {}\n\tSTART {}\n\tCACHE {}\n\t{}CYCLE;",
                        r.s(0),
                        r.s(1),
                        r.s(2),
                        r.s(3),
                        r.s(4),
                        r.s(5),
                        if r.b(6) { "" } else { "NO " }
                    ))
                }
                "trigger" => c
                    .query_value(&format!(
                        "SELECT pg_get_triggerdef(t.oid, true) || ';' FROM pg_trigger t JOIN pg_class cl ON cl.oid = t.tgrelid \
                         JOIN pg_namespace ns ON ns.oid = cl.relnamespace WHERE ns.nspname = {s} AND t.tgname = {n} LIMIT 1"
                    ))
                    .await?
                    .ok_or_else(not_found),
                _ => Err(not_found()),
            }
        }
        Driver::Mysql => {
            let qn = format!("{}.{}", quote_ident(d, db), quote_ident(d, name));
            let (stmt, col) = match kind {
                "table" => ("TABLE", 1),
                "view" => ("VIEW", 1),
                "procedure" => ("PROCEDURE", 2),
                "function" => ("FUNCTION", 2),
                "trigger" => ("TRIGGER", 2),
                _ => return Err(not_found()),
            };
            let row = c.query_rows(&format!("SHOW CREATE {stmt} {qn}")).await?.into_iter().next().ok_or_else(not_found)?;
            Ok(format!("{};", row.s(col)))
        }
        Driver::Sqlite => {
            let dq = quote_ident(d, if db.is_empty() { "main" } else { db });
            let n = quote_lit(d, name);
            let mut parts: Vec<String> = c
                .query_rows(&format!("SELECT sql FROM {dq}.sqlite_master WHERE name = {n} AND sql IS NOT NULL"))
                .await?
                .into_iter()
                .map(|r| format!("{};", r.s(0)))
                .collect();
            if parts.is_empty() {
                return Err(not_found());
            }
            if kind == "table" {
                for r in c
                    .query_rows(&format!(
                        "SELECT sql FROM {dq}.sqlite_master WHERE tbl_name = {n} AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type, name"
                    ))
                    .await?
                {
                    parts.push(format!("{};", r.s(0)));
                }
            }
            Ok(parts.join("\n\n"))
        }
        Driver::Mssql => {
            let schema = schema.unwrap_or("dbo");
            let p = mssql_prefix(db);
            let oid = mssql_oid(db, schema, name);
            match kind {
                "table" => mssql_table_ddl(c, db, schema, name).await,
                "sequence" => {
                    let r = c
                        .query_rows(&format!(
                            "SELECT TYPE_NAME(s.user_type_id), CAST(s.start_value AS nvarchar(40)), CAST(s.increment AS nvarchar(40)), \
                             CAST(s.minimum_value AS nvarchar(40)), CAST(s.maximum_value AS nvarchar(40)), s.is_cycling, s.cache_size \
                             FROM {p}sys.sequences s WHERE s.object_id = {oid}"
                        ))
                        .await?
                        .into_iter()
                        .next()
                        .ok_or_else(not_found)?;
                    Ok(format!(
                        "CREATE SEQUENCE {}.{}\n\tAS {}\n\tSTART WITH {}\n\tINCREMENT BY {}\n\tMINVALUE {}\n\tMAXVALUE {}\n\t{}CYCLE{};",
                        quote_ident(d, schema),
                        quote_ident(d, name),
                        r.s(0),
                        r.s(1),
                        r.s(2),
                        r.s(3),
                        r.s(4),
                        if r.b(5) { "" } else { "NO " },
                        r.o(6).map(|c| format!("\n\tCACHE {c}")).unwrap_or_default()
                    ))
                }
                _ => c.query_value(&format!("SELECT m.definition FROM {p}sys.sql_modules m WHERE m.object_id = {oid}")).await?.ok_or_else(not_found),
            }
        }
    }
}

async fn pg_table_ddl(c: &mut Conn, schema: &str, table: &str) -> AppResult<String> {
    let d = Driver::Postgres;
    let oid = pg_oid(schema, table);
    let qn = format!("{}.{}", quote_ident(d, schema), quote_ident(d, table));
    let info = pg_table(c, schema, table).await?;
    if info.columns.is_empty() {
        return Err(AppError::NotFound(format!("table {table}")));
    }
    let identity: Vec<(String, String)> = c
        .query_rows(&format!("SELECT attname, attidentity FROM pg_attribute WHERE attrelid = {oid} AND attidentity <> ''"))
        .await?
        .into_iter()
        .map(|r| (r.s(0), r.s(1)))
        .collect();
    let mut lines: Vec<String> = info
        .columns
        .iter()
        .map(|col| {
            let mut l = format!("\t{} {}", quote_ident(d, &col.name), col.data_type);
            if let Some((_, kind)) = identity.iter().find(|(n, _)| *n == col.name) {
                l.push_str(if kind == "a" { " GENERATED ALWAYS AS IDENTITY" } else { " GENERATED BY DEFAULT AS IDENTITY" });
            } else if let Some(def) = &col.default_value {
                l.push_str(&format!(" DEFAULT {def}"));
            }
            if !col.nullable {
                l.push_str(" NOT NULL");
            }
            l
        })
        .collect();
    for r in c
        .query_rows(&format!(
            "SELECT conname, pg_get_constraintdef(oid, true) FROM pg_constraint WHERE conrelid = {oid} \
             ORDER BY contype = 'p' DESC, contype = 'u' DESC, contype = 'c' DESC, conname"
        ))
        .await?
    {
        lines.push(format!("\tCONSTRAINT {} {}", quote_ident(d, &r.s(0)), r.s(1)));
    }
    let mut out = format!("CREATE TABLE {qn} (\n{}\n);", lines.join(",\n"));
    for r in c
        .query_rows(&format!(
            "SELECT pg_get_indexdef(ix.indexrelid) FROM pg_index ix WHERE ix.indrelid = {oid} \
             AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = ix.indexrelid) ORDER BY 1"
        ))
        .await?
    {
        out.push_str(&format!("\n{};", r.s(0)));
    }
    if let Some(cm) = &info.comment {
        out.push_str(&format!("\n\nCOMMENT ON TABLE {qn} IS {};", quote_lit(d, cm)));
    }
    for col in info.columns.iter().filter(|c| c.comment.is_some()) {
        out.push_str(&format!("\nCOMMENT ON COLUMN {qn}.{} IS {};", quote_ident(d, &col.name), quote_lit(d, col.comment.as_deref().unwrap_or(""))));
    }
    for tr in &info.triggers {
        if let Some(def) = &tr.definition {
            out.push_str(&format!("\n\n{def};"));
        }
    }
    Ok(out)
}

async fn mssql_table_ddl(c: &mut Conn, db: &str, schema: &str, table: &str) -> AppResult<String> {
    let d = Driver::Mssql;
    let info = mssql_table(c, db, schema, table).await?;
    if info.columns.is_empty() {
        return Err(AppError::NotFound(format!("table {table}")));
    }
    let qn = format!("{}.{}", quote_ident(d, schema), quote_ident(d, table));
    let mut lines: Vec<String> = info
        .columns
        .iter()
        .map(|col| {
            let mut l = format!("\t{} {}", quote_ident(d, &col.name), col.data_type);
            if !col.data_type.starts_with("AS ") {
                l.push_str(if col.nullable { " NULL" } else { " NOT NULL" });
                if let Some(def) = &col.default_value {
                    l.push_str(&format!(" DEFAULT {def}"));
                }
            }
            l
        })
        .collect();
    if let Some(pk) = info.indexes.iter().find(|i| i.primary) {
        let cols: Vec<String> = pk.columns.iter().map(|c| quote_ident(d, c.trim_end_matches(" DESC"))).collect();
        let clustered = if pk.method.as_deref() == Some("CLUSTERED") { " CLUSTERED" } else { " NONCLUSTERED" };
        lines.push(format!("\tCONSTRAINT {} PRIMARY KEY{clustered} ({})", quote_ident(d, &pk.name), cols.join(", ")));
    }
    for ck in info.constraints.iter().filter(|c| c.kind == "check") {
        lines.push(format!("\tCONSTRAINT {} {}", quote_ident(d, &ck.name), ck.definition));
    }
    let mut out = format!("CREATE TABLE {qn} (\n{}\n);", lines.join(",\n"));
    for ix in info.indexes.iter().filter(|i| !i.primary) {
        let (keys, incl): (Vec<&String>, Vec<&String>) = ix.columns.iter().partition(|c| !c.ends_with(" (included)"));
        let keys: Vec<String> = keys.iter().map(|c| quote_col_desc(c)).collect();
        let incl: Vec<String> = incl.iter().map(|c| quote_ident(d, c.trim_end_matches(" (included)"))).collect();
        out.push_str(&format!(
            "\nCREATE {}{} INDEX {} ON {qn} ({}){};",
            if ix.unique { "UNIQUE " } else { "" },
            ix.method.as_deref().unwrap_or("NONCLUSTERED"),
            quote_ident(d, &ix.name),
            keys.join(", "),
            if incl.is_empty() { String::new() } else { format!(" INCLUDE ({})", incl.join(", ")) }
        ));
    }
    for fk in &info.foreign_keys {
        out.push_str(&format!(
            "\nALTER TABLE {qn} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {}.{} ({}){}{};",
            quote_ident(d, &fk.name),
            fk.columns.iter().map(|c| quote_ident(d, c)).collect::<Vec<_>>().join(", "),
            quote_ident(d, fk.ref_schema.as_deref().unwrap_or("dbo")),
            quote_ident(d, &fk.ref_table),
            fk.ref_columns.iter().map(|c| quote_ident(d, c)).collect::<Vec<_>>().join(", "),
            fk.on_update.as_ref().filter(|a| *a != "NO ACTION").map(|a| format!(" ON UPDATE {a}")).unwrap_or_default(),
            fk.on_delete.as_ref().filter(|a| *a != "NO ACTION").map(|a| format!(" ON DELETE {a}")).unwrap_or_default(),
        ));
    }
    for tr in &info.triggers {
        if let Some(def) = &tr.definition {
            out.push_str(&format!("\nGO\n{}", def.trim()));
        }
    }
    Ok(out)
}

fn quote_col_desc(c: &str) -> String {
    match c.strip_suffix(" DESC") {
        Some(n) => format!("{} DESC", quote_ident(Driver::Mssql, n)),
        None => quote_ident(Driver::Mssql, c),
    }
}

// ---------------------------------------------------------------- schema model

/// Every table / view of a schema with columns, keys and foreign keys.
pub async fn schema_model(c: &mut Conn, db: &str, schema: Option<&str>) -> AppResult<Vec<ModelTable>> {
    let d = c.driver();
    // (table, kind, column, type, nullable, pk)
    let (col_sql, fk_sql) = match d {
        Driver::Postgres => {
            let s = quote_lit(d, schema.unwrap_or("public"));
            (
                format!(
                    "SELECT c.relname, CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END, a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, \
                     EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)) \
                     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid \
                     WHERE n.nspname = {s} AND c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition AND a.attnum > 0 AND NOT a.attisdropped \
                     ORDER BY c.relname, a.attnum"
                ),
                format!(
                    "SELECT c.relname, con.conname, \
                     (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(n, ord) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n)::text, \
                     fn.nspname, fc.relname, \
                     (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(n, ord) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n)::text \
                     FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace \
                     JOIN pg_class fc ON fc.oid = con.confrelid JOIN pg_namespace fn ON fn.oid = fc.relnamespace \
                     WHERE con.contype = 'f' AND n.nspname = {s} ORDER BY 1, 2"
                ),
            )
        }
        Driver::Mysql => {
            let s = quote_lit(d, db);
            (
                format!(
                    "SELECT c.TABLE_NAME, CASE WHEN t.TABLE_TYPE LIKE '%VIEW' THEN 'view' ELSE 'table' END, c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE = 'YES', c.COLUMN_KEY = 'PRI' \
                     FROM information_schema.COLUMNS c JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME \
                     WHERE c.TABLE_SCHEMA = {s} ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION"
                ),
                format!(
                    "SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME \
                     FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = {s} AND REFERENCED_TABLE_NAME IS NOT NULL \
                     ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION"
                ),
            )
        }
        Driver::Sqlite => {
            let db = if db.is_empty() { "main" } else { db };
            let (dl, dq) = (quote_lit(d, db), quote_ident(d, db));
            (
                format!(
                    "SELECT m.name, m.type, p.name, p.type, NOT p.\"notnull\", p.pk > 0 FROM {dq}.sqlite_master m \
                     JOIN pragma_table_info(m.name, {dl}) p WHERE m.type IN ('table','view') ORDER BY m.name, p.cid"
                ),
                format!(
                    "SELECT m.name, 'fk_' || m.name || '_' || f.id, f.\"from\", NULL, f.\"table\", f.\"to\" FROM {dq}.sqlite_master m \
                     JOIN pragma_foreign_key_list(m.name, {dl}) f WHERE m.type = 'table' ORDER BY m.name, f.id, f.seq"
                ),
            )
        }
        Driver::Mssql => {
            let p = mssql_prefix(db);
            let s = quote_lit(d, schema.unwrap_or("dbo"));
            (
                format!(
                    "SELECT o.name, CASE WHEN o.type = 'V' THEN 'view' ELSE 'table' END, c.name, \
                     ty.name + CASE WHEN ty.name IN ('varchar','char','varbinary','binary') THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length AS varchar(10)) END + ')' \
                     WHEN ty.name IN ('nvarchar','nchar') THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length / 2 AS varchar(10)) END + ')' \
                     WHEN ty.name IN ('decimal','numeric') THEN '(' + CAST(c.precision AS varchar(5)) + ',' + CAST(c.scale AS varchar(5)) + ')' ELSE '' END, \
                     c.is_nullable, \
                     CASE WHEN EXISTS (SELECT 1 FROM {p}sys.indexes i JOIN {p}sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
                     WHERE i.object_id = o.object_id AND i.is_primary_key = 1 AND ic.column_id = c.column_id) THEN 1 ELSE 0 END \
                     FROM {p}sys.objects o JOIN {p}sys.schemas s ON s.schema_id = o.schema_id JOIN {p}sys.columns c ON c.object_id = o.object_id \
                     JOIN {p}sys.types ty ON ty.user_type_id = c.user_type_id \
                     WHERE s.name = {s} AND o.type IN ('U','V') AND o.is_ms_shipped = 0 ORDER BY o.name, c.column_id"
                ),
                format!(
                    "SELECT pt.name, fk.name, pc.name, rs.name, rt.name, rc.name \
                     FROM {p}sys.foreign_keys fk JOIN {p}sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
                     JOIN {p}sys.objects pt ON pt.object_id = fkc.parent_object_id JOIN {p}sys.schemas ps ON ps.schema_id = pt.schema_id \
                     JOIN {p}sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id \
                     JOIN {p}sys.objects rt ON rt.object_id = fkc.referenced_object_id JOIN {p}sys.schemas rs ON rs.schema_id = rt.schema_id \
                     JOIN {p}sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id \
                     WHERE ps.name = {s} ORDER BY pt.name, fk.name, fkc.constraint_column_id"
                ),
            )
        }
    };
    let mut tables: Vec<ModelTable> = Vec::new();
    for r in c.query_rows(&col_sql).await? {
        let name = r.s(0);
        if tables.last().map(|t| t.name != name).unwrap_or(true) {
            tables.push(ModelTable { name: name.clone(), kind: r.s(1), ..Default::default() });
        }
        tables.last_mut().unwrap().columns.push(ModelColumn { name: r.s(2), data_type: r.s(3), nullable: r.b(4), primary_key: r.b(5) });
    }
    let json_lists = d == Driver::Postgres;
    for r in c.query_rows(&fk_sql).await? {
        let Some(t) = tables.iter_mut().find(|t| t.name == r.s(0)) else { continue };
        let name = r.s(1);
        if json_lists {
            t.foreign_keys.push(ForeignKeyDef { name, columns: r.list(2), ref_schema: r.o(3), ref_table: r.s(4), ref_columns: r.list(5), ..Default::default() });
            continue;
        }
        if t.foreign_keys.last().map(|f| f.name != name).unwrap_or(true) {
            t.foreign_keys.push(ForeignKeyDef { name, ref_schema: r.o(3), ref_table: r.s(4), ..Default::default() });
        }
        let fk = t.foreign_keys.last_mut().unwrap();
        fk.columns.push(r.s(2));
        fk.ref_columns.push(r.s(5));
    }
    Ok(tables)
}

// ---------------------------------------------------------------- server sessions

pub async fn server_sessions(c: &mut Conn) -> AppResult<Vec<ServerSession>> {
    let sql = match c.driver() {
        Driver::Postgres => {
            "SELECT pid, usename, datname, COALESCE(client_addr::text, 'local'), application_name, state, \
             to_char(backend_start, 'YYYY-MM-DD HH24:MI:SS'), to_char(query_start, 'YYYY-MM-DD HH24:MI:SS'), \
             wait_event_type || ': ' || wait_event, query FROM pg_stat_activity WHERE backend_type = 'client backend' ORDER BY pid"
        }
        Driver::Mysql => "SELECT ID, USER, DB, HOST, NULL, COMMAND, NULL, CONCAT(TIME, ' s'), STATE, INFO FROM information_schema.PROCESSLIST ORDER BY ID",
        Driver::Mssql => {
            "SELECT s.session_id, s.login_name, DB_NAME(s.database_id), s.host_name, s.program_name, COALESCE(r.status, s.status), \
             CONVERT(nvarchar(30), s.login_time, 120), CONVERT(nvarchar(30), r.start_time, 120), r.wait_type, t.text \
             FROM sys.dm_exec_sessions s LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id \
             OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t WHERE s.is_user_process = 1 ORDER BY s.session_id"
        }
        Driver::Sqlite => return Ok(Vec::new()),
    };
    Ok(c
        .query_rows(sql)
        .await?
        .into_iter()
        .map(|r| ServerSession {
            id: r.s(0),
            user: r.o(1),
            database: r.o(2),
            client: r.o(3),
            application: r.o(4),
            state: r.o(5),
            started: r.o(6),
            query_start: r.o(7),
            wait: r.o(8),
            query: r.o(9),
        })
        .collect())
}

/// Ends a server session (`cancel_only`: just stops its running query).
pub async fn kill_session(c: &mut Conn, id: &str, cancel_only: bool) -> AppResult<()> {
    let id: i64 = id.trim().parse().map_err(|_| AppError::invalid("Invalid session id"))?;
    let sql = match (c.driver(), cancel_only) {
        (Driver::Postgres, true) => format!("SELECT pg_cancel_backend({id})"),
        (Driver::Postgres, false) => format!("SELECT pg_terminate_backend({id})"),
        (Driver::Mysql, true) => format!("KILL QUERY {id}"),
        (Driver::Mysql, false) => format!("KILL {id}"),
        (Driver::Mssql, _) => format!("KILL {id}"),
        (Driver::Sqlite, _) => return Err(AppError::invalid("SQLite has no server sessions")),
    };
    c.query_rows(&sql).await.map(|_| ())
}

/// Statements that show the execution plan of `sql` (run in order; the
/// plan is in the results of the middle one for SQL Server).
pub fn explain_statements(d: Driver, sql: &str, analyze: bool) -> Vec<String> {
    let sql = crate::sqlscan::trim_statement(sql);
    match d {
        Driver::Postgres => vec![if analyze { format!("EXPLAIN (ANALYZE, BUFFERS) {sql}") } else { format!("EXPLAIN {sql}") }],
        Driver::Mysql => vec![if analyze { format!("EXPLAIN ANALYZE {sql}") } else { format!("EXPLAIN {sql}") }],
        Driver::Sqlite => vec![format!("EXPLAIN QUERY PLAN {sql}")],
        Driver::Mssql => {
            let opt = if analyze { "STATISTICS PROFILE" } else { "SHOWPLAN_TEXT" };
            vec![format!("SET {opt} ON"), sql.to_string(), format!("SET {opt} OFF")]
        }
    }
}
