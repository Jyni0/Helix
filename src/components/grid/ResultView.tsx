import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsDown, Download, Hash, PanelRight, Plus, RotateCcw, Rows3, Trash2, Undo2 } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { changeStatements, countQuery, kindOf, type SortKey } from "@/lib/sql/dialect";
import { duration, plural } from "@/lib/format";
import type { Cell, ColumnInfo } from "@/lib/types";
import { tableInfo, useConnections } from "@/store/connections";
import { useDialogs } from "@/store/dialogs";
import { useEditors, type Scope } from "@/store/editors";
import { toast, useUi } from "@/store/ui";
import { Button, IconButton, Spinner, cx, type ContextMenuItem } from "@/components";
import { ResultGrid, type CellPos, type GridHandle } from "./ResultGrid";
import { RecordView, ValuePanel } from "./ValuePanel";
import { addRow, deleteRows, editCount, emptyEdits, hasEdits, rowValues, setCell, toChanges, type GridEdits } from "./edits";

export interface ResultData {
  sql: string;
  columns: ColumnInfo[];
  rows: Cell[][];
  hasMore: boolean;
  rowsAffected: number | null;
  elapsedMs: number;
}

interface Props {
  /** Editor / tab that owns the session. */
  ownerId: string;
  scope: Scope;
  result: ResultData;
  /** Table the rows belong to: enables editing. */
  source: { database: string | null; schema: string | null; name: string } | null;
  sort?: SortKey[];
  onSortChange?(s: SortKey[]): void;
  onReload(): Promise<void> | void;
  onFetchMore?(all: boolean): void;
  /** COUNT query for "total rows" (defaults to wrapping the result's SQL). */
  countSql?: string;
  extraMenu?(pos: CellPos, value: Cell): ContextMenuItem[];
  /** Name for exports / "Copy as SQL". */
  name?: string;
  loading?: boolean;
}

const VALUE_W_KEY = "helix.valuePanelWidth";

