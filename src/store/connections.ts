import { create } from "zustand";
import { api, errorKind, errorMessage } from "@/lib/api";
import { DEFAULT_PORT } from "@/lib/sql/dialect";
import type { ConnectionConfig, ConnectionEntry, DbObject, Driver, ModelTable, ObjectKind, ServerInfo, TableInfo } from "@/lib/types";
import { prefs, toast, useUi } from "./ui";

// ---------------------------------------------------------------- navigator tree

export type NodeType = "connection" | "database" | "schema" | "category" | "object" | "column";

export interface TreeNode {
  key: string;
  type: NodeType;
  label: string;
  connId: string;
  database?: string;
  schema?: string | null;
  category?: ObjectKind;
  object?: DbObject;
  /** Right-aligned hint (column type, row count…). */
  hint?: string;
  system?: boolean;
  primaryKey?: boolean;
  foreignKey?: boolean;
  leaf?: boolean;
}

export interface Children {
  state: "loading" | "ready" | "error";
  nodes: TreeNode[];
  error?: string;
}

export const CATEGORY_ORDER: ObjectKind[] = ["table", "view", "matview", "foreign", "function", "procedure", "sequence", "trigger"];
export const CATEGORY_LABEL: Record<ObjectKind, string> = {
  table: "Tables",
  view: "Views",
  matview: "Materialized Views",
  foreign: "Foreign Tables",
  function: "Functions",
  procedure: "Procedures",
  sequence: "Sequences",
  trigger: "Triggers",
};

/** Kinds whose rows can be browsed. */
export const isRelation = (k: ObjectKind | string) => k === "table" || k === "view" || k === "matview" || k === "foreign";

export function blankConnection(driver: Driver = "postgres"): ConnectionConfig {
  return {
    id: "",
    name: "",
    driver,
    host: driver === "sqlite" ? "" : "localhost",
    port: DEFAULT_PORT[driver],
    database: driver === "postgres" ? "postgres" : "",
    user: driver === "postgres" ? "postgres" : driver === "mysql" ? "root" : driver === "mssql" ? "sa" : "",
    filePath: "",
    sslMode: "prefer",
    trustServerCertificate: true,
    windowsAuth: false,
    savePassword: true,
    readOnly: false,
    environment: "development",
    color: null,
    folder: "",
    showAllDatabases: true,
    initSql: "",
    connectTimeout: 15,
    createdAt: 0,
    lastUsedAt: null,
  };
}

interface ConnState {
  connections: ConnectionEntry[];
  loaded: boolean;
  status: Record<string, "connecting" | "connected" | "error" | undefined>;
  servers: Record<string, ServerInfo>;
  /** Connection dialog: the draft being edited (null = closed). */
  editing: ConnectionConfig | null;
  children: Record<string, Children>;
  expanded: Record<string, boolean>;
  /** listObjects results per `${conn}|${db}|${schema}`. */
  objects: Record<string, DbObject[]>;
  filter: string;
  selectedKey: string | null;

  load(): Promise<void>;
  get(id: string): ConnectionEntry | undefined;
  openEditor(config?: ConnectionConfig): void;
  closeEditor(): void;
  save(config: ConnectionConfig, password?: string | null): Promise<ConnectionConfig>;
  remove(id: string): Promise<void>;
  duplicate(id: string): Promise<void>;
  /** Connects (asking for a password when none is saved); false when it failed or was cancelled. */
  ensureConnected(id: string): Promise<boolean>;
  disconnect(id: string): Promise<void>;
  reconnect(id: string): Promise<void>;
  setFilter(f: string): void;
  select(key: string | null): void;
  toggle(node: TreeNode, open?: boolean): Promise<void>;
  loadChildren(node: TreeNode, force?: boolean): Promise<void>;
  /** Drops cached children under `prefix` and reloads expanded ones. */
  refresh(node: TreeNode): Promise<void>;
  collapseAll(): void;
  objectsOf(connId: string, database: string, schema: string | null, force?: boolean): Promise<DbObject[]>;
}

const objKey = (c: string, d: string, s: string | null) => `${c}|${d}|${s ?? ""}`;

