import { useEffect, useState } from "react";
import { Code, Copy, Download, Network, RefreshCw, SquarePen, Table2, TableProperties, Upload } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { copyText } from "@/lib/copy";
import { selectData } from "@/lib/sql/dialect";
import type { TableInfo } from "@/lib/types";
import { invalidateTable, isRelation, tableInfo, useConnections } from "@/store/connections";
import { useDialogs } from "@/store/dialogs";
import { useUi } from "@/store/ui";
import { useWorkspace, type ObjectTab, type TableTab, type TableView } from "@/store/workspace";
import { Alert, Button, IconButton, Segmented, Spinner } from "@/components";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { ObjectIcon } from "@/components/navigator/icons";
import { ErDiagram } from "@/components/erd/ErDiagram";
import { DataView } from "./DataView";
import { PropertiesView } from "./PropertiesView";

function Breadcrumb({ connectionId, database, schema }: { connectionId: string; database: string; schema: string | null }) {
  const conn = useConnections((s) => s.connections.find((c) => c.id === connectionId));
  return (
    <span className="truncate text-[12px] text-[var(--text-dim)]">
      {[conn?.name, conn?.driver === "sqlite" && database === "main" ? null : database, schema].filter(Boolean).join(" / ")}
    </span>
  );
}

/** Read-only source of an object, with "open in SQL editor". */
function SourceView({ connectionId, database, schema, name, kind, signature }: { connectionId: string; database: string; schema: string | null; name: string; kind: string; signature: string | null }) {
  const conn = useConnections((s) => s.connections.find((c) => c.id === connectionId));
  const prefs = useUi((s) => s.prefs);
  const [ddl, setDdl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);

  useEffect(() => {
    let alive = true;
    setDdl(null);
    setError(null);
    (async () => {
      if (!(await useConnections.getState().ensureConnected(connectionId))) throw new Error("Not connected");
      return api.objectDdl(connectionId, database, schema, name, kind, signature);
    })().then(
      (d) => alive && setDdl(d),
      (e) => alive && setError(errorMessage(e)),
    );
    return () => {
      alive = false;
    };
  }, [connectionId, database, schema, name, kind, signature, n]);

  if (error)
    return (
      <div className="p-5">
        <Alert>{error}</Alert>
      </div>
    );
  if (ddl === null)
    return (
      <div className="flex flex-1 items-center justify-center text-[var(--text-dim)]">
        <Spinner size={18} />
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--border-soft)] px-3">
        <span className="flex-1 text-[11.5px] text-[var(--text-dim)]">Generated from the server's catalog</span>
        <Button size="xs" variant="ghost" icon={<Copy size={12} />} onClick={() => void copyText(ddl)}>
          Copy
        </Button>
        <Button
          size="xs"
          variant="ghost"
          icon={<SquarePen size={12} />}
          onClick={() => useWorkspace.getState().newSql({ connectionId, database, schema, sql: ddl, title: `${name} (DDL)` })}
        >
          Open in SQL editor
        </Button>
        <IconButton size="xs" label="Refresh" onClick={() => setN((x) => x + 1)}>
          <RefreshCw size={12} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1">
        <CodeEditor value={ddl} readOnly driver={conn?.driver ?? "postgres"} fontSize={prefs.editorFontSize} tabSize={prefs.tabSize} wordWrap={prefs.wordWrap} />
      </div>
    </div>
  );
}

