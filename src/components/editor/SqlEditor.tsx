import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SQLNamespace } from "@codemirror/lang-sql";
import { Check, Gauge, ListVideo, Lock, Play, Save, Square, Undo2, WandSparkles } from "lucide-react";
import { formatSql } from "@/lib/sql/format";
import { splitStatements, statementAt } from "@/lib/sql/split";
import { plural } from "@/lib/format";
import { registerEditor } from "@/app/actions";
import { saveSqlTab } from "@/app/files";
import { defaultSchema, schemaModel, useConnections } from "@/store/connections";
import { useEditors, type Scope } from "@/store/editors";
import { toast, useUi } from "@/store/ui";
import { useWorkspace, type SqlTab } from "@/store/workspace";
import { Button, IconButton, Kbd, Segmented, cx } from "@/components";
import { CodeEditor, type CodeEditorHandle } from "./CodeEditor";
import { ConnectionPicker, DatabasePicker, SchemaPicker } from "./Pickers";
import { ResultsPanel } from "./ResultsPanel";

const Divider = () => <div className="mx-1 h-4 w-px shrink-0 bg-[var(--border)]" />;

/** Completion namespace from the active schema's tables. */
function useCompletion(scope: Scope | null, connected: boolean): SQLNamespace | undefined {
  const [ns, setNs] = useState<SQLNamespace | undefined>();
  const autocomplete = useUi((s) => s.prefs.autocomplete);
  useEffect(() => {
    setNs(undefined);
    if (!scope || !connected || !autocomplete) return;
    let alive = true;
    schemaModel(scope.connectionId, scope.database ?? "", scope.schema)
      .then((tables) => {
        if (!alive) return;
        const flat: Record<string, string[]> = {};
        for (const t of tables) flat[t.name] = t.columns.map((c) => c.name);
        setNs(scope.schema ? { ...flat, [scope.schema]: flat } : flat);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [scope?.connectionId, scope?.database, scope?.schema, connected, autocomplete]);
  return ns;
}

export function SqlEditor({ tab }: { tab: SqlTab }) {
  const conn = useConnections((s) => (tab.connectionId ? s.connections.find((c) => c.id === tab.connectionId) : undefined));
  const status = useConnections((s) => (tab.connectionId ? s.status[tab.connectionId] : undefined));
  const server = useConnections((s) => (tab.connectionId ? s.servers[tab.connectionId] : undefined));
  const prefs = useUi((s) => s.prefs);
  const rt = useEditors((s) => s.editors[tab.id]);
  const editor = useRef<CodeEditorHandle>(null);
  const [cursor, setCursor] = useState({ line: 1, col: 1, selected: 0 });
  const splitRef = useRef<HTMLDivElement>(null);
  const { update } = useWorkspace.getState();
  const eds = useEditors.getState();

  const driver = conn?.driver ?? "postgres";
  const database = tab.database ?? server?.database ?? (conn?.database || null);
  const schema = tab.schema ?? (conn ? defaultSchema(conn.driver) : null);
  const scope: Scope | null = conn ? { connectionId: conn.id, database, schema: driver === "postgres" || driver === "mssql" ? schema : null } : null;
  const completion = useCompletion(scope, status === "connected");
  const session = rt?.session;
  const running = !!rt?.running;
  const hasResults = !!rt && (rt.results.length > 0 || rt.log.length > 0 || running);

  const statementsAtCursor = useCallback((): string[] => {
    const sel = editor.current?.selection() ?? "";
    if (sel.trim()) return [sel.trim()];
    const doc = editor.current?.view()?.state.doc.toString() ?? tab.sql;
    const st = statementAt(splitStatements(doc, driver, prefs.blankLineDelimiter), editor.current?.cursor() ?? 0, doc);
    return st ? [st.text] : [];
  }, [driver, prefs.blankLineDelimiter, tab.sql]);

  const needScope = (): Scope | null => {
    if (!scope) {
      toast("Choose a connection for this editor", "warning");
      return null;
    }
    return scope;
  };

  const actions = useMemo(
    () => ({
      runStatement() {
        const s = needScope();
        const stmts = statementsAtCursor();
        if (s && stmts.length) void eds.run(tab.id, s, stmts);
      },
      runScript() {
        const s = needScope();
        if (!s) return;
        const sel = editor.current?.selection() ?? "";
        const text = sel.trim() ? sel : (editor.current?.view()?.state.doc.toString() ?? tab.sql);
        const stmts = splitStatements(text, driver, false).map((x) => x.text);
        if (stmts.length) void eds.run(tab.id, s, stmts);
      },
      explain(analyze = false) {
        const s = needScope();
        const [stmt] = statementsAtCursor();
        if (s && stmt) void eds.explain(tab.id, s, stmt, analyze);
      },
      format() {
        const v = editor.current?.view();
        if (!v) return;
        const sel = v.state.selection.main;
        const opts = { uppercase: prefs.formatUppercase, tabWidth: prefs.tabSize };
        if (sel.from !== sel.to) {
          v.dispatch(v.state.replaceSelection(formatSql(v.state.sliceDoc(sel.from, sel.to), driver, opts)));
        } else {
          v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: formatSql(v.state.doc.toString(), driver, opts) } });
        }
      },
      cancel() {
        void eds.cancel(tab.id);
      },
      save(as = false) {
        const cur = useWorkspace.getState().tabs.find((t) => t.id === tab.id);
        if (cur?.kind === "sql") void saveSqlTab(cur, as);
      },
      focus() {
        editor.current?.focus();
      },
      insert(text: string) {
        editor.current?.insert(text);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab.id, scope?.connectionId, scope?.database, scope?.schema, driver, statementsAtCursor, prefs.formatUppercase, prefs.tabSize],
  );

  useEffect(() => registerEditor(tab.id, actions), [tab.id, actions]);
  useEffect(() => {
    requestAnimationFrame(() => editor.current?.focus());
  }, [tab.id]);

  const setConnection = async (id: string) => {
    if (id === tab.connectionId) return;
    if (session?.inTransaction) {
      const ans = await useUi.getState().ask({
        title: "Switch connection?",
        message: `The open transaction (${plural(session.transactionStatements, "statement")}) is rolled back.`,
        buttons: [
          { id: "switch", label: "Roll back & switch", variant: "danger" },
          { id: "cancel", label: "Cancel" },
        ],
        cancelId: "cancel",
      });
      if (ans !== "switch") return;
    }
    await eds.closeSession(tab.id);
    update(tab.id, { connectionId: id, database: null, schema: null });
    void useConnections.getState().ensureConnected(id);
  };

  const setDatabase = (db: string) => {
    update(tab.id, { database: db, schema: null });
    if (session && conn) void eds.ensureSession(tab.id, { connectionId: conn.id, database: db, schema: driver === "postgres" || driver === "mssql" ? defaultSchema(driver) : null });
  };

  const setSchema = (s: string) => {
    update(tab.id, { schema: s });
    if (session && conn) void eds.ensureSession(tab.id, { connectionId: conn.id, database, schema: s });
  };

  const startSplit = (e: React.MouseEvent) => {
    e.preventDefault();
    const box = splitRef.current?.getBoundingClientRect();
    if (!box) return;
    const onMove = (ev: MouseEvent) => {
      const f = Math.min(Math.max((ev.clientY - box.top) / box.height, 0.12), 0.88);
      useUi.getState().setPref("editorSplit", f);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "row-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const autoCommit = session ? session.autoCommit : prefs.autoCommit;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-[var(--border-soft)] px-2">
        <ConnectionPicker value={tab.connectionId} onPick={(id) => void setConnection(id)} />
        {conn && conn.driver !== "sqlite" && <DatabasePicker connectionId={conn.id} value={database} onPick={setDatabase} />}
        {conn && (driver === "postgres" || driver === "mssql") && database && (
          <SchemaPicker connectionId={conn.id} database={database} value={schema} onPick={setSchema} />
        )}
        <Divider />
        <IconButton label="Execute statement (Ctrl+Enter)" data-testid="run-statement" disabled={running} onClick={actions.runStatement} className="text-[var(--diff-add)] hover:text-[var(--diff-add)]">
          <Play size={14} fill="currentColor" />
        </IconButton>
        <IconButton label="Execute script (Alt+X)" data-testid="run-script" disabled={running} onClick={actions.runScript}>
          <ListVideo size={15} />
        </IconButton>
        <IconButton label="Explain plan (Ctrl+Shift+E)" disabled={running} onClick={() => actions.explain(false)}>
          <Gauge size={14} />
        </IconButton>
        {running && (
          <IconButton label="Cancel (Ctrl+Shift+Q)" tone="danger" onClick={actions.cancel} className="text-[var(--diff-del)]">
            <Square size={12} fill="currentColor" />
          </IconButton>
        )}
        <Divider />
        <IconButton label="Format SQL (Ctrl+Shift+F)" onClick={actions.format}>
          <WandSparkles size={14} />
        </IconButton>
        <IconButton label="Save script (Ctrl+S)" onClick={() => actions.save()}>
          <Save size={14} />
        </IconButton>

        <div className="flex-1" />

        {conn?.readOnly && (
          <span className="mr-1 flex items-center gap-1 text-[11.5px] text-[var(--text-dim)]" title="Read-only connection">
            <Lock size={12} /> read-only
          </span>
        )}
        {session?.inTransaction && (
          <span className="mr-1 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-500" data-testid="tx-pending">
            {session.transactionStatements ? plural(session.transactionStatements, "pending change") : "transaction open"}
          </span>
        )}
        {!autoCommit && (
          <>
            <Button size="xs" variant="ghost" icon={<Check size={12} />} disabled={!session?.inTransaction} onClick={() => void eds.endTransaction(tab.id, true)} data-testid="commit">
              Commit
            </Button>
            <Button size="xs" variant="ghost" icon={<Undo2 size={12} />} disabled={!session?.inTransaction} onClick={() => void eds.endTransaction(tab.id, false)} data-testid="rollback">
              Rollback
            </Button>
          </>
        )}
        <Segmented
          size="xs"
          value={autoCommit ? "auto" : "manual"}
          onChange={(v) => void eds.setAutoCommit(tab.id, v === "auto")}
          options={[
            { value: "auto", label: "Auto", title: "Auto-commit: every statement is committed" },
            { value: "manual", label: "Manual", title: "Manual commit: Commit / Rollback the transaction" },
          ]}
        />
        <Divider />
        <label className="flex items-center gap-1 pl-1 text-[11.5px] text-[var(--text-dim)]" title="Rows fetched per query">
          Limit
          <input
            aria-label="Row limit"
            className="h-6 w-[58px] rounded-md bg-[var(--bg-input)] px-1.5 text-right font-mono text-[11.5px] text-[var(--text-main)] outline-none focus:ring-1 focus:ring-[var(--accent)]"
            value={prefs.rowLimit}
            onChange={(e) => useUi.getState().setPref("rowLimit", Math.max(1, Math.min(1_000_000, Number(e.target.value.replace(/\D/g, "")) || 1)))}
          />
        </label>
      </div>

      {/* Editor + results */}
      <div ref={splitRef} className="relative flex min-h-0 flex-1 flex-col">
        <div className="relative min-h-0" style={{ flex: hasResults ? `0 0 ${prefs.editorSplit * 100}%` : "1 1 auto" }}>
          <CodeEditor
            ref={editor}
            value={tab.sql}
            onChange={(sql) => update(tab.id, { sql })}
            driver={driver}
            schema={completion}
            defaultSchema={scope?.schema ?? undefined}
            fontSize={prefs.editorFontSize}
            tabSize={prefs.tabSize}
            wordWrap={prefs.wordWrap}
            autocomplete={prefs.autocomplete}
            placeholder={conn ? `-- ${conn.name}: write SQL, Ctrl+Enter runs the statement under the cursor` : "-- Choose a connection above, then write SQL"}
            onRunStatement={actions.runStatement}
            onRunScript={actions.runScript}
            onExplain={() => actions.explain(false)}
            onFormat={actions.format}
            onSave={() => actions.save()}
            onCursor={setCursor}
          />
          {!hasResults && (
            <div className="pointer-events-none absolute bottom-3 right-4 flex items-center gap-3 text-[11px] text-[var(--text-dim)]">
              <span className="flex items-center gap-1">
                <Kbd>Ctrl</Kbd>
                <Kbd>Enter</Kbd> statement
              </span>
              <span className="flex items-center gap-1">
                <Kbd>Alt</Kbd>
                <Kbd>X</Kbd> script
              </span>
              <span className="flex items-center gap-1">
                <Kbd>Ctrl</Kbd>
                <Kbd>Space</Kbd> complete
              </span>
            </div>
          )}
        </div>
        {hasResults && (
          <div className="relative flex min-h-0 flex-1 flex-col border-t border-[var(--border)]">
            <div className="split-resizer" onMouseDown={startSplit} />
            <ResultsPanel ownerId={tab.id} scope={scope} onCancel={actions.cancel} />
          </div>
        )}
      </div>

      {/* Status line */}
      <div className={cx("flex h-6 shrink-0 items-center gap-3 border-t border-[var(--border-soft)] bg-[var(--bg-sidebar)] px-3 text-[11px] text-[var(--text-dim)]")}>
        <span>{conn ? `${conn.name}${database ? ` · ${database}` : ""}${scope?.schema ? `.${scope.schema}` : ""}` : "No connection"}</span>
        {conn && <span>{status === "connected" ? "connected" : status === "connecting" ? "connecting…" : "not connected"}</span>}
        <div className="flex-1" />
        <span>
          Ln {cursor.line}, Col {cursor.col}
          {cursor.selected ? ` (${cursor.selected} selected)` : ""}
        </span>
        <span>{autoCommit ? "Auto-commit" : "Manual commit"}</span>
        <span>{tab.filePath ?? "unsaved script"}</span>
      </div>
    </div>
  );
}
