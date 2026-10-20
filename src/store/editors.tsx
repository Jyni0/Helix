/**
 * Runtime of SQL editors and data views: their server session (a connection
 * of their own, with its transaction), what runs, the results and the log.
 * Nothing here is persisted — the scripts live in the workspace store.
 */
import { create } from "zustand";
import { api, errorKind, errorMessage } from "@/lib/api";
import { editableSource, isModifying, isReadOnlyStatement, isUnboundedChange } from "@/lib/sql/dialect";
import { oneLine, plural, uid } from "@/lib/format";
import type { Cell, ColumnInfo, SessionState } from "@/lib/types";
import { useConnections } from "./connections";
import { useHistory } from "./history";
import { prefs, toast, useUi } from "./ui";
import { onTabClosed } from "./workspace";

export interface ResultSet {
  id: string;
  title: string;
  sql: string;
  columns: ColumnInfo[];
  rows: Cell[][];
  hasMore: boolean;
  rowsAffected: number | null;
  elapsedMs: number;
  /** Row limit it was fetched with. */
  limit: number;
  error: string | null;
  at: number;
  /** Table the rows come from (the grid can edit them). */
  source: { database: string | null; schema: string | null; name: string } | null;
  /** An execution plan. */
  plan?: boolean;
  /** Kept when the editor runs again. */
  pinned?: boolean;
}

export interface LogEntry {
  id: string;
  at: number;
  sql: string;
  message: string;
  kind: "ok" | "error" | "info";
  elapsedMs: number | null;
}

export interface Running {
  queryId: string;
  startedAt: number;
  statement: string;
  index: number;
  total: number;
}

export interface EditorRuntime {
  connectionId: string | null;
  session: SessionState | null;
  opening: boolean;
  running: Running | null;
  results: ResultSet[];
  /** Selected result tab: a result id or "log". */
  active: string | null;
  log: LogEntry[];
}

const EMPTY: EditorRuntime = { connectionId: null, session: null, opening: false, running: null, results: [], active: null, log: [] };

export interface Scope {
  connectionId: string;
  database: string | null;
  schema: string | null;
}

interface EditorsState {
  editors: Record<string, EditorRuntime>;
  get(ownerId: string): EditorRuntime;
  patch(ownerId: string, p: Partial<EditorRuntime> | ((r: EditorRuntime) => Partial<EditorRuntime>)): void;
  /** The owner's session for `scope`, opened (or re-pointed) when needed. */
  ensureSession(ownerId: string, scope: Scope, autoCommit?: boolean): Promise<SessionState | null>;
  closeSession(ownerId: string): Promise<void>;
  /** Runs statements one after another (a script); results open as tabs. */
  run(ownerId: string, scope: Scope, statements: string[], opts?: { limit?: number; replace?: string }): Promise<void>;
  explain(ownerId: string, scope: Scope, sql: string, analyze: boolean): Promise<void>;
  cancel(ownerId: string): Promise<void>;
  endTransaction(ownerId: string, commit: boolean): Promise<void>;
  setAutoCommit(ownerId: string, autoCommit: boolean): Promise<void>;
  /** Re-runs a result's query with a larger row limit. */
  fetchMore(ownerId: string, scope: Scope, resultId: string, all?: boolean): Promise<void>;
  closeResult(ownerId: string, resultId: string): void;
  togglePin(ownerId: string, resultId: string): void;
  clearResults(ownerId: string): void;
  addLog(ownerId: string, e: Omit<LogEntry, "id" | "at">): void;
}

const MAX_RESULTS = 30;