function connNode(c: ConnectionEntry): TreeNode {
  return { key: `c:${c.id}`, type: "connection", label: c.name, connId: c.id };
}

let firstLoad: Promise<void> | null = null;

export const useConnections = create<ConnState>((set, get) => ({
  connections: [],
  loaded: false,
  status: {},
  servers: {},
  editing: null,
  children: {},
  expanded: {},
  objects: {},
  filter: "",
  selectedKey: null,

  async load() {
    try {
      const connections = await api.listConnections();
      const status = { ...get().status };
      for (const c of connections) if (c.connected && !status[c.id]) status[c.id] = "connected";
      set({ connections, loaded: true, status });
    } catch (e) {
      set({ loaded: true });
      toast("Could not read saved connections", "error", errorMessage(e));
    }
  },

  get: (id) => get().connections.find((c) => c.id === id),

  openEditor: (config) => set({ editing: config ?? blankConnection() }),
  closeEditor: () => set({ editing: null }),

  async save(config, password) {
    const wasConnected = !!config.id && get().status[config.id] === "connected";
    const saved = await api.saveConnection(config, { password: password ?? null });
    if (wasConnected) get().collapseAll();
    await get().load();
    if (config.id) {
      // Settings changed: cached tree and connection state are stale.
      set((s) => ({
        status: { ...s.status, [config.id]: undefined },
        children: Object.fromEntries(Object.entries(s.children).filter(([k]) => !k.startsWith(`c:${config.id}`))),
        expanded: Object.fromEntries(Object.entries(s.expanded).filter(([k]) => !k.startsWith(`c:${config.id}`))),
      }));
    }
    return saved;
  },

  async remove(id) {
    await api.deleteConnection(id);
    set((s) => ({
      connections: s.connections.filter((c) => c.id !== id),
      children: Object.fromEntries(Object.entries(s.children).filter(([k]) => !k.startsWith(`c:${id}`))),
    }));
  },

  async duplicate(id) {
    const c = get().get(id);
    if (!c) return;
    const { hasPassword: _h, connected: _c, ...config } = c;
    get().openEditor({ ...config, id: "", name: `${c.name} (copy)` });
  },

  async ensureConnected(id) {
    const st = get().status[id];
    if (st === "connected") return true;
    // Tabs restored on start can ask before the saved list was read.
    if (!get().loaded) {
      await (firstLoad ??= get().load());
      if (get().status[id] === "connected") return true;
    }
    const c = get().get(id);
    if (!c) return false;
    set((s) => ({ status: { ...s.status, [id]: "connecting" } }));
    let password: string | null = null;
    // No saved password: ask (SQLite and Windows auth need none).
    const needsPassword = c.driver !== "sqlite" && !c.windowsAuth && !c.hasPassword;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (needsPassword || attempt > 0) {
        password = await useUi.getState().prompt({
          title: `Connect to ${c.name}`,
          message: attempt > 0 ? "Authentication failed. Try again." : `Password for ${c.user || "the user"}@${c.host || c.filePath}`,
          label: "Password",
          password: true,
          okLabel: "Connect",
        });
        if (password === null) {
          set((s) => ({ status: { ...s.status, [id]: undefined } }));
          return false;
        }
      }
      try {
        const info = await api.connect(id, password);
        set((s) => ({ status: { ...s.status, [id]: "connected" }, servers: { ...s.servers, [id]: info } }));
        if (password !== null && c.savePassword) set((s) => ({ connections: s.connections.map((x) => (x.id === id ? { ...x, hasPassword: true } : x)) }));
        return true;
      } catch (e) {
        if (errorKind(e) === "auth" && c.driver !== "sqlite" && !c.windowsAuth) continue;
        set((s) => ({ status: { ...s.status, [id]: "error" } }));
        toast(`Could not connect to ${c.name}`, "error", errorMessage(e));
        return false;
      }
    }
    set((s) => ({ status: { ...s.status, [id]: "error" } }));
    return false;
  },

  async disconnect(id) {
    await api.disconnect(id).catch(() => {});
    const prefix = `c:${id}`;
    set((s) => ({
      status: { ...s.status, [id]: undefined },
      children: Object.fromEntries(Object.entries(s.children).filter(([k]) => !k.startsWith(prefix))),
      expanded: Object.fromEntries(Object.entries(s.expanded).filter(([k]) => !k.startsWith(prefix))),
      objects: Object.fromEntries(Object.entries(s.objects).filter(([k]) => !k.startsWith(`${id}|`))),
    }));
    modelCache.forEach((_, k) => k.startsWith(`${id}|`) && modelCache.delete(k));
    infoCache.forEach((_, k) => k.startsWith(`${id}|`) && infoCache.delete(k));
  },

  async reconnect(id) {
    await get().disconnect(id);
    if (await get().ensureConnected(id)) {
      const c = get().get(id);
      if (c) await get().toggle(connNode(c), true);
    }
  },

  setFilter: (filter) => set({ filter }),
  select: (selectedKey) => set({ selectedKey }),

  async toggle(node, open) {
    const now = open ?? !get().expanded[node.key];
    set((s) => ({ expanded: { ...s.expanded, [node.key]: now } }));
    if (now && !get().children[node.key]) await get().loadChildren(node);
  },

  async loadChildren(node, force = false) {
    const key = node.key;
    if (!force && get().children[key]?.state === "loading") return;
    set((s) => ({ children: { ...s.children, [key]: { state: "loading", nodes: s.children[key]?.nodes ?? [] } } }));
    try {
      const nodes = await childrenOf(node, force);
      set((s) => ({ children: { ...s.children, [key]: { state: "ready", nodes } } }));
    } catch (e) {
      set((s) => ({ children: { ...s.children, [key]: { state: "error", nodes: [], error: errorMessage(e) } } }));
    }
  },

  async refresh(node) {
    const prefix = node.key;
    const objPrefix = node.type === "connection" ? `${node.connId}|` : objKey(node.connId, node.database ?? "", node.schema ?? null);
    set((s) => ({
      children: Object.fromEntries(Object.entries(s.children).filter(([k]) => !k.startsWith(prefix))),
      objects: Object.fromEntries(Object.entries(s.objects).filter(([k]) => !k.startsWith(objPrefix))),
    }));
    modelCache.forEach((_, k) => k.startsWith(`${node.connId}|`) && modelCache.delete(k));
    infoCache.forEach((_, k) => k.startsWith(`${node.connId}|`) && infoCache.delete(k));
    // Reload what is open, top-down.
    const open = Object.keys(get().expanded)
      .filter((k) => k.startsWith(prefix) && get().expanded[k])
      .sort((a, b) => a.length - b.length);
    if (get().expanded[prefix] || node.type === "connection") await get().loadChildren(node, true);
    for (const k of open) {
      if (k === prefix) continue;
      const n = findNode(k);
      if (n) await get().loadChildren(n, true);
    }
  },

  collapseAll: () => set({ expanded: {} }),

  async objectsOf(connId, database, schema, force = false) {
    const k = objKey(connId, database, schema);
    if (!force && get().objects[k]) return get().objects[k];
    const list = await api.listObjects(connId, database, schema);
    set((s) => ({ objects: { ...s.objects, [k]: list } }));
    return list;
  },
}));

