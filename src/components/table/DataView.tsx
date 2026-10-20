import { useCallback, useEffect, useRef, useState } from "react";
import { Filter, Play, X } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { countSql, ident, literal, selectData, type SortKey } from "@/lib/sql/dialect";
import type { Cell } from "@/lib/types";
import { useConnections } from "@/store/connections";
import { useEditors, type Scope } from "@/store/editors";
import { useUi } from "@/store/ui";
import { Alert, Button, Spinner, type ContextMenuItem } from "@/components";
import { ResultView, type ResultData } from "@/components/grid/ResultView";

const FILTER_HISTORY = "helix.filterHistory";

/** Rows of a table / view: server-side filter, sort and paging, editable for tables. */
export function DataView({ tabId, scope, name, editable }: { tabId: string; scope: Scope; name: string; editable: boolean }) {
  const conn = useConnections((s) => s.connections.find((c) => c.id === scope.connectionId));
  const rowLimit = useUi((s) => s.prefs.rowLimit);
  const [where, setWhere] = useState("");
  const [applied, setApplied] = useState("");
  const [sort, setSort] = useState<SortKey[]>([]);
  const [limit, setLimit] = useState(rowLimit);
  const [result, setResult] = useState<ResultData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const driver = conn?.driver ?? "postgres";
  const table = { database: scope.database ?? "", schema: scope.schema, name };

  const load = useCallback(
    async (opts: { where?: string; sort?: SortKey[]; limit?: number } = {}) => {
      if (!conn) return;
      const w = opts.where ?? applied;
      const s = opts.sort ?? sort;
      const l = opts.limit ?? limit;
      const sql = selectData(driver, table, w, s, scope.database ?? undefined);
      const my = ++seq.current;
      setLoading(true);
      setError(null);
      try {
        const session = await useEditors.getState().ensureSession(tabId, scope, true);
        if (!session) throw new Error("Not connected");
        const res = await api.execute(conn.id, session.id, `data-${tabId}-${my}`, sql, l);
        if (my !== seq.current) return;
        const r = res.results.find((x) => x.columns.length) ?? res.results[0];
        setResult({ sql, columns: r.columns, rows: r.rows, hasMore: r.hasMore, rowsAffected: r.rowsAffected, elapsedMs: r.elapsedMs });
        useEditors.getState().patch(tabId, (x) => ({ session: x.session ? { ...x.session, inTransaction: res.inTransaction, transactionStatements: res.transactionStatements } : x.session }));
      } catch (e) {
        if (my === seq.current) setError(errorMessage(e));
      } finally {
        if (my === seq.current) setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conn?.id, driver, name, scope.database, scope.schema, applied, sort, limit, tabId],
  );

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.id, name, scope.database, scope.schema]);

  const apply = (w: string) => {
    setApplied(w);
    setLimit(rowLimit);
    void load({ where: w, limit: rowLimit });
    if (w.trim()) {
      try {
        const hist: string[] = JSON.parse(localStorage.getItem(FILTER_HISTORY) ?? "[]");
        localStorage.setItem(FILTER_HISTORY, JSON.stringify([w, ...hist.filter((h) => h !== w)].slice(0, 30)));
      } catch {
        /* ignore */
      }
    }
  };

  const filterBy = (col: string, value: Cell, kind: Parameters<typeof literal>[2], op: "=" | "<>" | "null" | "notnull") => {
    const c = ident(driver, col);
    const cond = op === "null" ? `${c} IS NULL` : op === "notnull" ? `${c} IS NOT NULL` : value === null ? `${c} IS NULL` : `${c} ${op} ${literal(driver, value, kind)}`;
    const w = applied.trim() ? `(${applied.trim()}) AND ${cond}` : cond;
    setWhere(w);
    apply(w);
  };

  const extraMenu = (pos: { row: number; col: number }, value: Cell): ContextMenuItem[] => {
    if (!result) return [];
    const col = result.columns[pos.col];
    const short = value === null ? "NULL" : value.length > 24 ? value.slice(0, 24) + "…" : value;
    return [
      {
        icon: <Filter size={13} />,
        label: "Filter",
        items: [
          { label: `${col.name} = ${short}`, onClick: () => filterBy(col.name, value, col.kind, "=") },
          { label: `${col.name} <> ${short}`, disabled: value === null, onClick: () => filterBy(col.name, value, col.kind, "<>") },
          { label: `${col.name} IS NULL`, onClick: () => filterBy(col.name, null, col.kind, "null") },
          { label: `${col.name} IS NOT NULL`, onClick: () => filterBy(col.name, null, col.kind, "notnull") },
          "separator",
          { label: "Clear filter", disabled: !applied, onClick: () => (setWhere(""), apply("")) },
        ],
      },
    ];
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--border-soft)] px-3"
        onSubmit={(e) => {
          e.preventDefault();
          apply(where);
        }}
      >
        <Filter size={13} className="shrink-0 text-[var(--text-dim)]" />
        <span className="shrink-0 font-mono text-[11.5px] text-[var(--syn-keyword)]">WHERE</span>
        <input
          aria-label="Filter rows"
          data-testid="data-filter"
          list={`filter-history-${tabId}`}
          className="h-7 min-w-0 flex-1 rounded-lg bg-[var(--bg-input)] px-2.5 font-mono text-[12px] text-[var(--text-main)] outline-none placeholder:font-sans placeholder:text-[var(--text-dim)] focus:ring-1 focus:ring-[var(--accent)]"
          placeholder="Condition, e.g. status = 'paid' AND total > 100"
          value={where}
          onChange={(e) => setWhere(e.target.value)}
          spellCheck={false}
        />
        <datalist id={`filter-history-${tabId}`}>
          {(() => {
            try {
              return (JSON.parse(localStorage.getItem(FILTER_HISTORY) ?? "[]") as string[]).map((h) => <option key={h} value={h} />);
            } catch {
              return null;
            }
          })()}
        </datalist>
        {applied && (
          <Button
            size="xs"
            variant="ghost"
            icon={<X size={12} />}
            onClick={() => {
              setWhere("");
              apply("");
            }}
          >
            Clear
          </Button>
        )}
        <Button size="xs" type="submit" icon={loading ? <Spinner size={12} /> : <Play size={11} fill="currentColor" />}>
          Apply
        </Button>
      </form>
      {error ? (
        <div className="p-4">
          <Alert>
            <span className="selectable whitespace-pre-wrap">{error}</span>
          </Alert>
        </div>
      ) : result ? (
        <ResultView
          ownerId={tabId}
          scope={scope}
          result={result}
          source={editable ? { database: scope.database, schema: scope.schema, name } : null}
          sort={sort}
          onSortChange={(s) => {
            setSort(s);
            void load({ sort: s });
          }}
          onReload={() => load()}
          onFetchMore={(all) => {
            const l = all ? 1_000_000 : limit + rowLimit;
            setLimit(l);
            void load({ limit: l });
          }}
          countSql={countSql(driver, table, applied, scope.database ?? undefined)}
          extraMenu={extraMenu}
          name={name}
          loading={loading}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-[var(--text-dim)]">
          <Spinner size={18} />
        </div>
      )}
    </div>
  );
}
