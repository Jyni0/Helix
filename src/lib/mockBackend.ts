/**
 * In-memory backend with the same contract as the Rust core: the browser
 * preview (`npm run dev`, `?demo` for sample connections), component tests
 * and the e2e suite run against it. It understands just enough SQL —
 * SELECT … FROM one table with simple WHERE / ORDER BY, INSERT / UPDATE /
 * DELETE by literal values — to make the UI behave for real.
 */
import type { HelixApi } from "./api";
import type {
  Cell,
  ColumnInfo,
  ColumnKind,
  ConnectionConfig,
  ConnectionEntry,
  DbObject,
  ModelTable,
  SessionState,
  StatementResult,
  TableInfo,
} from "./types";

interface MockColumn {
  name: string;
  type: string;
  kind: ColumnKind;
  nullable?: boolean;
  pk?: boolean;
  auto?: boolean;
  default?: string;
  fk?: { table: string; column: string };
}

interface MockTable {
  name: string;
  schema: string;
  kind: "table" | "view";
  comment?: string;
  columns: MockColumn[];
  rows: Cell[][];
}

const COUNTRIES = ["Germany", "France", "Japan", "Brazil", "Canada", "Kenya", "Norway", "India", "Chile", "Spain"];
const FIRST = ["Ada", "Linus", "Grace", "Alan", "Margaret", "Dennis", "Barbara", "Ken", "Edsger", "Frances", "Tim", "Radia"];
const LAST = ["Lovelace", "Torvalds", "Hopper", "Turing", "Hamilton", "Ritchie", "Liskov", "Thompson", "Dijkstra", "Allen", "Berners-Lee", "Perlman"];
const STATUS = ["new", "paid", "shipped", "delivered", "cancelled"];
const PRODUCTS = ["Keyboard", "Mouse", "Monitor", "Headset", "Webcam", "Dock", "Cable", "Chair", "Desk lamp", "Microphone"];

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function day(base: number, offset: number) {
  return new Date(base + offset * 86_400_000).toISOString().slice(0, 10);
}

