/** Shapes shared with the Rust core (src-tauri/src/models.rs). */

export type Driver = "postgres" | "mysql" | "sqlite" | "mssql";
export type Environment = "development" | "test" | "production";

export interface ConnectionConfig {
  id: string;
  name: string;
  driver: Driver;
  host: string;
  port: number;
  database: string;
  user: string;
  filePath: string;
  sslMode: "disable" | "prefer" | "require" | "verify-ca" | "verify-full";
  trustServerCertificate: boolean;
  windowsAuth: boolean;
  savePassword: boolean;
  readOnly: boolean;
  environment: Environment;
  color: string | null;
  folder: string;
  showAllDatabases: boolean;
  initSql: string;
  connectTimeout: number;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface ConnectionEntry extends ConnectionConfig {
  hasPassword: boolean;
  connected: boolean;
}

export interface Secrets {
  /** null/undefined keeps the saved password. */
  password?: string | null;
}

export interface TestReport {
  serverVersion: string;
  elapsedMs: number;
}

export interface ServerInfo {
  driver: Driver;
  version: string;
  database: string;
}

export type ColumnKind = "number" | "text" | "bool" | "date" | "json" | "binary" | "uuid" | "other";

export interface ColumnInfo {
  name: string;
  typeName: string;
  kind: ColumnKind;
}

export type Cell = string | null;

export interface StatementResult {
  columns: ColumnInfo[];
  rows: Cell[][];
  rowsAffected: number | null;
  hasMore: boolean;
  elapsedMs: number;
}

export interface ExecuteResponse {
  results: StatementResult[];
  inTransaction: boolean;
  transactionStatements: number;
}

export interface SessionState {
  id: string;
  database: string;
  schema: string | null;
  autoCommit: boolean;
  inTransaction: boolean;
  transactionStatements: number;
}

export interface DatabaseInfo {
  name: string;
  system: boolean;
}

export interface SchemaInfo {
  name: string;
  system: boolean;
}

export type ObjectKind = "table" | "view" | "matview" | "foreign" | "function" | "procedure" | "sequence" | "trigger";

export interface DbObject {
  name: string;
  kind: ObjectKind;
  comment: string | null;
  rows: number | null;
  signature: string | null;
  parent: string | null;
}

export interface ColumnDef {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
  autoIncrement: boolean;
  comment: string | null;
}

export interface IndexDef {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  method: string | null;
  definition: string | null;
}

export interface ForeignKeyDef {
  name: string;
  columns: string[];
  refSchema: string | null;
  refTable: string;
  refColumns: string[];
  onUpdate: string | null;
  onDelete: string | null;
}

export interface ReferenceDef {
  name: string;
  schema: string | null;
  table: string;
  columns: string[];
  refColumns: string[];
}

export interface TriggerDef {
  name: string;
  event: string | null;
  definition: string | null;
}

export interface ConstraintDef {
  name: string;
  kind: string;
  definition: string;
}

export interface TableInfo {
  name: string;
  kind: string;
  comment: string | null;
  columns: ColumnDef[];
  primaryKey: string[];
  indexes: IndexDef[];
  foreignKeys: ForeignKeyDef[];
  references: ReferenceDef[];
  triggers: TriggerDef[];
  constraints: ConstraintDef[];
  properties: [string, string][];
}

export interface ModelColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
}

export interface ModelTable {
  name: string;
  kind: string;
  columns: ModelColumn[];
  foreignKeys: ForeignKeyDef[];
}

export interface ServerSession {
  id: string;
  user: string | null;
  database: string | null;
  client: string | null;
  application: string | null;
  state: string | null;
  started: string | null;
  queryStart: string | null;
  wait: string | null;
  query: string | null;
}

export type ExportFormat = "csv" | "tsv" | "json" | "sql" | "markdown" | "xml" | "html";

export interface ExportOptions {
  format: ExportFormat;
  path: string;
  delimiter: string;
  header: boolean;
  nullText: string;
  quoteAll: boolean;
  tableName: string;
  batchSize: number;
  bom: boolean;
}

/** Error shape of every failing command. */
export interface AppErrorShape {
  kind: "sql" | "connection" | "auth" | "secret" | "not_found" | "invalid" | "cancelled" | "forbidden" | "io" | "json";
  message: string;
}