export function TableEditor({ tab }: { tab: TableTab }) {
  const conn = useConnections((s) => s.connections.find((c) => c.id === tab.connectionId));
  const [info, setInfo] = useState<TableInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const scope = { connectionId: tab.connectionId, database: tab.database, schema: tab.schema };

  useEffect(() => {
    let alive = true;
    setError(null);
    (async () => {
      if (!(await useConnections.getState().ensureConnected(tab.connectionId))) throw new Error("Not connected");
      return tableInfo(tab.connectionId, tab.database, tab.schema, tab.name, n > 0);
    })().then(
      (i) => alive && setInfo(i),
      (e) => alive && setError(errorMessage(e)),
    );
    return () => {
      alive = false;
    };
  }, [tab.connectionId, tab.database, tab.schema, tab.name, n]);

  const setView = (view: TableView) => useWorkspace.getState().update(tab.id, { view });
  const isTable = tab.objectKind === "table";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-[var(--border-soft)] px-4">
        <ObjectIcon kind={tab.objectKind} size={16} />
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[13.5px] font-semibold text-[var(--text-main)]">{tab.name}</span>
          <Breadcrumb connectionId={tab.connectionId} database={tab.database} schema={tab.schema} />
        </div>
        <div className="flex-1" />
        <Segmented<TableView>
          size="sm"
          value={tab.view}
          onChange={setView}
          options={[
            { value: "data", label: (<span className="flex items-center gap-1.5"><Table2 size={12} />Data</span>) },
            { value: "properties", label: (<span className="flex items-center gap-1.5"><TableProperties size={12} />Properties</span>) },
            { value: "ddl", label: (<span className="flex items-center gap-1.5"><Code size={12} />DDL</span>) },
            { value: "erd", label: (<span className="flex items-center gap-1.5"><Network size={12} />Diagram</span>) },
          ]}
        />
        <div className="mx-1 h-4 w-px bg-[var(--border)]" />
        <IconButton
          label="Export data…"
          onClick={() => conn && useDialogs.getState().openExport({ connectionId: conn.id, database: tab.database, sql: selectData(conn.driver, { database: tab.database, schema: tab.schema, name: tab.name }, "", []), name: tab.name })}
        >
          <Download size={14} />
        </IconButton>
        {isTable && !conn?.readOnly && (
          <IconButton label="Import data…" onClick={() => useDialogs.getState().openImport({ connectionId: tab.connectionId, database: tab.database, schema: tab.schema, table: tab.name })}>
            <Upload size={14} />
          </IconButton>
        )}
        <IconButton
          label="Refresh structure"
          onClick={() => {
            invalidateTable(tab.connectionId, tab.database, tab.schema, tab.name);
            setN((x) => x + 1);
          }}
        >
          <RefreshCw size={13} />
        </IconButton>
      </div>

      {error && tab.view !== "data" ? (
        <div className="p-5">
          <Alert>{error}</Alert>
        </div>
      ) : tab.view === "data" ? (
        <DataView key={`${tab.id}-${n}`} tabId={tab.id} scope={scope} name={tab.name} editable={isTable && isRelation(tab.objectKind)} />
      ) : tab.view === "properties" ? (
        info ? (
          <PropertiesView info={info} connectionId={tab.connectionId} database={tab.database} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-[var(--text-dim)]">
            <Spinner size={18} />
          </div>
        )
      ) : tab.view === "ddl" ? (
        <SourceView connectionId={tab.connectionId} database={tab.database} schema={tab.schema} name={tab.name} kind={tab.objectKind} signature={null} />
      ) : (
        <ErDiagram connectionId={tab.connectionId} database={tab.database} schema={tab.schema} focusTable={tab.name} />
      )}
    </div>
  );
}

export function ObjectEditor({ tab }: { tab: ObjectTab }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-[var(--border-soft)] px-4">
        <ObjectIcon kind={tab.objectKind} size={16} />
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[13.5px] font-semibold text-[var(--text-main)]">
            {tab.name}
            {tab.signature !== null && <span className="font-normal text-[var(--text-dim)]">({tab.signature})</span>}
          </span>
          <Breadcrumb connectionId={tab.connectionId} database={tab.database} schema={tab.schema} />
        </div>
      </div>
      <SourceView connectionId={tab.connectionId} database={tab.database} schema={tab.schema} name={tab.name} kind={tab.objectKind} signature={tab.signature} />
    </div>
  );
}