function demoTables(): MockTable[] {
  const rnd = seeded(7);
  const base = Date.UTC(2025, 0, 1);
  const customers: Cell[][] = Array.from({ length: 340 }, (_, i) => {
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 7) % LAST.length];
    return [
      String(i + 1),
      `${first} ${last}`,
      i % 9 === 4 ? null : `${first.toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g, "")}${i}@example.com`,
      COUNTRIES[Math.floor(rnd() * COUNTRIES.length)],
      `${day(base, Math.floor(rnd() * 600))} 09:${String(i % 60).padStart(2, "0")}:00`,
      rnd() > 0.15 ? "true" : "false",
    ];
  });
  const products: Cell[][] = PRODUCTS.map((p, i) => [
    String(i + 1),
    `SKU-${1000 + i}`,
    p,
    (19.9 + i * 12.35).toFixed(2),
    String(Math.floor(rnd() * 500)),
    JSON.stringify({ color: ["black", "white", "grey"][i % 3], warranty: 1 + (i % 3) }),
  ]);
  const orders: Cell[][] = Array.from({ length: 1200 }, (_, i) => [
    String(i + 1),
    String(1 + Math.floor(rnd() * 340)),
    String(1 + Math.floor(rnd() * PRODUCTS.length)),
    (5 + rnd() * 900).toFixed(2),
    STATUS[Math.floor(rnd() * STATUS.length)],
    `${day(base, Math.floor(rnd() * 600))} ${String(Math.floor(rnd() * 24)).padStart(2, "0")}:15:00+00`,
    i % 11 === 0 ? "Gift wrap, please" : null,
  ]);
  return [
    {
      name: "customers",
      schema: "public",
      kind: "table",
      comment: "People who buy things",
      columns: [
        { name: "id", type: "integer", kind: "number", pk: true, auto: true, default: "nextval('customers_id_seq'::regclass)" },
        { name: "name", type: "character varying(120)", kind: "text" },
        { name: "email", type: "character varying(200)", kind: "text", nullable: true },
        { name: "country", type: "text", kind: "text", nullable: true },
        { name: "created_at", type: "timestamp without time zone", kind: "date", default: "now()" },
        { name: "active", type: "boolean", kind: "bool", default: "true" },
      ],
      rows: customers,
    },
    {
      name: "products",
      schema: "public",
      kind: "table",
      columns: [
        { name: "id", type: "integer", kind: "number", pk: true, auto: true },
        { name: "sku", type: "character varying(32)", kind: "text" },
        { name: "name", type: "text", kind: "text" },
        { name: "price", type: "numeric(10,2)", kind: "number" },
        { name: "stock", type: "integer", kind: "number" },
        { name: "attributes", type: "jsonb", kind: "json", nullable: true },
      ],
      rows: products,
    },
    {
      name: "orders",
      schema: "public",
      kind: "table",
      columns: [
        { name: "id", type: "bigint", kind: "number", pk: true, auto: true },
        { name: "customer_id", type: "integer", kind: "number", fk: { table: "customers", column: "id" } },
        { name: "product_id", type: "integer", kind: "number", fk: { table: "products", column: "id" } },
        { name: "total", type: "numeric(10,2)", kind: "number" },
        { name: "status", type: "character varying(20)", kind: "text", default: "'new'::character varying" },
        { name: "ordered_at", type: "timestamp with time zone", kind: "date" },
        { name: "notes", type: "text", kind: "text", nullable: true },
      ],
      rows: orders,
    },
    {
      name: "big_orders",
      schema: "public",
      kind: "view",
      columns: [
        { name: "id", type: "bigint", kind: "number" },
        { name: "customer_id", type: "integer", kind: "number" },
        { name: "total", type: "numeric(10,2)", kind: "number" },
      ],
      rows: orders.filter((o) => Number(o[3]) > 500).map((o) => [o[0], o[1], o[3]]),
    },
    {
      name: "events",
      schema: "audit",
      kind: "table",
      columns: [
        { name: "id", type: "bigint", kind: "number", pk: true, auto: true },
        { name: "happened_at", type: "timestamp with time zone", kind: "date" },
        { name: "payload", type: "jsonb", kind: "json", nullable: true },
      ],
      rows: Array.from({ length: 25 }, (_, i) => [String(i + 1), `${day(base, i)} 12:00:00+00`, JSON.stringify({ action: i % 2 ? "login" : "logout", user: i })]),
    },
  ];
}

const DEMO_CONNECTIONS: ConnectionConfig[] = [
  {
    ...blank(),
    id: "demo-pg",
    name: "Shop — production",
    driver: "postgres",
    host: "db.example.com",
    port: 5432,
    database: "shop",
    user: "app",
    environment: "production",
    color: "#F85149",
  },
  { ...blank(), id: "demo-my", name: "Analytics", driver: "mysql", host: "localhost", port: 3306, database: "shop", user: "root", folder: "Local" },
  { ...blank(), id: "demo-lite", name: "notes.db", driver: "sqlite", filePath: "C:/Users/me/notes.db", folder: "Local" },
];

function blank(): ConnectionConfig {
  return {
    id: "",
    name: "",
    driver: "postgres",
    host: "",
    port: 0,
    database: "",
    user: "",
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
    createdAt: Date.now(),
    lastUsedAt: null,
  };
}

const err = (kind: string, message: string) => ({ kind, message });

/** Literal tokens of a VALUES list / SET clause: 'text', numbers, NULL, true/false. */
function parseLiteral(src: string): Cell {
  const s = src.trim();
  if (/^null$/i.test(s)) return null;
  const q = /^N?'((?:[^']|'')*)'(?:::\w+)?$/.exec(s);
  if (q) return q[1].replace(/''/g, "'");
  return s.replace(/^X'|'$/g, "");
}