export const useEditors = create<EditorsState>((set, get) => ({
  editors: {},

  get: (ownerId) => get().editors[ownerId] ?? EMPTY,

  patch(ownerId, p) {
    set((s) => {
      const cur = s.editors[ownerId] ?? EMPTY;
      const next = typeof p === "function" ? p(cur) : p;
      return { editors: { ...s.editors, [ownerId]: { ...cur, ...next } } };
    });
  },

  async ensureSession(ownerId, scope, autoCommit) {
    const cur = get().get(ownerId);
    if (cur.session && cur.connectionId === scope.connectionId) {
      const db = scope.database ?? cur.session.database;
      if (db === cur.session.database && (scope.schema ?? null) === (cur.session.schema ?? null)) return cur.session;
      try {
        const session = await api.setSessionScope(scope.connectionId, cur.session.id, db, scope.schema);
        get().patch(ownerId, { session });
        return session;
      } catch (e) {
        if (errorKind(e) !== "not_found" && errorKind(e) !== "connection") {
          toast("Could not switch database", "error", errorMessage(e));
          return cur.session;
        }
        // The session is gone (reconnected): open a fresh one below.
      }
    }
    if (cur.session && cur.connectionId) await get().closeSession(ownerId);
    if (!(await useConnections.getState().ensureConnected(scope.connectionId))) return null;
    get().patch(ownerId, { opening: true });
    try {
      const session = await api.openSession(scope.connectionId, scope.database, scope.schema, autoCommit ?? prefs().autoCommit);
      get().patch(ownerId, { session, connectionId: scope.connectionId, opening: false });
      return session;
    } catch (e) {
      get().patch(ownerId, { opening: false });
      toast("Could not open a session", "error", errorMessage(e));
      return null;
    }
  },

  async closeSession(ownerId) {
    const cur = get().get(ownerId);
    if (cur.session && cur.connectionId) await api.closeSession(cur.connectionId, cur.session.id).catch(() => {});
    get().patch(ownerId, { session: null, connectionId: null });
  },

  async run(ownerId, scope, statements, opts = {}) {
    if (!statements.length) return;
    if (get().get(ownerId).running) return toast("A query is already running in this editor", "warning");
    const conn = useConnections.getState().get(scope.connectionId);
    if (!conn) return toast("Choose a connection first", "warning");
    const p = prefs();

    // Safety first.
    if (conn.readOnly) {
      const bad = statements.find((s) => !isReadOnlyStatement(s));
      if (bad) return toast("The connection is read-only", "error", oneLine(bad, 140));
    }
    if (p.confirmUnbounded) {
      const bad = statements.find(isUnboundedChange);
      if (bad) {
        const ok = await useUi.getState().ask({
          title: "Change every row?",
          message: (
            <>
              <code className="mb-2 block rounded-lg bg-[var(--bg-input)] p-2 font-mono text-[12px] text-[var(--text-main)]">{oneLine(bad, 200)}</code>
              This statement has no WHERE clause and affects the whole table.
            </>
          ),
          buttons: [
            { id: "run", label: "Run anyway", variant: "danger" },
            { id: "cancel", label: "Cancel" },
          ],
          cancelId: "cancel",
        });
        if (ok !== "run") return;
      }
    }
    if (p.confirmProduction && conn.environment === "production" && statements.some(isModifying)) {
      const n = statements.filter(isModifying).length;
      const ok = await useUi.getState().ask({
        title: `Run on ${conn.name}?`,
        message: `This is a production connection. ${plural(n, "statement")} will change data or structure.`,
        buttons: [
          { id: "run", label: "Run", variant: "danger" },
          { id: "cancel", label: "Cancel" },
        ],
        cancelId: "cancel",
      });
      if (ok !== "run") return;
    }

    const session = await get().ensureSession(ownerId, scope);
    if (!session) return;
    const limit = opts.limit ?? p.rowLimit;
    const created: ResultSet[] = [];
    let lastActive: string | null = null;

    for (let i = 0; i < statements.length; i++) {
      const sql = statements[i];
      const queryId = uid();
      get().patch(ownerId, { running: { queryId, startedAt: Date.now(), statement: sql, index: i, total: statements.length } });
      const started = performance.now();
      try {
        const sess = get().get(ownerId).session ?? session;
        const res = await api.execute(scope.connectionId, sess.id, queryId, sql, limit);
        get().patch(ownerId, (r) => ({ session: r.session ? { ...r.session, inTransaction: res.inTransaction, transactionStatements: res.transactionStatements } : r.session }));
        const elapsed = Math.round(performance.now() - started);
        let fetched = 0;
        res.results.forEach((r, k) => {
          if (r.columns.length) {
            fetched += r.rows.length;
            const src = editableSource(sql);
            const rs: ResultSet = {
              id: opts.replace && k === 0 && i === 0 ? opts.replace : uid(),
              title: "",
              sql,
              columns: r.columns,
              rows: r.rows,
              hasMore: r.hasMore,
              rowsAffected: r.rowsAffected,
              elapsedMs: r.elapsedMs || elapsed,
              limit,
              error: null,
              at: Date.now(),
              source: src ? { database: src.database ?? scope.database, schema: src.schema ?? scope.schema, name: src.name } : null,
            };
            created.push(rs);
            lastActive = rs.id;
          }
        });
        const affected = res.results.find((r) => !r.columns.length)?.rowsAffected;
        const msg = res.results.some((r) => r.columns.length)
          ? `${plural(fetched, "row")} fetched${res.results.some((r) => r.hasMore) ? " (more available)" : ""}`
          : affected !== null && affected !== undefined
            ? `${plural(affected, "row")} affected`
            : "Statement executed";
        get().addLog(ownerId, { sql, message: msg, kind: "ok", elapsedMs: elapsed });
        useHistory.getState().add({
          sql,
          connectionId: conn.id,
          connectionName: conn.name,
          database: scope.database,
          elapsedMs: elapsed,
          rows: res.results.some((r) => r.columns.length) ? fetched : (affected ?? null),
          error: null,
        });
        if (!res.results.some((r) => r.columns.length) && statements.length === 1) lastActive = "log";
      } catch (e) {
        const elapsed = Math.round(performance.now() - started);
        const cancelled = errorKind(e) === "cancelled";
        const message = errorMessage(e);
        get().addLog(ownerId, { sql, message: cancelled ? "Cancelled" : message, kind: cancelled ? "info" : "error", elapsedMs: elapsed });
        useHistory.getState().add({ sql, connectionId: conn.id, connectionName: conn.name, database: scope.database, elapsedMs: elapsed, rows: null, error: message });
        if (!cancelled) {
          const rs: ResultSet = {
            id: uid(),
            title: "",
            sql,
            columns: [],
            rows: [],
            hasMore: false,
            rowsAffected: null,
            elapsedMs: elapsed,
            limit,
            error: message,
            at: Date.now(),
            source: null,
          };
          created.push(rs);
          lastActive = rs.id;
        }
        if (errorKind(e) === "connection") {
          // The session's connection dropped: the next run opens a new one.
          get().patch(ownerId, { session: null, connectionId: null });
        }
        // Refresh the transaction state (a failed statement may have changed it).
        const s = get().get(ownerId).session;
        if (s) api.sessionState(scope.connectionId, s.id).then((st) => get().patch(ownerId, { session: st }), () => {});
        if (cancelled || p.stopOnError) break;
      }
    }

    get().patch(ownerId, (r) => {
      let results = r.results;
      if (opts.replace) {
        const at = results.findIndex((x) => x.id === opts.replace);
        const rep = created.find((c) => c.id === opts.replace);
        if (at >= 0 && rep) results = results.map((x) => (x.id === opts.replace ? { ...rep, title: x.title } : x));
        else results = [...results, ...created];
      } else {
        // A new run replaces the previous results, except pinned ones.
        results = [...results.filter((x) => x.pinned), ...created];
      }
      let n = 0;
      results = results.slice(-MAX_RESULTS).map((x) => (x.pinned ? x : { ...x, title: x.plan ? "Plan" : x.error ? "Error" : `Result ${++n}` }));
      return { running: null, results, active: lastActive ?? r.active };
    });
  },

  async explain(ownerId, scope, sql, analyze) {
    if (get().get(ownerId).running) return;
    const session = await get().ensureSession(ownerId, scope);
    if (!session) return;
    get().patch(ownerId, { running: { queryId: uid(), startedAt: Date.now(), statement: sql, index: 0, total: 1 } });
    const started = performance.now();
    try {
      const res = await api.explain(scope.connectionId, session.id, sql, analyze);
      const r = res.find((x) => x.columns.length) ?? res[0];
      const rs: ResultSet = {
        id: uid(),
        title: "Plan",
        sql,
        columns: r?.columns ?? [],
        rows: r?.rows ?? [],
        hasMore: false,
        rowsAffected: null,
        elapsedMs: Math.round(performance.now() - started),
        limit: 100_000,
        error: null,
        at: Date.now(),
        source: null,
        plan: true,
      };
      get().addLog(ownerId, { sql: `EXPLAIN ${sql}`, message: "Execution plan", kind: "ok", elapsedMs: rs.elapsedMs });
      get().patch(ownerId, (x) => ({ running: null, results: [...x.results.filter((y) => !y.plan), rs], active: rs.id }));
    } catch (e) {
      get().addLog(ownerId, { sql: `EXPLAIN ${sql}`, message: errorMessage(e), kind: "error", elapsedMs: null });
      get().patch(ownerId, { running: null, active: "log" });
    }
  },

  async cancel(ownerId) {
    const r = get().get(ownerId);
    if (!r.running || !r.connectionId) return;
    await api.cancelQuery(r.connectionId, r.running.queryId).catch((e) => toast("Cancel failed", "error", errorMessage(e)));
  },

  async endTransaction(ownerId, commit) {
    const r = get().get(ownerId);
    if (!r.session || !r.connectionId) return;
    try {
      const session = await api.endTransaction(r.connectionId, r.session.id, commit);
      get().patch(ownerId, { session });
      get().addLog(ownerId, { sql: commit ? "COMMIT" : "ROLLBACK", message: commit ? "Transaction committed" : "Transaction rolled back", kind: "ok", elapsedMs: null });
      toast(commit ? "Committed" : "Rolled back", "success");
    } catch (e) {
      toast(commit ? "Commit failed" : "Rollback failed", "error", errorMessage(e));
    }
  },

  async setAutoCommit(ownerId, autoCommit) {
    const r = get().get(ownerId);
    if (!r.session || !r.connectionId) {
      // No session yet: the preference decides when one opens.
      useUi.getState().setPref("autoCommit", autoCommit);
      return;
    }
    if (autoCommit && r.session.inTransaction) {
      const ans = await useUi.getState().ask({
        title: "Commit the open transaction?",
        message: `Switching to auto-commit commits ${plural(r.session.transactionStatements, "pending statement")}.`,
        buttons: [
          { id: "commit", label: "Commit & switch", variant: "primary" },
          { id: "cancel", label: "Cancel" },
        ],
        cancelId: "cancel",
      });
      if (ans !== "commit") return;
    }
    try {
      const session = await api.setAutoCommit(r.connectionId, r.session.id, autoCommit);
      get().patch(ownerId, { session });
    } catch (e) {
      toast("Could not switch the commit mode", "error", errorMessage(e));
    }
  },

  async fetchMore(ownerId, scope, resultId, all = false) {
    const rs = get().get(ownerId).results.find((r) => r.id === resultId);
    if (!rs) return;
    const limit = all ? 1_000_000 : rs.limit + prefs().rowLimit;
    await get().run(ownerId, scope, [rs.sql], { limit, replace: resultId });
  },

  closeResult(ownerId, resultId) {
    get().patch(ownerId, (r) => {
      const results = r.results.filter((x) => x.id !== resultId);
      return { results, active: r.active === resultId ? (results.at(-1)?.id ?? "log") : r.active };
    });
  },
  togglePin(ownerId, resultId) {
    get().patch(ownerId, (r) => ({
      results: r.results.map((x) => (x.id === resultId ? { ...x, pinned: !x.pinned, title: x.pinned ? x.title.replace(/ \(pinned\)$/, "") : `${x.title} (pinned)` } : x)),
    }));
  },
  clearResults: (ownerId) => get().patch(ownerId, { results: [], active: null }),

  addLog(ownerId, e) {
    get().patch(ownerId, (r) => ({ log: [...r.log, { ...e, id: uid(), at: Date.now() }].slice(-500) }));
  },
}));

// Closing a tab releases its server session (rolling back what is pending).
onTabClosed((id) => {
  const r = useEditors.getState().editors[id];
  if (r?.session) void useEditors.getState().closeSession(id);
  useEditors.setState((s) => {
    const { [id]: _gone, ...rest } = s.editors;
    return { editors: rest };
  });
});

/** Editors with an open transaction (warned about before quitting / updating). */
export function openTransactions(): number {
  return Object.values(useEditors.getState().editors).filter((e) => e.session?.inTransaction).length;
}
