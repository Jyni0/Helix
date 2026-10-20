import { useEffect, useState } from "react";
import { CheckCircle2, FolderOpen, X } from "lucide-react";
import { api, errorKind, errorMessage, isTauri } from "@/lib/api";
import { uid } from "@/lib/format";
import type { ExportFormat, ExportOptions } from "@/lib/types";
import { useDialogs } from "@/store/dialogs";
import { useConnections } from "@/store/connections";
import { Alert, Button, Combobox, Dialog, Field, IconButton, Input, Sep, SettingRow, Spinner, Switch, cx } from "@/components";

const FORMATS: { id: ExportFormat; label: string; ext: string; hint: string }[] = [
  { id: "csv", label: "CSV", ext: "csv", hint: "Spreadsheets" },
  { id: "tsv", label: "TSV", ext: "tsv", hint: "Tab-separated" },
  { id: "json", label: "JSON", ext: "json", hint: "Array of objects" },
  { id: "sql", label: "SQL", ext: "sql", hint: "INSERT statements" },
  { id: "markdown", label: "Markdown", ext: "md", hint: "Table" },
  { id: "xml", label: "XML", ext: "xml", hint: "Rows / columns" },
  { id: "html", label: "HTML", ext: "html", hint: "Web page" },
];

const DELIMITERS = [
  { value: ",", label: "Comma  ,", hint: "," },
  { value: ";", label: "Semicolon  ;", hint: ";" },
  { value: "|", label: "Pipe  |", hint: "|" },
];