export function ResultView({ ownerId, scope, result, source, sort, onSortChange, onReload, onFetchMore, countSql, extraMenu, name, loading }: Props) {
  const conn = useConnections((s) => s.connections.find((c) => c.id === scope.connectionId));
  const prefs = useUi((s) => s.prefs);
  const [edits, setEdits] = useState<GridEdits>(emptyEdits);
  const [keyColumns, setKeyColumns] = useState<string[]>([]);
  const [kinds, setKinds] = useState<Record<string, ColumnInfo["kind"]>>({});
  const [focus, setFocus] = useState<CellPos | null>(null);
  const [panel, setPanel] = useState(false);
  const [record, setRecord] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [panelW, setPanelW] = useState(() => Number(localStorage.getItem(VALUE_W_KEY)) || 340);
  const grid = useRef<GridHandle>(null);

  const editable = !!source && !!conn && !conn.readOnly;

  // A new result drops pending edits and the total.
  useEffect(() => {
    setEdits(emptyEdits());
    setTotal(null);
  }, [result]);

  // Key columns and declared types of the source table.
  useEffect(() => {
    setKeyColumns([]);
    setKinds({});
    if (!source || !conn) return;
    let alive = true;
    tableInfo(conn.id, source.database ?? scope.database ?? "", source.schema ?? scope.schema, source.name)
      .then((info) => {
        if (!alive) return;
        setKeyColumns(info.primaryKey);
        setKinds(Object.fromEntries(info.columns.map((c) => [c.name, kindOf(c.dataType)])));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [source?.name, source?.schema, source?.database, conn?.id, scope.database, scope.schema]);

  const dirty = hasEdits(edits);

  const save = async () => {
    if (!source || !conn) return;
    try {
      const info = await tableInfo(conn.id, source.database ?? scope.database ?? "", source.schema ?? scope.schema, source.name);
      const keys = info.primaryKey.filter((k) => result.columns.some((c) => c.name === k));
      const hasAllKeys = keys.length === info.primaryKey.length && keys.length > 0;
      const columns = result.columns.map((c) => ({ name: c.name, kind: kinds[c.name] ?? c.kind }));
      const statements = changeStatements(
        {
          driver: conn.driver,
          table: { database: source.database ?? scope.database ?? "", schema: source.schema ?? scope.schema, name: source.name },
          currentDatabase: scope.database ?? undefined,
          columns,
          keyColumns: hasAllKeys ? keys : [],
        },
        toChanges(edits, result.rows),
      );
      if (!statements.length) return setEdits(emptyEdits());
      if (prefs.previewChanges || !hasAllKeys || conn.environment === "production") {
        const ans = await useUi.getState().ask({
          title: `Save ${plural(statements.length, "change")}?`,
          message: (
            <div className="flex flex-col gap-2">
              {!hasAllKeys && (
                <div className="rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[12px] text-amber-500">
                  {source.name} has no primary key in this result: rows are matched by all their values, which may change more than one row.
                </div>
              )}
              <pre className="thin-scroll max-h-[300px] overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--bg-input)] p-2.5 font-mono text-[11.5px] text-[var(--text-main)]">
                {statements.join(";\n") + ";"}
              </pre>
            </div>
          ),
          buttons: [
            { id: "save", label: "Save", variant: conn.environment === "production" ? "danger" : "primary" },
            { id: "cancel", label: "Cancel" },
          ],
          cancelId: "cancel",
        });
        if (ans !== "save") return;
      }
      setSaving(true);
      const session = await useEditors.getState().ensureSession(ownerId, scope);
      if (!session) return;
      const counts = await api.executeBatch(conn.id, session.id, statements);
      const changed = counts.reduce<number>((a, b) => a + (b ?? 0), 0);
      const st = await api.sessionState(conn.id, session.id).catch(() => null);
      if (st) useEditors.getState().patch(ownerId, { session: st });
      toast(st?.inTransaction ? "Changes applied — commit to keep them" : "Changes saved", "success", `${plural(changed, "row")} affected`);
      useEditors.getState().addLog(ownerId, { sql: statements.join(";\n"), message: `${plural(statements.length, "statement")} · ${plural(changed, "row")} affected`, kind: "ok", elapsedMs: null });
      setEdits(emptyEdits());
      await onReload();
    } catch (e) {
      toast("Could not save changes", "error", errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const countRows = async () => {
    if (!conn) return;
    setCounting(true);
    try {
      const [r] = await api.metaQuery(conn.id, scope.database ?? "", countSql ?? countQuery(conn.driver, result.sql));
      setTotal(Number(r.rows[0]?.[0] ?? 0));
    } catch (e) {
      toast("Could not count rows", "error", errorMessage(e));
    } finally {
      setCounting(false);
    }
  };

  const focusedRow = focus ? rowValues(edits, result.rows, focus.row) : null;
  const focusedValue = focus && focusedRow ? (focusedRow[focus.col] ?? null) : null;
  const columnsForGrid = useMemo(
    () => result.columns.map((c) => (kinds[c.name] && c.kind === "other" ? { ...c, kind: kinds[c.name] } : c)),
    [result.columns, kinds],
  );

  const startPanelResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelW;
    let latest = startW;
    const onMove = (ev: MouseEvent) => {
      latest = Math.min(Math.max(startW - (ev.clientX - startX), 220), 900);
      setPanelW(latest);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      localStorage.setItem(VALUE_W_KEY, String(latest));
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const info = [
    `${plural(result.rows.length, "row")}${result.hasMore ? "+" : ""}`,
    total !== null ? `of ${total.toLocaleString()}` : null,
    duration(result.elapsedMs),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        {record ? (
          <RecordView columns={columnsForGrid} row={focusedRow ?? (result.rows[0] ? rowValues(edits, result.rows, 0) : null)} nullText={prefs.nullText} />
        ) : (
          <ResultGrid
            ref={grid}
            columns={columnsForGrid}
            rows={result.rows}
            edits={edits}
            editable={editable}
            onEditsChange={setEdits}
            sort={sort}
            onSortChange={onSortChange}
            nullText={prefs.nullText}
            driver={conn?.driver}
            tableName={name ?? source?.name}
            keyColumns={keyColumns}
            onFocusCell={setFocus}
            extraMenu={extraMenu}
            onOpenValue={() => setPanel(true)}
            fontSize={Math.max(11, prefs.editorFontSize - 0.5)}
          />
        )}
        {panel && (
          <div className="relative flex shrink-0" style={{ width: panelW }}>
            <div className="panel-resizer" onMouseDown={startPanelResize} />
            <ValuePanel
              column={focus ? columnsForGrid[focus.col] : null}
              value={focusedValue}
              editable={editable && !!focus}
              nullText={prefs.nullText}
              onClose={() => setPanel(false)}
              onApply={(v) => focus && setEdits((e) => setCell(e, result.rows, focus.row, focus.col, v))}
            />
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-t border-[var(--border-soft)] bg-[var(--bg-sidebar)] px-2 text-[12px]">
        {loading ? <Spinner size={12} className="mx-1 text-[var(--accent)]" /> : null}
        <span className="truncate px-1 text-[var(--text-dim)]" data-testid="result-info">
          {info}
        </span>
        {result.hasMore && onFetchMore && (
          <>
            <Button size="xs" variant="ghost" icon={<ChevronsDown size={12} />} onClick={() => onFetchMore(false)} title="Fetch the next page">
              More
            </Button>
            <Button size="xs" variant="ghost" onClick={() => onFetchMore(true)} title="Fetch every row">
              All
            </Button>
          </>
        )}
        <IconButton size="xs" label="Count all rows" onClick={() => void countRows()} disabled={counting}>
          {counting ? <Spinner size={12} /> : <Hash size={12.5} />}
        </IconButton>

        <div className="flex-1" />

        {editable && (
          <>
            {dirty && (
              <span className="mr-1 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-500">{plural(editCount(edits), "change")}</span>
            )}
            <IconButton size="xs" label="Add row (Insert)" onClick={() => setEdits((e) => addRow(e, result.columns.length))}>
              <Plus size={13} />
            </IconButton>
            <IconButton
              size="xs"
              label="Delete selected rows (Delete)"
              tone="danger"
              onClick={() => {
                const rows = grid.current?.selectedRows() ?? [];
                if (rows.length) setEdits((e) => deleteRows(e, result.rows, rows));
              }}
            >
              <Trash2 size={12.5} />
            </IconButton>
            <div className="mx-1 h-4 w-px bg-[var(--border)]" />
            <Button size="xs" variant="ghost" icon={<Undo2 size={12} />} disabled={!dirty || saving} onClick={() => setEdits(emptyEdits())}>
              Cancel
            </Button>
            <Button size="xs" variant="primary" data-testid="save-edits" icon={saving ? <Spinner size={12} /> : <Check size={12} />} disabled={!dirty || saving} onClick={() => void save()}>
              Save
            </Button>
            <div className="mx-1 h-4 w-px bg-[var(--border)]" />
          </>
        )}
        <IconButton size="xs" label="Reload" onClick={() => void onReload()} disabled={dirty}>
          <RotateCcw size={12.5} />
        </IconButton>
        <IconButton size="xs" label={record ? "Grid" : "Record view"} className={cx(record && "text-[var(--accent)]")} onClick={() => setRecord((r) => !r)}>
          <Rows3 size={13} />
        </IconButton>
        <IconButton size="xs" label="Value panel" className={cx(panel && "text-[var(--accent)]")} onClick={() => setPanel((p) => !p)}>
          <PanelRight size={13} />
        </IconButton>
        <IconButton
          size="xs"
          label="Export data…"
          disabled={!conn}
          onClick={() => conn && useDialogs.getState().openExport({ connectionId: conn.id, database: scope.database ?? "", sql: result.sql, name: name ?? source?.name ?? "result" })}
        >
          <Download size={13} />
        </IconButton>
      </div>
    </div>
  );
}
