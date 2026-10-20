import { create } from "zustand";
import type { ObjectKind } from "@/lib/types";
import { uid } from "@/lib/format";

export interface SqlTab {
  kind: "sql";
  id: string;
  title: string;
  connectionId: string | null;
  database: string | null;
  schema: string | null;
  sql: string;
  /** File the script was opened from / saved to. */
  filePath: string | null;
  /** Text last saved to `filePath` (dirty check). */
  savedSql: string | null;
}

export type TableView = "data" | "properties" | "ddl" | "erd";

export interface TableTab {
  kind: "table";
  id: string;
  title: string;
  connectionId: string;
  database: string;
  schema: string | null;
  name: string;
  objectKind: ObjectKind;
  view: TableView;
}

/** Source of a function / procedure / sequence / trigger. */
export interface ObjectTab {
  kind: "object";
  id: string;
  title: string;
  connectionId: string;
  database: string;
  schema: string | null;
  name: string;
  objectKind: ObjectKind;
  signature: string | null;
}

export interface ErdTab {
  kind: "erd";
  id: string;
  title: string;
  connectionId: string;
  database: string;
  schema: string | null;
}

export interface SessionsTab {
  kind: "sessions";
  id: string;
  title: string;
  connectionId: string;
}

export interface HistoryTab {
  kind: "history";
  id: string;
  title: string;
}

export type Tab = SqlTab | TableTab | ObjectTab | ErdTab | SessionsTab | HistoryTab;

const KEY = "helix.workspace";

interface Persisted {
  tabs: Tab[];
  activeId: string | null;
  counter: number;
}

function load(): Persisted {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? "null") as Persisted | null;
    if (p && Array.isArray(p.tabs)) return { tabs: p.tabs, activeId: p.activeId, counter: p.counter ?? p.tabs.length };
  } catch {
    /* fresh start */
  }
  return { tabs: [], activeId: null, counter: 0 };
}

interface WorkspaceState extends Persisted {
  /** Recently closed tabs (Ctrl+Shift+T reopens). */
  closed: Tab[];
  activate(id: string): void;
  open(tab: Tab): void;
  /** A new SQL editor; returns its id. */
  newSql(init?: Partial<SqlTab>): string;
  /** Opens (or focuses) a table / view tab. */
  openTable(t: Omit<TableTab, "kind" | "id" | "title" | "view">, view?: TableView): void;
  openObject(t: Omit<ObjectTab, "kind" | "id" | "title">): void;
  openErd(connectionId: string, database: string, schema: string | null): void;
  openSessions(connectionId: string, connectionName: string): void;
  openHistory(): void;
  update(id: string, patch: Partial<Tab>): void;
  close(id: string): void;
  closeOthers(id: string): void;
  closeAll(): void;
  reopenClosed(): void;
  move(from: number, to: number): void;
  cycle(dir: 1 | -1): void;
  active(): Tab | undefined;
}

const initial = load();

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  ...initial,
  closed: [],

  activate: (activeId) => set({ activeId }),
  active: () => get().tabs.find((t) => t.id === get().activeId),

  open(tab) {
    set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
  },

  newSql(init) {
    const counter = get().counter + 1;
    const id = uid();
    get().open({
      title: `Script-${counter}`,
      connectionId: null,
      database: null,
      schema: null,
      sql: "",
      filePath: null,
      savedSql: null,
      ...init,
      kind: "sql",
      id,
    });
    set({ counter });
    return id;
  },

  openTable(t, view) {
    const existing = get().tabs.find(
      (x) => x.kind === "table" && x.connectionId === t.connectionId && x.database === t.database && x.schema === t.schema && x.name === t.name,
    ) as TableTab | undefined;
    if (existing) {
      set((s) => ({ activeId: existing.id, tabs: view ? s.tabs.map((x) => (x.id === existing.id ? { ...x, view } : x)) : s.tabs }));
      return;
    }
    get().open({ ...t, kind: "table", id: uid(), title: t.name, view: view ?? "data" });
  },

  openObject(t) {
    const existing = get().tabs.find(
      (x) => x.kind === "object" && x.connectionId === t.connectionId && x.database === t.database && x.schema === t.schema && x.name === t.name && x.signature === t.signature,
    );
    if (existing) return set({ activeId: existing.id });
    get().open({ ...t, kind: "object", id: uid(), title: t.name });
  },

  openErd(connectionId, database, schema) {
    const existing = get().tabs.find((x) => x.kind === "erd" && x.connectionId === connectionId && x.database === database && x.schema === schema);
    if (existing) return set({ activeId: existing.id });
    get().open({ kind: "erd", id: uid(), title: `ER: ${schema ?? database}`, connectionId, database, schema });
  },

  openSessions(connectionId, connectionName) {
    const existing = get().tabs.find((x) => x.kind === "sessions" && x.connectionId === connectionId);
    if (existing) return set({ activeId: existing.id });
    get().open({ kind: "sessions", id: uid(), title: `Sessions: ${connectionName}`, connectionId });
  },

  openHistory() {
    const existing = get().tabs.find((x) => x.kind === "history");
    if (existing) return set({ activeId: existing.id });
    get().open({ kind: "history", id: uid(), title: "Query History" });
  },

  update: (id, patch) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? ({ ...t, ...patch } as Tab) : t)) })),

  close(id) {
    const { tabs, activeId } = get();
    const i = tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const rest = tabs.filter((t) => t.id !== id);
    const nextActive = activeId === id ? (rest[i] ?? rest[i - 1])?.id ?? null : activeId;
    set((s) => ({ tabs: rest, activeId: nextActive, closed: [tabs[i], ...s.closed].slice(0, 20) }));
    tabClosedListeners.forEach((fn) => fn(id));
  },
  closeOthers(id) {
    for (const t of get().tabs) if (t.id !== id) get().close(t.id);
  },
  closeAll() {
    for (const t of get().tabs) get().close(t.id);
  },
  reopenClosed() {
    const [tab, ...rest] = get().closed;
    if (!tab) return;
    set((s) => ({ closed: rest, tabs: [...s.tabs, tab], activeId: tab.id }));
  },

  move(from, to) {
    set((s) => {
      const tabs = [...s.tabs];
      const [t] = tabs.splice(from, 1);
      tabs.splice(to, 0, t);
      return { tabs };
    });
  },

  cycle(dir) {
    const { tabs, activeId } = get();
    if (!tabs.length) return;
    const i = tabs.findIndex((t) => t.id === activeId);
    set({ activeId: tabs[(i + dir + tabs.length) % tabs.length].id });
  },
}));

/** Runs when a tab closes (editor sessions are released there). */
const tabClosedListeners = new Set<(id: string) => void>();
export function onTabClosed(fn: (id: string) => void): () => void {
  tabClosedListeners.add(fn);
  return () => tabClosedListeners.delete(fn);
}

// Persist (debounced): tabs and their scripts survive restarts.
let timer: ReturnType<typeof setTimeout> | undefined;
useWorkspace.subscribe((s) => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ tabs: s.tabs, activeId: s.activeId, counter: s.counter }));
    } catch {
      /* storage full / unavailable */
    }
  }, 300);
});

export const isDirty = (t: Tab) => t.kind === "sql" && t.filePath !== null && t.savedSql !== t.sql;