/** Exports a query's full result to a file (streamed by the core, every row). */
export function ExportDialog() {
  const req = useDialogs((s) => s.exportReq);
  const close = useDialogs((s) => s.close);
  const conn = useConnections((s) => (req ? s.connections.find((c) => c.id === req.connectionId) : undefined));
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [o, setO] = useState<Omit<ExportOptions, "format" | "path">>({ delimiter: ",", header: true, nullText: "", quoteAll: false, tableName: "", batchSize: 1, bom: false });
  const [path, setPath] = useState("");
  const [state, setState] = useState<{ kind: "idle" } | { kind: "running"; id: string; rows: number } | { kind: "done"; rows: number } | { kind: "error"; message: string }>({ kind: "idle" });

  useEffect(() => {
    if (!req) return;
    setState({ kind: "idle" });
    setO((x) => ({ ...x, tableName: req.name }));
    setPath("");
  }, [req]);

  const ext = FORMATS.find((f) => f.id === format)!.ext;
  const browse = async () => {
    const p = await api.pickSaveFile(`${(req?.name ?? "export").replace(/[\\/:*?"<>|]/g, "_")}.${ext}`, [
      { name: `${format.toUpperCase()} file`, extensions: [ext] },
      { name: "All files", extensions: ["*"] },
    ]);
    if (p) setPath(p);
  };

  const run = async () => {
    if (!req) return;
    let target = path;
    if (!target) {
      if (!isTauri()) return setState({ kind: "error", message: "Exporting to files is available in the desktop app" });
      const p = await api.pickSaveFile(`${req.name.replace(/[\\/:*?"<>|]/g, "_")}.${ext}`, [{ name: `${format.toUpperCase()} file`, extensions: [ext] }]);
      if (!p) return;
      target = p;
      setPath(p);
    }
    const id = uid();
    setState({ kind: "running", id, rows: 0 });
    try {
      if (!(await useConnections.getState().ensureConnected(req.connectionId))) throw new Error("Not connected");
      const rows = await api.exportQuery(req.connectionId, req.database, req.sql, { ...o, format, path: target }, id, (n) =>
        setState((s) => (s.kind === "running" && s.id === id ? { ...s, rows: n } : s)),
      );
      setState({ kind: "done", rows });
    } catch (e) {
      setState(errorKind(e) === "cancelled" ? { kind: "idle" } : { kind: "error", message: errorMessage(e) });
    }
  };

  const running = state.kind === "running";

  return (
    <Dialog open={!!req} onClose={() => !running && close()} label="Export data" className="w-[min(640px,calc(100vw-40px))]" closeOnBackdrop={!running}>
      <div className="flex items-center gap-3 px-6 pb-2 pt-5">
        <div className="min-w-0 flex-1">
          <div className="text-[17px] font-semibold text-[var(--text-main)]">Export data</div>
          <div className="mt-0.5 truncate text-[12.5px] text-[var(--text-dim)]">
            {req?.name} · {conn?.name} · every row of the result
          </div>
        </div>
        <IconButton label="Close" onClick={close} disabled={running}>
          <X size={14} />
        </IconButton>
      </div>
      <div className="flex flex-col gap-4 px-6 py-3">
        <div className="grid grid-cols-4 gap-2">
          {FORMATS.map((f) => (
            <button
              key={f.id}
              type="button"
              disabled={running}
              onClick={() => setFormat(f.id)}
              className={cx(
                "flex flex-col items-start rounded-xl border px-3 py-2 text-left transition-colors",
                format === f.id ? "border-[var(--accent)] bg-[var(--accent)]/10" : "border-[var(--border-soft)] bg-[var(--bg-input)] hover:border-[var(--border)]",
              )}
            >
              <span className="text-[12.5px] font-medium text-[var(--text-main)]">{f.label}</span>
              <span className="text-[11px] text-[var(--text-dim)]">{f.hint}</span>
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-3 rounded-2xl border border-[var(--border-soft)] bg-[var(--bg-app)] px-4 py-3">
          {format === "csv" && (
            <SettingRow title="Delimiter">
              <div className="w-[200px]">
                <Combobox searchable={false} value={o.delimiter} onChange={(v) => setO({ ...o, delimiter: v })} options={DELIMITERS} />
              </div>
            </SettingRow>
          )}
          {(format === "csv" || format === "tsv") && (
            <>
              <SettingRow title="Header row" hint="Column names on the first line">
                <Switch on={o.header} onChange={(v) => setO({ ...o, header: v })} ariaLabel="Header row" />
              </SettingRow>
              <SettingRow title="Quote every value">
                <Switch on={o.quoteAll} onChange={(v) => setO({ ...o, quoteAll: v })} ariaLabel="Quote every value" />
              </SettingRow>
              <SettingRow title="UTF-8 BOM" hint="Lets Excel detect the encoding">
                <Switch on={o.bom} onChange={(v) => setO({ ...o, bom: v })} ariaLabel="BOM" />
              </SettingRow>
            </>
          )}
          {(format === "csv" || format === "tsv" || format === "markdown") && (
            <SettingRow title="NULL as" hint="Text written for NULL values">
              <Input className="w-[140px]" mono value={o.nullText} placeholder="(empty)" onChange={(e) => setO({ ...o, nullText: e.target.value })} />
            </SettingRow>
          )}
          {format === "sql" && (
            <>
              <SettingRow title="Table name" hint="Target of the INSERT statements">
                <Input className="w-[220px]" mono value={o.tableName} onChange={(e) => setO({ ...o, tableName: e.target.value })} />
              </SettingRow>
              <SettingRow title="Rows per INSERT">
                <Input className="w-[100px]" mono value={String(o.batchSize)} onChange={(e) => setO({ ...o, batchSize: Math.max(1, Number(e.target.value.replace(/\D/g, "")) || 1) })} />
              </SettingRow>
            </>
          )}
          {(format === "json" || format === "xml" || format === "html") && <div className="text-[12px] text-[var(--text-dim)]">No options for this format.</div>}
          <Sep />
          <Field label="File">
            <div className="flex gap-2">
              <Input mono readOnly value={path} placeholder={`Browse… to choose where the .${ext} file goes`} />
              <Button icon={<FolderOpen size={13} />} onClick={() => void browse()} disabled={running}>
                Browse
              </Button>
            </div>
          </Field>
        </div>

        <details className="rounded-xl bg-[var(--bg-input)] px-3 py-2 text-[12px] text-[var(--text-muted)]">
          <summary className="cursor-pointer select-none">Query</summary>
          <pre className="selectable mt-2 max-h-[140px] overflow-auto whitespace-pre-wrap font-mono text-[11.5px] text-[var(--text-main)]">{req?.sql}</pre>
        </details>

        {state.kind === "done" && (
          <Alert tone="success" icon={<CheckCircle2 size={14} className="text-[var(--diff-add)]" />}>
            Exported {state.rows.toLocaleString()} rows to <span className="font-mono">{path}</span>
          </Alert>
        )}
        {state.kind === "error" && <Alert>{state.message}</Alert>}
      </div>
      <div className="flex items-center gap-2 border-t border-[var(--border-soft)] px-6 py-4">
        {running && (
          <span className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
            <Spinner size={13} className="text-[var(--accent)]" /> {state.rows.toLocaleString()} rows written…
          </span>
        )}
        <div className="flex-1" />
        {state.kind === "done" && isTauri() && (
          <Button variant="ghost" onClick={() => void api.revealPath(path)}>
            Show in folder
          </Button>
        )}
        {running ? (
          <Button variant="danger" onClick={() => void api.exportCancel(state.id)}>
            Cancel
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Close
            </Button>
            <Button variant="primary" data-testid="run-export" onClick={() => void run()}>
              Export
            </Button>
          </>
        )}
      </div>
    </Dialog>
  );
}
