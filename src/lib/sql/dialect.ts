import type { Cell, ColumnDef, ColumnKind, Driver } from "../types";

/** A table (or view) somewhere on a server. */
export interface TableRef {
  database: string;
  schema: string | null;
  name: string;
}

export const DRIVER_LABEL: Record<Driver, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  sqlite: "SQLite",
  mssql: "SQL Server",
};

export const DEFAULT_PORT: Record<Driver, number> = { postgres: 5432, mysql: 3306, sqlite: 0, mssql: 1433 };

/** Words that must be quoted when used as identifiers. */
const RESERVED = new Set(
  (
    "all and any as asc between by case check collate column constraint create cross current_date current_time current_timestamp current_user " +
    "default delete desc distinct do drop else end except exists false fetch for foreign from full grant group having in index inner insert " +
    "intersect into is join key left like limit natural not null offset on or order outer primary references right select session_user set " +
    "some table then to top true union unique update user using values when where with window"
  ).split(" "),
);

/** Quotes an identifier only when it needs it (case, characters, keywords). */
export function ident(driver: Driver, name: string): string {
  const plain =
    driver === "postgres" ? /^[a-z_][a-z0-9_$]*$/.test(name) : driver === "mssql" ? /^[A-Za-z_@#][A-Za-z0-9_@#$]*$/.test(name) : /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name);
  if (plain && !RESERVED.has(name.toLowerCase())) return name;
  return quoteIdent(driver, name);
}

/** Always quotes. */
export function quoteIdent(driver: Driver, name: string): string {
  switch (driver) {
    case "mysql":
      return "`" + name.replace(/`/g, "``") + "`";
    case "mssql":
      return "[" + name.replace(/]/g, "]]") + "]";
    default:
      return '"' + name.replace(/"/g, '""') + '"';
  }
}

/** Name of a table as seen from a session in `currentDatabase`. */
export function qualified(driver: Driver, t: TableRef, currentDatabase?: string): string {
  const q = (s: string) => ident(driver, s);
  switch (driver) {
    case "postgres":
      return t.schema ? `${q(t.schema)}.${q(t.name)}` : q(t.name);
    case "mysql":
      return t.database && t.database !== currentDatabase ? `${q(t.database)}.${q(t.name)}` : q(t.name);
    case "mssql": {
      const sch = q(t.schema ?? "dbo");
      return t.database && t.database !== currentDatabase ? `${q(t.database)}.${sch}.${q(t.name)}` : `${sch}.${q(t.name)}`;
    }
    case "sqlite":
      return t.database && t.database !== "main" ? `${q(t.database)}.${q(t.name)}` : q(t.name);
  }
}

export function stringLiteral(driver: Driver, value: string): string {
  if (driver === "mysql") return "'" + value.replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
  if (driver === "mssql") return "N'" + value.replace(/'/g, "''") + "'";
  return "'" + value.replace(/'/g, "''") + "'";
}

const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const HEX = /^0x[0-9a-fA-F]*$/;

/** A value as a SQL literal for a column of `kind`. */
export function literal(driver: Driver, value: Cell, kind: ColumnKind): string {
  if (value === null) return "NULL";
  if (kind === "number" && NUMERIC.test(value.trim())) return value.trim();
  if (kind === "binary" && HEX.test(value)) {
    if (driver === "sqlite") return `X'${value.slice(2)}'`;
    if (driver === "postgres") return `'\\x${value.slice(2)}'`;
    return value;
  }
  if (kind === "bool" && driver === "mssql") {
    if (/^(true|t|1)$/i.test(value)) return "1";
    if (/^(false|f|0)$/i.test(value)) return "0";
  }
  return stringLiteral(driver, value);
}

/** Column kind from a declared type ("varchar(20)", "timestamp with time zone"…). */
export function kindOf(typeName: string): ColumnKind {
  const t = typeName.toLowerCase().replace(/^_/, "").replace(/\s+identity.*$/, "");
  if (t.endsWith("[]")) return "other";
  const base = t.split(/[( ]/)[0];
  if (/^(tiny|small|medium|big)?int(eger)?\d*$|^(u?int\d*|serial|bigserial|smallserial|decimal|numeric|real|float\d*|double|money|smallmoney|number|oid|year)$/.test(base)) return "number";
  if (base === "bit" && !/bit\s*\(\s*([2-9]|\d\d)/.test(t)) return "bool";
  if (/^(bool|boolean)$/.test(base)) return "bool";
  if (/^(date|time|timetz|timestamp|timestamptz|datetime|datetime2|smalldatetime|datetimeoffset|interval)$/.test(base)) return "date";
  if (/^jsonb?$/.test(base)) return "json";
  if (/^(bytea|blob|tinyblob|mediumblob|longblob|binary|varbinary|image)$/.test(base)) return "binary";
  if (/^(uuid|uniqueidentifier)$/.test(base)) return "uuid";
  if (/^(text|varchar|char|character|nvarchar|nchar|ntext|bpchar|name|citext|tinytext|mediumtext|longtext|string|clob|enum|set|xml|sysname|inet|cidr|macaddr)$/.test(base)) return "text";
  return "other";
}

export interface SortKey {
  column: string;
  desc: boolean;
}

/** SELECT of a table's data with an optional filter and sort. */
export function selectData(driver: Driver, t: TableRef, where: string, order: SortKey[], currentDatabase?: string): string {
  let sql = `SELECT * FROM ${qualified(driver, t, currentDatabase)}`;
  if (where.trim()) sql += `\nWHERE ${where.trim()}`;
  if (order.length) sql += `\nORDER BY ${order.map((o) => `${ident(driver, o.column)}${o.desc ? " DESC" : ""}`).join(", ")}`;
  return sql;
}

export function countSql(driver: Driver, t: TableRef, where: string, currentDatabase?: string): string {
  return `SELECT COUNT(*) FROM ${qualified(driver, t, currentDatabase)}${where.trim() ? ` WHERE ${where.trim()}` : ""}`;
}

/** Wraps any query in a row count. */
export function countQuery(driver: Driver, sql: string): string {
  const body = sql.trim().replace(/;+\s*$/, "");
  return driver === "mssql" ? `SELECT COUNT(*) AS [count] FROM (\n${body}\n) helix_q` : `SELECT COUNT(*) AS count FROM (\n${body}\n) helix_q`;
}

// ---------------------------------------------------------------- data editing

export interface RowChange {
  /** "update": `values` holds the changed columns only. */
  kind: "insert" | "update" | "delete";
  /** The row as loaded (update / delete). */
  original?: Cell[];
  /** Full row (insert) or changed cells by column index (update). */
  values: Record<number, Cell>;
}

export interface EditTarget {
  driver: Driver;
  table: TableRef;
  currentDatabase?: string;
  /** Result columns (same order as the row arrays). */
  columns: { name: string; kind: ColumnKind }[];
  /** Key columns identifying a row; empty → every comparable column. */
  keyColumns: string[];
}

function whereFor(t: EditTarget, row: Cell[]): string {
  const keys = t.keyColumns.length
    ? t.keyColumns
    : t.columns.filter((c) => c.kind !== "json" && c.kind !== "binary" && c.kind !== "other").map((c) => c.name);
  return keys
    .map((k) => {
      const i = t.columns.findIndex((c) => c.name === k);
      if (i < 0) throw new Error(`Key column ${k} is not in the result`);
      const v = row[i];
      return v === null ? `${ident(t.driver, k)} IS NULL` : `${ident(t.driver, k)} = ${literal(t.driver, v, t.columns[i].kind)}`;
    })
    .join(" AND ");
}

/** INSERT / UPDATE / DELETE statements that apply grid edits. */
export function changeStatements(t: EditTarget, changes: RowChange[]): string[] {
  const name = qualified(t.driver, t.table, t.currentDatabase);
  const col = (i: number) => ident(t.driver, t.columns[i].name);
  const lit = (i: number, v: Cell) => literal(t.driver, v, t.columns[i].kind);
  const out: string[] = [];
  for (const ch of changes) {
    if (ch.kind === "delete" && ch.original) {
      out.push(`DELETE FROM ${name} WHERE ${whereFor(t, ch.original)}`);
    } else if (ch.kind === "update" && ch.original) {
      const sets = Object.entries(ch.values).map(([i, v]) => `${col(+i)} = ${lit(+i, v)}`);
      if (sets.length) out.push(`UPDATE ${name} SET ${sets.join(", ")} WHERE ${whereFor(t, ch.original)}`);
    } else if (ch.kind === "insert") {
      const idx = Object.keys(ch.values).map(Number);
      out.push(
        idx.length
          ? `INSERT INTO ${name} (${idx.map(col).join(", ")}) VALUES (${idx.map((i) => lit(i, ch.values[i])).join(", ")})`
          : t.driver === "mysql"
            ? `INSERT INTO ${name} () VALUES ()`
            : `INSERT INTO ${name} DEFAULT VALUES`,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------- generators

export function generateSql(
  driver: Driver,
  kind: "select" | "insert" | "update" | "delete" | "merge",
  t: TableRef,
  columns: ColumnDef[],
  currentDatabase?: string,
): string {
  const name = qualified(driver, t, currentDatabase);
  const q = (c: string) => ident(driver, c);
  const keys = columns.filter((c) => c.primaryKey);
  const keyCols = keys.length ? keys : columns.slice(0, 1);
  const where = keyCols.map((c) => `${q(c.name)} = ?`).join("\n  AND ");
  const editable = columns.filter((c) => !c.autoIncrement);
  switch (kind) {
    case "select": {
      const top = driver === "mssql" ? "TOP 200 " : "";
      const tail = driver === "mssql" ? "" : "\nLIMIT 200";
      return `SELECT ${top}${columns.map((c) => q(c.name)).join(",\n       ")}\nFROM ${name}${tail};`;
    }
    case "insert":
      return `INSERT INTO ${name}\n  (${editable.map((c) => q(c.name)).join(", ")})\nVALUES\n  (${editable.map(() => "?").join(", ")});`;
    case "update":
      return `UPDATE ${name}\nSET ${columns
        .filter((c) => !c.primaryKey && !c.autoIncrement)
        .map((c) => `${q(c.name)} = ?`)
        .join(",\n    ")}\nWHERE ${where};`;
    case "delete":
      return `DELETE FROM ${name}\nWHERE ${where};`;
    case "merge": {
      if (driver === "postgres")
        return `INSERT INTO ${name} (${editable.map((c) => q(c.name)).join(", ")})\nVALUES (${editable.map(() => "?").join(", ")})\nON CONFLICT (${keyCols
          .map((c) => q(c.name))
          .join(", ")}) DO UPDATE SET\n  ${editable
          .filter((c) => !c.primaryKey)
          .map((c) => `${q(c.name)} = EXCLUDED.${q(c.name)}`)
          .join(",\n  ")};`;
      if (driver === "mysql")
        return `INSERT INTO ${name} (${editable.map((c) => q(c.name)).join(", ")})\nVALUES (${editable.map(() => "?").join(", ")})\nON DUPLICATE KEY UPDATE\n  ${editable
          .filter((c) => !c.primaryKey)
          .map((c) => `${q(c.name)} = VALUES(${q(c.name)})`)
          .join(",\n  ")};`;
      if (driver === "sqlite")
        return `INSERT OR REPLACE INTO ${name} (${editable.map((c) => q(c.name)).join(", ")})\nVALUES (${editable.map(() => "?").join(", ")});`;
      return `MERGE ${name} AS target\nUSING (SELECT ${editable.map((c) => `? AS ${q(c.name)}`).join(", ")}) AS source\nON ${keyCols
        .map((c) => `target.${q(c.name)} = source.${q(c.name)}`)
        .join(" AND ")}\nWHEN MATCHED THEN UPDATE SET ${editable
        .filter((c) => !c.primaryKey)
        .map((c) => `${q(c.name)} = source.${q(c.name)}`)
        .join(", ")}\nWHEN NOT MATCHED THEN INSERT (${editable.map((c) => q(c.name)).join(", ")}) VALUES (${editable.map((c) => `source.${q(c.name)}`).join(", ")});`;
    }
  }
}

export function truncateSql(driver: Driver, t: TableRef, currentDatabase?: string): string {
  const name = qualified(driver, t, currentDatabase);
  return driver === "sqlite" ? `DELETE FROM ${name}` : `TRUNCATE TABLE ${name}`;
}

export function dropSql(driver: Driver, kind: string, t: TableRef, signature?: string | null, currentDatabase?: string): string {
  const name = qualified(driver, t, currentDatabase);
  const word =
    kind === "matview" ? "MATERIALIZED VIEW" : kind === "foreign" ? "FOREIGN TABLE" : kind === "view" ? "VIEW" : kind.toUpperCase();
  const sig = (kind === "function" || kind === "procedure") && driver === "postgres" ? `(${signature ?? ""})` : "";
  if (kind === "trigger" && driver === "postgres") return `-- DROP TRIGGER needs its table:\nDROP TRIGGER ${ident(driver, t.name)} ON <table>`;
  return `DROP ${word} ${name}${sig}`;
}

export function renameSql(driver: Driver, t: TableRef, newName: string, currentDatabase?: string): string {
  const name = qualified(driver, t, currentDatabase);
  switch (driver) {
    case "mysql":
      return `RENAME TABLE ${name} TO ${qualified(driver, { ...t, name: newName }, currentDatabase)}`;
    case "mssql":
      return `EXEC sp_rename ${stringLiteral(driver, `${t.schema ?? "dbo"}.${t.name}`)}, ${stringLiteral(driver, newName)}`;
    default:
      return `ALTER TABLE ${name} RENAME TO ${ident(driver, newName)}`;
  }
}

/** A CREATE TABLE skeleton for a new table. */
export function createTableTemplate(driver: Driver, t: TableRef, currentDatabase?: string): string {
  const name = qualified(driver, t, currentDatabase);
  const id =
    driver === "postgres"
      ? "id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY"
      : driver === "mysql"
        ? "id BIGINT AUTO_INCREMENT PRIMARY KEY"
        : driver === "mssql"
          ? "id BIGINT IDENTITY(1,1) PRIMARY KEY"
          : "id INTEGER PRIMARY KEY AUTOINCREMENT";
  const text = driver === "mssql" ? "NVARCHAR(200)" : driver === "postgres" ? "text" : "VARCHAR(200)";
  const ts = driver === "mssql" ? "DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()" : driver === "mysql" ? "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP" : driver === "postgres" ? "timestamptz NOT NULL DEFAULT now()" : "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP";
  return `CREATE TABLE ${name} (\n  ${id},\n  name ${text} NOT NULL,\n  created_at ${ts}\n);`;
}

/** SQL statements that only read (allowed on read-only connections). */
export function isReadOnlyStatement(sql: string): boolean {
  const first = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim()
    .split(/[\s(]+/)[0]
    ?.toUpperCase();
  return ["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "VALUES", "TABLE", "PRAGMA", "USE", "SET"].includes(first ?? "") && !/\binto\b/i.test(sql.slice(0, 2000)) ;
}

/** UPDATE / DELETE without a WHERE clause (asks before running). */
export function isUnboundedChange(sql: string): boolean {
  const t = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").replace(/'(?:[^']|'')*'/g, "''").trim();
  return /^(update|delete)\b/i.test(t) && !/\bwhere\b/i.test(t);
}

/** Statements that change data or structure (confirmation on production connections). */
export function isModifying(sql: string): boolean {
  const first = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").trim().split(/\s+/)[0]?.toUpperCase();
  return ["INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "DROP", "ALTER", "CREATE", "GRANT", "REVOKE", "REPLACE", "UPSERT", "RENAME"].includes(first ?? "");
}

/** `SELECT * FROM <table>` (optionally filtered / sorted): the grid can edit its rows. */
export function editableSource(sql: string): { name: string; schema: string | null; database: string | null } | null {
  const m = /^\s*select\s+\*\s+from\s+((?:[\w$]+|"[^"]+"|`[^`]+`|\[[^\]]+\])(?:\s*\.\s*(?:[\w$]+|"[^"]+"|`[^`]+`|\[[^\]]+\])){0,2})\s*(?:(?:as\s+)?\w+\s*)?(?:where\b[\s\S]*|order\s+by\b[\s\S]*|limit\b[\s\S]*)?;?\s*$/i.exec(sql);
  if (!m) return null;
  if (/\b(join|union|group\s+by|having|distinct)\b/i.test(sql)) return null;
  const parts = m[1].split(/\s*\.\s*/).map((p) => p.replace(/^["`[]|["`\]]$/g, ""));
  const name = parts.pop()!;
  const schema = parts.pop() ?? null;
  const database = parts.pop() ?? null;
  return { name, schema, database };
}