/** A loaded node by key. */
export function findNode(key: string): TreeNode | undefined {
  const { children, connections } = useConnections.getState();
  for (const c of connections) if (`c:${c.id}` === key) return connNode(c);
  for (const ch of Object.values(children)) {
    const n = ch.nodes.find((x) => x.key === key);
    if (n) return n;
  }
  return undefined;
}

function categoryNodes(base: TreeNode, objects: DbObject[]): TreeNode[] {
  const kinds = CATEGORY_ORDER.filter((k) => k === "table" || objects.some((o) => o.kind === k));
  return kinds.map((k) => ({
    key: `${base.key}/k:${k}`,
    type: "category",
    label: CATEGORY_LABEL[k],
    connId: base.connId,
    database: base.database,
    schema: base.schema ?? null,
    category: k,
    hint: String(objects.filter((o) => o.kind === k).length),
  }));
}

async function childrenOf(node: TreeNode, force: boolean): Promise<TreeNode[]> {
  const st = useConnections.getState();
  const showSystem = prefs().showSystemObjects;
  const conn = st.get(node.connId);
  if (!conn) return [];
  switch (node.type) {
    case "connection": {
      if (!(await st.ensureConnected(node.connId))) throw new Error("Not connected");
      const dbs = (await api.listDatabases(node.connId)).filter((d) => showSystem || !d.system);
      // A plain SQLite file: its objects right under the connection.
      if (conn.driver === "sqlite" && dbs.length <= 1) {
        const objects = await st.objectsOf(node.connId, "main", null, force);
        return categoryNodes({ ...node, database: "main", schema: null }, objects);
      }
      return dbs.map((d) => ({
        key: `${node.key}/d:${d.name}`,
        type: "database",
        label: d.name,
        connId: node.connId,
        database: d.name,
        system: d.system,
      }));
    }
    case "database": {
      if (conn.driver === "postgres" || conn.driver === "mssql") {
        const schemas = (await api.listSchemas(node.connId, node.database!)).filter((s) => showSystem || !s.system);
        return schemas.map((s) => ({
          key: `${node.key}/s:${s.name}`,
          type: "schema",
          label: s.name,
          connId: node.connId,
          database: node.database,
          schema: s.name,
          system: s.system,
        }));
      }
      const objects = await st.objectsOf(node.connId, node.database!, null, force);
      return categoryNodes({ ...node, schema: null }, objects);
    }
    case "schema": {
      const objects = await st.objectsOf(node.connId, node.database!, node.schema ?? null, force);
      return categoryNodes(node, objects);
    }
    case "category": {
      const objects = await st.objectsOf(node.connId, node.database!, node.schema ?? null, force);
      return objects
        .filter((o) => o.kind === node.category)
        .map((o) => ({
          key: `${node.key}/o:${o.name}${o.signature ? `(${o.signature})` : ""}`,
          type: "object",
          label: o.name,
          connId: node.connId,
          database: node.database,
          schema: node.schema ?? null,
          object: o,
          hint: o.signature !== null && o.signature !== undefined ? `(${o.signature})` : o.parent ? `on ${o.parent}` : undefined,
          leaf: !isRelation(o.kind),
        }));
    }
    case "object": {
      const info = await tableInfo(node.connId, node.database!, node.schema ?? null, node.object!.name, force);
      const fkCols = new Set(info.foreignKeys.flatMap((f) => f.columns));
      return info.columns.map((c) => ({
        key: `${node.key}/col:${c.name}`,
        type: "column",
        label: c.name,
        connId: node.connId,
        database: node.database,
        schema: node.schema ?? null,
        hint: c.dataType + (c.nullable ? "" : " not null"),
        primaryKey: c.primaryKey,
        foreignKey: fkCols.has(c.name),
        leaf: true,
      }));
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------- metadata caches

const infoCache = new Map<string, Promise<TableInfo>>();
const modelCache = new Map<string, Promise<ModelTable[]>>();

/** Table structure (cached; `force` re-reads it). */
export function tableInfo(connId: string, database: string, schema: string | null, table: string, force = false): Promise<TableInfo> {
  const k = `${connId}|${database}|${schema ?? ""}|${table}`;
  if (force || !infoCache.has(k)) {
    const p = api.tableInfo(connId, database, schema, table);
    infoCache.set(k, p);
    p.catch(() => infoCache.delete(k));
  }
  return infoCache.get(k)!;
}

/** Every table with columns of a schema (ER diagram, autocomplete). */
export function schemaModel(connId: string, database: string, schema: string | null, force = false): Promise<ModelTable[]> {
  const k = `${connId}|${database}|${schema ?? ""}`;
  if (force || !modelCache.has(k)) {
    const p = api.schemaModel(connId, database, schema);
    modelCache.set(k, p);
    p.catch(() => modelCache.delete(k));
  }
  return modelCache.get(k)!;
}

export function invalidateTable(connId: string, database: string, schema: string | null, table: string) {
  infoCache.delete(`${connId}|${database}|${schema ?? ""}|${table}`);
  modelCache.delete(`${connId}|${database}|${schema ?? ""}`);
}

/** The schema a fresh session sees by default. */
export function defaultSchema(driver: Driver): string | null {
  return driver === "postgres" ? "public" : driver === "mssql" ? "dbo" : null;
}
