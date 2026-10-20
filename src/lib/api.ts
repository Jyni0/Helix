import type {
  AppErrorShape,
  ConnectionConfig,
  ConnectionEntry,
  DatabaseInfo,
  DbObject,
  ExecuteResponse,
  ExportOptions,
  ModelTable,
  SchemaInfo,
  Secrets,
  ServerInfo,
  ServerSession,
  SessionState,
  StatementResult,
  TableInfo,
  TestReport,
} from "./types";
import { createMockBackend } from "./mockBackend";

export type Unlisten = () => void;

/** Typed facade over the Rust IPC commands. */
export interface HelixApi {
  listConnections(): Promise<ConnectionEntry[]>;
  saveConnection(config: ConnectionConfig, secrets?: Secrets): Promise<ConnectionConfig>;
  deleteConnection(id: string): Promise<void>;
  reorderConnections(ids: string[]): Promise<void>;
  testConnection(config: ConnectionConfig, secrets?: Secrets): Promise<TestReport>;
  connect(id: string, password?: string | null): Promise<ServerInfo>;
  disconnect(id: string): Promise<void>;

  listDatabases(id: string): Promise<DatabaseInfo[]>;
  listSchemas(id: string, database: string): Promise<SchemaInfo[]>;
  listObjects(id: string, database: string, schema: string | null): Promise<DbObject[]>;
  tableInfo(id: string, database: string, schema: string | null, table: string): Promise<TableInfo>;
  objectDdl(id: string, database: string, schema: string | null, name: string, kind: string, signature?: string | null): Promise<string>;
  schemaModel(id: string, database: string, schema: string | null): Promise<ModelTable[]>;
  serverSessions(id: string): Promise<ServerSession[]>;
  killServerSession(id: string, session: string, cancelOnly: boolean): Promise<void>;
  /** Runs SQL on the navigator's connection of `database` (auto-commit). */
  metaQuery(id: string, database: string, sql: string): Promise<StatementResult[]>;

  openSession(id: string, database: string | null, schema: string | null, autoCommit: boolean): Promise<SessionState>;
  closeSession(id: string, sessionId: string): Promise<void>;
  sessionState(id: string, sessionId: string): Promise<SessionState>;
  setSessionScope(id: string, sessionId: string, database: string, schema: string | null): Promise<SessionState>;
  setAutoCommit(id: string, sessionId: string, autoCommit: boolean): Promise<SessionState>;
  endTransaction(id: string, sessionId: string, commit: boolean): Promise<SessionState>;
  execute(id: string, sessionId: string, queryId: string, sql: string, limit: number): Promise<ExecuteResponse>;
  cancelQuery(id: string, queryId: string): Promise<void>;
  explain(id: string, sessionId: string, sql: string, analyze: boolean): Promise<StatementResult[]>;
  executeBatch(id: string, sessionId: string, statements: string[]): Promise<(number | null)[]>;

  exportQuery(id: string, database: string, sql: string, options: ExportOptions, exportId: string, onProgress?: (rows: number) => void): Promise<number>;
  exportCancel(exportId: string): Promise<void>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, contents: string): Promise<void>;
  pickOpenFile(filters: { name: string; extensions: string[] }[], title?: string): Promise<string | null>;
  pickSaveFile(defaultPath: string, filters: { name: string; extensions: string[] }[]): Promise<string | null>;
  revealPath(path: string): Promise<void>;
  openUrl(url: string): Promise<void>;

  /** `digest`: GitHub's "sha256:…" of the asset; the download must match it. */
  updateDownload(url: string, name: string, digest: string | null, onProgress?: (received: number, total: number | null) => void): Promise<string>;
  updateInstall(path: string): Promise<void>;
  platform(): Promise<{ os: string; arch: string }>;
  quit(): Promise<void>;
}

