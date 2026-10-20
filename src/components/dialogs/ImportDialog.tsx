import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, FolderOpen, X } from "lucide-react";
import { api, errorMessage, isTauri } from "@/lib/api";
import { parseCsv, sniffDelimiter } from "@/lib/csv";
import { ident, kindOf, literal, qualified, truncateSql } from "@/lib/sql/dialect";
import type { ColumnDef } from "@/lib/types";
import { useDialogs } from "@/store/dialogs";
import { invalidateTable, tableInfo, useConnections } from "@/store/connections";
import { prefs } from "@/store/ui";
import { Alert, Button, Combobox, Dialog, Field, IconButton, Input, SettingRow, Spinner, Switch } from "@/components";

const SKIP = "\u0000skip";

/** CSV → INSERT statements into a table, with column mapping. */
export function ImportDialog() {
  const req = useDialogs((s) => s.importReq);
  const close = useDialogs((s) => s.close);
  const conn = useConnections((s) => (req ? s.connections.find((c) => c.id === req.connectionId) : undefined));
  const [columns, setColumns] = useState<ColumnDef[]>([]);
  const [path, setPath] = useState("");
  const [text, setText] = useState<string | null>(null);
  const [delimiter, setDelimiter] = useState(",");
  const [header, setHeader] = useState(true);
  const [emptyNull, setEmptyNull] = useState(true);
  const [truncate, setTruncate] = useState(false);
  const [batch, setBatch] = useState(200);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [state, setState] = useState<{ kind: "idle" } | { kind: "running"; done: number; total: number } | { kind: "done"; rows: number } | { kind: "error"; message: string }>({ kind: "idle" });

  useEffect(() => {
    if (!req) return;
    setState({ kind: "idle" });
    setText(null);
    setPath("");
    setTruncate(false);
    tableInfo(req.connectionId, req.database, req.schema, req.table).then(
      (i) => setColumns(i.columns),
      (e) => setState({ kind: "error", message: errorMessage(e) }),
    );
  }, [req]);

  const rows = useMemo(() => (text === null ? [] : parseCsv(text, delimiter).filter((r) => r.length > 1 || r[0] !== "")), [text, delimiter]);
  const headers = useMemo(() => (header ? (rows[0] ?? []) : (rows[0] ?? []).map((_, i) => `column ${i + 1}`)), [rows, header]);
  const data = header ? rows.slice(1) : rows;

  // Map table columns to CSV columns of the same name.
  useEffect(() => {
    const m: Record<string, string> = {};
    for (const c of columns) {
      const i = headers.findIndex((h) => h.trim().toLowerCase() === c.name.toLowerCase());
      m[c.name] = i >= 0 ? String(i) : SKIP;
    }
    if (!header && columns.length) columns.forEach((c, i) => i < headers.length && (m[c.name] = String(i)));
    setMapping(m);
  }, [columns, headers, header]);

  const choose = async () => {
    if (!isTauri()) return setState({ kind: "error", message: "Importing files is available in the desktop app" });
    const p = await api.pickOpenFile([
      { name: "CSV files", extensions: ["csv", "tsv", "txt"] },
      { name: "All files", extensions: ["*"] },
    ]);
    if (!p) return;
    try {
      const t = await api.readTextFile(p);
      setPath(p);
      setText(t);
      setDelimiter(p.toLowerCase().endsWith(".tsv") ? "\t" : sniffDelimiter(t));
      setState({ kind: "idle" });
    } catch (e) {
      setState({ kind: "error", message: errorMessage(e) });
    }
  };

  const mapped = columns.filter((c) => mapping[c.name] && mapping[c.name] !== SKIP);

  const run = async () => {
    if (!req || !conn || !mapped.length) return;
    const driver = conn.driver;
    const name = qualified(driver, { database: req.database, schema: req.schema, name: req.table }, req.database);
    const cols = mapped.map((c) => ident(driver, c.name)).join(", ");
    const statements: string[] = [];
    if (truncate) statements.push(truncateSql(driver, { database: req.database, schema: req.schema, name: req.table }, req.database));
    // SQL Server takes at most 1000 rows per VALUES list.
    const per = Math.max(1, Math.min(batch, driver === "mssql" ? 1000 : 5000));
    for (let i = 0; i < data.length; i += per) {
      const values = data.slice(i, i + per).map(
        (r) =>
          "(" +
          mapped
            .map((c) => {
              const v = r[Number(mapping[c.name])] ?? null;
              return literal(driver, v === null || (emptyNull && v === "") ? null : v, kindOf(c.dataType));
            })
            .join(", ") +
          ")",
      );
      statements.push(`INSERT INTO ${name} (${cols}) VALUES\n${values.join(",\n")}`);
    }
    setState({ kind: "running", done: 0, total: data.length });
    let session: string | null = null;
    try {
      if (!(await useConnections.getState().ensureConnected(conn.id))) throw new Error("Not connected");
      const s = await api.openSession(conn.id, req.database, req.schema, true);
      session = s.id;
      // One transaction per chunk of statements keeps progress visible.
      const CHUNK = 10;
      let done = 0;
      for (let i = 0; i < statements.length; i += CHUNK) {
        const part = statements.slice(i, i + CHUNK);
        await api.executeBatch(conn.id, s.id, part);
        done = Math.min(data.length, done + part.filter((p) => p.startsWith("INSERT")).length * per);
        setState({ kind: "running", done, total: data.length });
      }
      invalidateTable(conn.id, req.database, req.schema, req.table);
      setState({ kind: "done", rows: data.length });
    } catch (e) {
      setState({ kind: "error", message: errorMessage(e) });
    } finally {
      if (session) void api.closeSession(conn.id, session);
    }
  };

  const running = state.kind === "running";
  const nullText = prefs().nullText;

  return (
    <Dialog open={!!req} onClose={() => !running && close()} label="Import data" className="h-[min(760px,calc(100vh-40px))] w-[min(780px,calc(100vw-40px))]" closeOnBackdrop={!running}>
      <div className="flex items-center gap-3 px-6 pb-2 pt-5">
        <div className="min-w-0 flex-1">
          <div className="text-[17px] font-semibold text-[var(--text-main)]">Import data</div>
          <div className="mt-0.5 truncate text-[12.5px] text-[var(--text-dim)]">
            CSV into {req?.schema ? `${req.schema}.` : ""}
            {req?.table} · {conn?.name}
          </div>
        </div>
        <IconButton label="Close" onClick={close} disabled={running}>
          <X size={14} />
        </IconButton>
      </div>
      <div className="thin-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-6 py-3">
        <Field label="CSV file">
          <div className="flex gap-2">
            <Input mono readOnly value={path} placeholder="Choose a file…" />
            <Button icon={<FolderOpen size={13} />} onClick={() => void choose()} disabled={running}>
              Browse
            </Button>
          </div>
        </Field>

        {text !== null && (
          <>
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-2xl border border-[var(--border-soft)] bg-[var(--bg-app)] px-4 py-3">
              <SettingRow title="Delimiter">
                <div className="w-[150px]">
                  <Combobox
                    searchable={false}
                    value={delimiter}
                    onChange={setDelimiter}
                    options={[
                      { value: ",", label: "Comma" },
                      { value: ";", label: "Semicolon" },
                      { value: "\t", label: "Tab" },
                      { value: "|", label: "Pipe" },
                    ]}
                  />
                </div>
              </SettingRow>
              <SettingRow title="Header row">
                <Switch on={header} onChange={setHeader} ariaLabel="Header row" />
              </SettingRow>
              <SettingRow title="Empty as NULL">
                <Switch on={emptyNull} onChange={setEmptyNull} ariaLabel="Empty as NULL" />
              </SettingRow>
              <SettingRow title="Empty the table first">
                <Switch on={truncate} onChange={setTruncate} ariaLabel="Truncate first" />
              </SettingRow>
              <SettingRow title="Rows per INSERT">
                <Input className="w-[90px]" mono value={String(batch)} onChange={(e) => setBatch(Math.max(1, Number(e.target.value.replace(/\D/g, "")) || 1))} />
              </SettingRow>
              <div className="flex items-center text-[12.5px] text-[var(--text-muted)]">{data.length.toLocaleString()} rows in the file</div>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="px-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-dim)]">Column mapping</div>
              <div className="overflow-hidden rounded-2xl border border-[var(--border-soft)]">
                {columns.map((c) => (
                  <div key={c.name} className="flex items-center gap-3 border-b border-[var(--border-soft)] px-3 py-1.5 last:border-0">
                    <div className="min-w-0 flex-1">
                      <span className="text-[12.5px] text-[var(--text-main)]">{c.name}</span>
                      <span className="ml-2 font-mono text-[11px] text-[var(--text-dim)]">{c.dataType}</span>
                      {c.autoIncrement && <span className="ml-2 text-[11px] text-[var(--text-dim)]">auto</span>}
                    </div>
                    <div className="w-[240px]">
                      <Combobox
                        value={mapping[c.name] ?? SKIP}
                        onChange={(v) => setMapping({ ...mapping, [c.name]: v })}
                        options={[{ value: SKIP, label: "— skip (default value) —" }, ...headers.map((h, i) => ({ value: String(i), label: h || `column ${i + 1}`, hint: `#${i + 1}` }))]}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="px-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-dim)]">Preview</div>
              <div className="thin-scroll overflow-auto rounded-2xl border border-[var(--border-soft)]">
                <table className="w-full border-collapse text-[12px]">
                  <thead>
                    <tr className="bg-[var(--bg-sidebar)]">
                      {mapped.map((c) => (
                        <th key={c.name} className="whitespace-nowrap px-2.5 py-1.5 text-left font-medium text-[var(--text-muted)]">
                          {c.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.slice(0, 6).map((r, i) => (
                      <tr key={i} className="border-t border-[var(--border-soft)]">
                        {mapped.map((c) => {
                          const v = r[Number(mapping[c.name])];
                          return (
                            <td key={c.name} className="max-w-[220px] truncate whitespace-nowrap px-2.5 py-1 text-[var(--text-main)]">
                              {v === undefined || (emptyNull && v === "") ? <span className="cell-null">{nullText}</span> : v}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {state.kind === "done" && (
          <Alert tone="success" icon={<CheckCircle2 size={14} className="text-[var(--diff-add)]" />}>
            Imported {state.rows.toLocaleString()} rows.
          </Alert>
        )}
        {state.kind === "error" && (
          <Alert>
            <span className="selectable whitespace-pre-wrap">{state.message}</span>
          </Alert>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-[var(--border-soft)] px-6 py-4">
        {running && (
          <span className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
            <Spinner size={13} className="text-[var(--accent)]" />
            {state.done.toLocaleString()} / {state.total.toLocaleString()} rows
          </span>
        )}
        <div className="flex-1" />
        <Button variant="ghost" onClick={close} disabled={running}>
          Close
        </Button>
        <Button variant="primary" disabled={running || !mapped.length || !data.length} onClick={() => void run()}>
          Import {data.length ? data.length.toLocaleString() : ""} rows
        </Button>
      </div>
    </Dialog>
  );
}