function splitTopLevel(s: string, sep = ","): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      cur += c;
      if (c === "'" && s[i + 1] === "'") cur += s[++i];
      else if (c === "'") inStr = false;
      continue;
    }
    if (c === "'") inStr = true;
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const unquote = (id: string) => id.trim().replace(/^["`[]|["`\]]$/g, "");
const lastPart = (qualified: string) => unquote(qualified.split(".").pop() ?? qualified);

export function createMockBackend(opts: { latencyMs?: number; demo?: boolean } = {}): HelixApi {
  const latency = opts.latencyMs ?? 0;
  const wait = () => new Promise((r) => setTimeout(r, latency));
  const tables = demoTables();
  const connections: ConnectionEntry[] = (opts.demo ? DEMO_CONNECTIONS : []).map((c) => ({ ...c, hasPassword: true, connected: false }));
  const sessions = new Map<string, SessionState>();
  const cancelled = new Set<string>();
  let seq = 0;

  const find = (id: string) => {
    const c = connections.find((x) => x.id === id);
    if (!c) throw err("not_found", `connection ${id}`);
    return c;
  };
  const live = (id: string) => {
    const c = find(id);
    if (!c.connected) throw err("connection", "Not connected");
    return c;
  };
  const table = (name: string) => {
    const t = tables.find((x) => x.name.toLowerCase() === lastPart(name).toLowerCase());
    if (!t) throw err("sql", `relation "${lastPart(name)}" does not exist`);
    return t;
  };
  const colInfo = (c: MockColumn): ColumnInfo => ({ name: c.name, typeName: c.type.split("(")[0], kind: c.kind });

  function matches(t: MockTable, row: Cell[], where: string | undefined): boolean {
    if (!where) return true;
    return splitTopLevel(where.replace(/\s+and\s+/gi, "\u0001"), "\u0001").every((cond) => {
      const m = /^\s*([\w"`[\].]+)\s*(=|<>|!=|>=|<=|>|<|\s+like\s+|\s+ilike\s+|\s+is\s+not\s+|\s+is\s+)\s*(.+?)\s*$/i.exec(cond);
      if (!m) return true;
      const idx = t.columns.findIndex((c) => c.name === lastPart(m[1]));
      if (idx < 0) throw err("sql", `column "${lastPart(m[1])}" does not exist`);
      const v = row[idx];
      const op = m[2].trim().toLowerCase();
      const lit = parseLiteral(m[3]);
      if (op === "is") return v === null;
      if (op === "is not") return v !== null;
      if (v === null || lit === null) return false;
      if (op === "like" || op === "ilike") {
        const re = new RegExp("^" + lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".") + "$", op === "ilike" ? "i" : "");
        return re.test(v);
      }
      const num = t.columns[idx].kind === "number";
      const a: number | string = num ? Number(v) : v;
      const b: number | string = num ? Number(lit) : lit;
      switch (op) {
        case "=":
          return a === b;
        case "<>":
        case "!=":
          return a !== b;
        case ">":
          return a > b;
        case "<":
          return a < b;
        case ">=":
          return a >= b;
        default:
          return a <= b;
      }
    });
  }

  function run(sql: string, limit: number): StatementResult {
    const text = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ").trim().replace(/;+\s*$/, "");
    const started = performance.now();
    const done = (r: Partial<StatementResult>): StatementResult => ({
      columns: [],
      rows: [],
      rowsAffected: null,
      hasMore: false,
      elapsedMs: Math.round(performance.now() - started) + latency,
      ...r,
    });
    let m: RegExpExecArray | null;

    if ((m = /^select\s+count\(\*\)(?:\s+as\s+\w+)?\s+from\s+\(([\s\S]+)\)\s*\w*$/i.exec(text))) {
      const inner = run(m[1], Number.MAX_SAFE_INTEGER);
      return done({ columns: [{ name: "count", typeName: "int8", kind: "number" }], rows: [[String(inner.rows.length)]] });
    }
    if ((m = /^select\s+count\(\*\)(?:\s+as\s+\w+)?\s+from\s+([\w"`[\].]+)(?:\s+where\s+([\s\S]+))?$/i.exec(text))) {
      const t = table(m[1]);
      return done({ columns: [{ name: "count", typeName: "int8", kind: "number" }], rows: [[String(t.rows.filter((r) => matches(t, r, m![2])).length)]] });
    }
    if ((m = /^select\s+([\s\S]+?)\s+from\s+([\w"`[\].]+)(?:\s+(?:as\s+)?\w+)?(?:\s+where\s+([\s\S]+?))?(?:\s+order\s+by\s+([\s\S]+?))?(?:\s+limit\s+(\d+))?$/i.exec(text))) {
      const t = table(m[2]);
      let rows = t.rows.filter((r) => matches(t, r, m![3]));
      if (m[4]) {
        const keys = splitTopLevel(m[4]).map((k) => {
          const [, col, dir] = /^\s*([\w"`[\].]+)(?:\s+(asc|desc))?/i.exec(k) ?? [];
          return { idx: t.columns.findIndex((c) => c.name === lastPart(col ?? "")), desc: /desc/i.test(dir ?? "") };
        });
        rows = [...rows].sort((a, b) => {
          for (const k of keys) {
            if (k.idx < 0) continue;
            const num = t.columns[k.idx].kind === "number";
            const x = a[k.idx];
            const y = b[k.idx];
            const c = x === y ? 0 : x === null ? 1 : y === null ? -1 : num ? Number(x) - Number(y) : x.localeCompare(y);
            if (c) return k.desc ? -c : c;
          }
          return 0;
        });
      }
      if (m[5]) rows = rows.slice(0, Number(m[5]));
      const list = m[1].trim();
      const picks = list === "*" ? t.columns.map((_, i) => i) : splitTopLevel(list).map((c) => t.columns.findIndex((x) => x.name === lastPart(c)));
      if (picks.some((i) => i < 0)) throw err("sql", `column does not exist in ${t.name}`);
      const projected = rows.map((r) => picks.map((i) => r[i]));
      return done({
        columns: picks.map((i) => colInfo(t.columns[i])),
        rows: projected.slice(0, limit),
        hasMore: projected.length > limit,
        rowsAffected: Math.min(projected.length, limit),
      });
    }
    if ((m = /^select\s+([\s\S]+)$/i.exec(text))) {
      const parts = splitTopLevel(m[1]);
      return done({
        columns: parts.map((p, i) => ({ name: /\bas\s+(\w+)$/i.exec(p)?.[1] ?? `?column?${i ? i : ""}`, typeName: "text", kind: "text" })),
        rows: [parts.map((p) => parseLiteral(p.replace(/\s+as\s+\w+$/i, "")))],
      });
    }
    if ((m = /^insert\s+into\s+([\w"`[\].]+)\s*\(([^)]*)\)\s*values\s*([\s\S]+)$/i.exec(text))) {
      const t = table(m[1]);
      const cols = splitTopLevel(m[2]).map((c) => t.columns.findIndex((x) => x.name === lastPart(c)));
      const tuples = splitTopLevel(m[3]).map((v) => splitTopLevel(v.trim().replace(/^\(|\)$/g, "")));
      for (const tuple of tuples) {
        const row: Cell[] = t.columns.map((c) => (c.auto ? String(t.rows.length + 1 + seq++) : (c.default?.replace(/^'|'(::.*)?$/g, "") ?? null)));
        cols.forEach((ci, k) => ci >= 0 && (row[ci] = parseLiteral(tuple[k] ?? "NULL")));
        t.rows.push(row);
      }
      return done({ rowsAffected: tuples.length });
    }
    if ((m = /^update\s+([\w"`[\].]+)\s+set\s+([\s\S]+?)\s+where\s+([\s\S]+)$/i.exec(text))) {
      const t = table(m[1]);
      const sets = splitTopLevel(m[2]).map((s) => {
        const [col, ...rest] = s.split("=");
        return { idx: t.columns.findIndex((c) => c.name === lastPart(col)), val: parseLiteral(rest.join("=")) };
      });
      let n = 0;
      for (const r of t.rows) {
        if (!matches(t, r, m[3])) continue;
        n++;
        for (const s of sets) if (s.idx >= 0) r[s.idx] = s.val;
      }
      return done({ rowsAffected: n });
    }
    if ((m = /^delete\s+from\s+([\w"`[\].]+)(?:\s+where\s+([\s\S]+))?$/i.exec(text))) {
      const t = table(m[1]);
      const before = t.rows.length;
      t.rows = t.rows.filter((r) => !matches(t, r, m![2]));
      return done({ rowsAffected: before - t.rows.length });
    }
    if (/^explain\b/i.test(text)) {
      return done({ columns: [{ name: "QUERY PLAN", typeName: "text", kind: "text" }], rows: [["Seq Scan on demo  (cost=0.00..35.50 rows=2550 width=4)"]] });
    }
    if (/^(begin|commit|rollback|start|set|use|create|drop|alter|truncate|comment)\b/i.test(text)) return done({ rowsAffected: 0 });
    throw err("sql", `syntax error at or near "${text.split(/\s+/)[0] ?? ""}"`);
  }

  const tableInfo = (name: string): TableInfo => {
    const t = table(name);
    const pk = t.columns.filter((c) => c.pk).map((c) => c.name);
    return {
      name: t.name,
      kind: t.kind,
      comment: t.comment ?? null,
      columns: t.columns.map((c) => ({
        name: c.name,
        dataType: c.type,
        nullable: !!c.nullable,
        defaultValue: c.default ?? null,
        primaryKey: !!c.pk,
        autoIncrement: !!c.auto,
        comment: null,
      })),
      primaryKey: pk,
      indexes: pk.length ? [{ name: `${t.name}_pkey`, columns: pk, unique: true, primary: true, method: "btree", definition: null }] : [],
      foreignKeys: t.columns
        .filter((c) => c.fk)
        .map((c) => ({ name: `${t.name}_${c.name}_fkey`, columns: [c.name], refSchema: "public", refTable: c.fk!.table, refColumns: [c.fk!.column], onUpdate: "NO ACTION", onDelete: "CASCADE" })),
      references: tables.flatMap((o) =>
        o.columns
          .filter((c) => c.fk?.table === t.name)
          .map((c) => ({ name: `${o.name}_${c.name}_fkey`, schema: o.schema, table: o.name, columns: [c.name], refColumns: [c.fk!.column] })),
      ),
      triggers: [],
      constraints: [],
      properties: [
        ["Type", t.kind],
        ["Estimated rows", String(t.rows.length)],
        ["Total size", `${Math.max(8, Math.round(t.rows.length / 12))} kB`],
      ],
    };
  };

  const ddl = (name: string): string => {
    const t = table(name);
    const cols = t.columns.map((c) => `\t${c.name} ${c.type}${c.default ? ` DEFAULT ${c.default}` : ""}${c.nullable ? "" : " NOT NULL"}`);
    const pk = t.columns.filter((c) => c.pk).map((c) => c.name);
    if (pk.length) cols.push(`\tCONSTRAINT ${t.name}_pkey PRIMARY KEY (${pk.join(", ")})`);
    for (const c of t.columns.filter((c) => c.fk)) cols.push(`\tCONSTRAINT ${t.name}_${c.name}_fkey FOREIGN KEY (${c.name}) REFERENCES public.${c.fk!.table}(${c.fk!.column}) ON DELETE CASCADE`);
    return t.kind === "view"
      ? `CREATE OR REPLACE VIEW public.${t.name} AS\n SELECT id, customer_id, total\n   FROM orders\n  WHERE total > 500::numeric;`
      : `CREATE TABLE ${t.schema}.${t.name} (\n${cols.join(",\n")}\n);`;
  };

  const api: HelixApi = {
    async listConnections() {
      await wait();
      return connections.map((c) => ({ ...c }));
    },
    async saveConnection(config) {
      await wait();
      const existing = connections.find((c) => c.id && c.id === config.id);
      if (!config.name.trim()) throw err("invalid", "Give the connection a name");
      if (existing) {
        Object.assign(existing, config, { connected: false });
        return { ...existing };
      }
      const created: ConnectionEntry = { ...config, id: config.id || `mock-${++seq}`, createdAt: Date.now(), hasPassword: true, connected: false };
      connections.push(created);
      return { ...created };
    },
    async deleteConnection(id) {
      await wait();
      const i = connections.findIndex((c) => c.id === id);
      if (i >= 0) connections.splice(i, 1);
    },
    async reorderConnections(ids) {
      connections.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    },
    async testConnection(config) {
      await wait();
      if (config.driver !== "sqlite" && !config.host) throw err("connection", "could not translate host name \"\" to address");
      return { serverVersion: config.driver === "sqlite" ? "SQLite 3.46.0" : "PostgreSQL 16.4 (mock)", elapsedMs: 12 };
    },
    async connect(id) {
      await wait();
      const c = find(id);
      c.connected = true;
      c.lastUsedAt = Date.now();
      return { driver: c.driver, version: "PostgreSQL 16.4 (mock)", database: c.database || "main" };
    },
    async disconnect(id) {
      const c = connections.find((x) => x.id === id);
      if (c) c.connected = false;
    },
    async listDatabases(id) {
      await wait();
      const c = live(id);
      if (c.driver === "sqlite") return [{ name: "main", system: false }];
      return [
        { name: c.database || "shop", system: false },
        { name: "postgres", system: false },
      ];
    },
    async listSchemas(id) {
      await wait();
      const c = live(id);
      if (c.driver === "mysql" || c.driver === "sqlite") return [];
      return [
        { name: "audit", system: false },
        { name: "public", system: false },
        { name: "information_schema", system: true },
        { name: "pg_catalog", system: true },
      ];
    },
    async listObjects(id, _db, schema) {
      await wait();
      live(id);
      const sch = schema ?? "public";
      const objs: DbObject[] = tables
        .filter((t) => (schema === null ? t.schema === "public" : t.schema === sch))
        .map((t) => ({ name: t.name, kind: t.kind, comment: t.comment ?? null, rows: t.kind === "table" ? t.rows.length : null, signature: null, parent: null }));
      if (sch === "public") {
        objs.push({ name: "order_total", kind: "function", comment: null, rows: null, signature: "order_id bigint", parent: null });
        objs.push({ name: "orders_id_seq", kind: "sequence", comment: null, rows: null, signature: null, parent: null });
      }
      return objs;
    },
    async tableInfo(id, _db, _schema, name) {
      await wait();
      live(id);
      return tableInfo(name);
    },
    async objectDdl(id, _db, _schema, name, kind) {
      await wait();
      live(id);
      if (kind === "function") return `CREATE OR REPLACE FUNCTION public.${name}(order_id bigint)\n RETURNS numeric\n LANGUAGE sql\nAS $function$\n  SELECT total FROM orders WHERE id = order_id\n$function$`;
      if (kind === "sequence") return `CREATE SEQUENCE public.${name}\n\tAS bigint\n\tINCREMENT BY 1\n\tSTART 1;`;
      return ddl(name);
    },
    async schemaModel(id, _db, schema) {
      await wait();
      live(id);
      return tables
        .filter((t) => t.schema === (schema ?? "public"))
        .map(
          (t): ModelTable => ({
            name: t.name,
            kind: t.kind,
            columns: t.columns.map((c) => ({ name: c.name, dataType: c.type, nullable: !!c.nullable, primaryKey: !!c.pk })),
            foreignKeys: tableInfo(t.name).foreignKeys,
          }),
        );
    },
    async serverSessions(id) {
      await wait();
      live(id);
      return [
        { id: "4123", user: "app", database: "shop", client: "10.0.0.12", application: "Helix", state: "active", started: "2026-10-20 08:00:00", queryStart: "2026-10-20 09:12:44", wait: null, query: "SELECT * FROM orders" },
        { id: "4188", user: "report", database: "shop", client: "10.0.0.40", application: "cron", state: "idle", started: "2026-10-20 07:00:00", queryStart: null, wait: "Client: ClientRead", query: "COMMIT" },
      ];
    },
    async killServerSession() {
      await wait();
    },
    async metaQuery(id, _db, sql) {
      await wait();
      live(id);
      return [run(sql, 10_000)];
    },
    async openSession(id, database, schema, autoCommit) {
      await wait();
      const c = live(id);
      const s: SessionState = { id: `s${++seq}`, database: database || c.database || "main", schema, autoCommit, inTransaction: false, transactionStatements: 0 };
      sessions.set(s.id, s);
      return { ...s };
    },
    async closeSession(_id, sessionId) {
      sessions.delete(sessionId);
    },
    async sessionState(_id, sessionId) {
      const s = sessions.get(sessionId);
      if (!s) throw err("not_found", "session");
      return { ...s };
    },
    async setSessionScope(_id, sessionId, database, schema) {
      const s = sessions.get(sessionId)!;
      Object.assign(s, { database, schema });
      return { ...s };
    },
    async setAutoCommit(_id, sessionId, autoCommit) {
      const s = sessions.get(sessionId)!;
      Object.assign(s, { autoCommit, inTransaction: autoCommit ? false : s.inTransaction, transactionStatements: autoCommit ? 0 : s.transactionStatements });
      return { ...s };
    },
    async endTransaction(_id, sessionId) {
      const s = sessions.get(sessionId)!;
      Object.assign(s, { inTransaction: false, transactionStatements: 0 });
      return { ...s };
    },
    async execute(id, sessionId, queryId, sql, limit) {
      live(id);
      const s = sessions.get(sessionId);
      if (!s) throw err("not_found", "editor session");
      const slow = /pg_sleep|sleep\(/i.test(sql);
      for (let t = 0; t < (slow ? 40 : 1); t++) {
        await wait();
        if (cancelled.delete(queryId)) throw err("cancelled", "Query cancelled");
      }
      const r = run(sql, limit);
      if (!s.autoCommit && !/^\s*select/i.test(sql)) {
        s.inTransaction = true;
        s.transactionStatements++;
      }
      return { results: [r], inTransaction: s.inTransaction, transactionStatements: s.transactionStatements };
    },
    async cancelQuery(_id, queryId) {
      cancelled.add(queryId);
    },
    async explain(id, _s, sql) {
      await wait();
      live(id);
      return [run(`EXPLAIN ${sql}`, 100)];
    },
    async executeBatch(id, _s, statements) {
      await wait();
      live(id);
      return statements.map((st) => run(st, 1).rowsAffected);
    },
    async exportQuery(id, _db, sql, _o, _e, onProgress) {
      await wait();
      live(id);
      const n = run(sql, Number.MAX_SAFE_INTEGER).rows.length;
      onProgress?.(n);
      return n;
    },
    async exportCancel() {},
    async readTextFile() {
      return "id,name\n1,Alpha\n2,Beta\n";
    },
    async writeTextFile() {},
    async pickOpenFile() {
      return null;
    },
    async pickSaveFile(defaultPath) {
      return defaultPath;
    },
    async revealPath() {},
    async openUrl(url) {
      window.open(url, "_blank");
    },
    async updateDownload() {
      throw err("invalid", "Updates are available in the desktop app");
    },
    async updateInstall() {},
    async platform() {
      return { os: "windows", arch: "x86_64" };
    },
    async quit() {},
  };
  return api;
}