export const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function createTauriApi(): HelixApi {
  // Loaded lazily so the browser/test build never touches Tauri internals.
  const core = import("@tauri-apps/api/core");
  const event = import("@tauri-apps/api/event");
  const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => (await core).invoke<T>(cmd, args);

  return {
    listConnections: () => invoke("list_connections"),
    saveConnection: (config, secrets) => invoke("save_connection", { config, secrets: secrets ?? null }),
    deleteConnection: (id) => invoke("delete_connection", { id }),
    reorderConnections: (ids) => invoke("reorder_connections", { ids }),
    testConnection: (config, secrets) => invoke("test_connection", { config, secrets: secrets ?? null }),
    connect: (id, password) => invoke("connect", { id, password: password ?? null }),
    disconnect: (id) => invoke("disconnect", { id }),

    listDatabases: (id) => invoke("list_databases", { id }),
    listSchemas: (id, database) => invoke("list_schemas", { id, database }),
    listObjects: (id, database, schema) => invoke("list_objects", { id, database, schema }),
    tableInfo: (id, database, schema, table) => invoke("table_info", { id, database, schema, table }),
    objectDdl: (id, database, schema, name, kind, signature) => invoke("object_ddl", { id, database, schema, name, kind, signature: signature ?? null }),
    schemaModel: (id, database, schema) => invoke("schema_model", { id, database, schema }),
    serverSessions: (id) => invoke("server_sessions", { id }),
    killServerSession: (id, session, cancelOnly) => invoke("kill_server_session", { id, session, cancelOnly }),
    metaQuery: (id, database, sql) => invoke("meta_query", { id, database, sql }),

    openSession: (id, database, schema, autoCommit) => invoke("open_session", { id, database, schema, autoCommit }),
    closeSession: (id, sessionId) => invoke("close_session", { id, sessionId }),
    sessionState: (id, sessionId) => invoke("session_state", { id, sessionId }),
    setSessionScope: (id, sessionId, database, schema) => invoke("set_session_scope", { id, sessionId, database, schema }),
    setAutoCommit: (id, sessionId, autoCommit) => invoke("set_auto_commit", { id, sessionId, autoCommit }),
    endTransaction: (id, sessionId, commit) => invoke("end_transaction", { id, sessionId, commit }),
    execute: (id, sessionId, queryId, sql, limit) => invoke("execute", { id, sessionId, queryId, sql, limit }),
    cancelQuery: (id, queryId) => invoke("cancel_query", { id, queryId }),
    explain: (id, sessionId, sql, analyze) => invoke("explain", { id, sessionId, sql, analyze }),
    executeBatch: (id, sessionId, statements) => invoke("execute_batch", { id, sessionId, statements }),

    async exportQuery(id, database, sql, options, exportId, onProgress) {
      const off = onProgress
        ? await (await event).listen<{ exportId: string; rows: number }>("export:progress", (e) => e.payload.exportId === exportId && onProgress(e.payload.rows))
        : null;
      try {
        return await invoke<number>("export_query", { id, database, sql, options, exportId });
      } finally {
        off?.();
      }
    },
    exportCancel: (exportId) => invoke("export_cancel", { exportId }),
    readTextFile: (path) => invoke("read_text_file", { path }),
    writeTextFile: (path, contents) => invoke("write_text_file", { path, contents }),
    // Dialogs run in the core: only files picked there may be read / written.
    pickOpenFile: (filters, title) => invoke("pick_open_file", { filters, title: title ?? null }),
    pickSaveFile: (defaultPath, filters) => invoke("pick_save_file", { defaultPath, filters }),
    async revealPath(path) {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(path);
    },
    async openUrl(url) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    },

    async updateDownload(url, name, digest, onProgress) {
      const off = onProgress
        ? await (await event).listen<{ received: number; total: number | null }>("update-progress", (e) => onProgress(e.payload.received, e.payload.total ?? null))
        : null;
      try {
        return await invoke<string>("update_download", { url, name, digest });
      } finally {
        off?.();
      }
    },
    updateInstall: (path) => invoke("update_install", { path }),
    async platform() {
      const [os, arch] = await invoke<[string, string]>("update_platform");
      return { os, arch };
    },
    quit: () => invoke("quit_app"),
  };
}

let impl: HelixApi = isTauri() ? createTauriApi() : createMockBackend({ latencyMs: 80 });

/** Swaps the backend (tests inject a fresh mock per test). */
export function setApi(next: HelixApi) {
  impl = next;
}

export const api: HelixApi = new Proxy({} as HelixApi, {
  get: (_target, key) => impl[key as keyof HelixApi],
});

export function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return "Something went wrong";
}

export function errorKind(err: unknown): AppErrorShape["kind"] | null {
  if (err && typeof err === "object" && "kind" in err) return (err as AppErrorShape).kind;
  return null;
}
