import { useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Copy, Search, SquareTerminal, Trash2 } from "lucide-react";
import { copyText } from "@/lib/copy";
import { clock, duration } from "@/lib/format";
import { useConnections } from "@/store/connections";
import { useHistory, type HistoryEntry } from "@/store/history";
import { useUi } from "@/store/ui";
import { useWorkspace } from "@/store/workspace";
import { editorActions } from "@/app/actions";
import { Button, IconButton, Segmented, cx } from "@/components";
import { DriverBadge } from "@/components/navigator/icons";
import { PickChip } from "@/components/editor/Pickers";

/** Every statement run in Helix: search, re-open, copy. */
export function HistoryView() {
  const entries = useHistory((s) => s.entries);
  const connections = useConnections((s) => s.connections);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "ok" | "error">("all");
  const [conn, setConn] = useState<string>("");
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return entries.filter(
      (e) =>
        (filter === "all" || (filter === "ok" ? !e.error : !!e.error)) &&
        (!conn || e.connectionId === conn) &&
        (!t || e.sql.toLowerCase().includes(t) || e.connectionName.toLowerCase().includes(t)),
    );
  }, [entries, q, filter, conn]);

  const open = (e: HistoryEntry, inNew: boolean) => {
    const ws = useWorkspace.getState();
    const tabs = ws.tabs.filter((t) => t.kind === "sql" && t.connectionId === e.connectionId);
    const target = !inNew ? tabs.find((t) => t.id === ws.activeId) ?? tabs.at(-1) : undefined;
    if (target) {
      ws.activate(target.id);
      requestAnimationFrame(() => editorActions(target.id)?.insert(e.sql));
    } else {
      ws.newSql({ connectionId: e.connectionId, database: e.database, sql: e.sql });
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-3 overflow-hidden border-b border-[var(--border-soft)] px-4">
        <span className="shrink-0 text-[13.5px] font-semibold text-[var(--text-main)]">Query history</span>
        <span className="shrink-0 text-[12px] text-[var(--text-dim)]">{entries.length.toLocaleString()} statements</span>
        <div className="flex-1" />
        <PickChip
          title="Connection"
          value={conn}
          onPick={setConn}
          label={connections.find((c) => c.id === conn)?.name ?? "All connections"}
          items={[{ value: "", label: "All connections" }, ...connections.map((c) => ({ value: c.id, label: c.name, icon: <DriverBadge driver={c.driver} size={13} /> }))]}
        />
        <Segmented
          size="xs"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "ok", label: "Succeeded" },
            { value: "error", label: "Failed" },
          ]}
        />
        <div className="flex h-7 w-[240px] min-w-[120px] shrink items-center gap-1.5 rounded-lg bg-[var(--bg-input)] px-2.5">
          <Search size={12} className="text-[var(--text-dim)]" />
          <input
            autoFocus
            className="h-full min-w-0 flex-1 bg-transparent text-[12px] text-[var(--text-main)] outline-none placeholder:text-[var(--text-dim)]"
            placeholder="Search SQL"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Button
          size="sm"
          variant="danger-ghost"
          icon={<Trash2 size={12} />}
          disabled={!entries.length}
          onClick={async () => {
            const ans = await useUi.getState().ask({
              title: "Clear the query history?",
              buttons: [
                { id: "clear", label: "Clear", variant: "danger" },
                { id: "cancel", label: "Cancel" },
              ],
              cancelId: "cancel",
            });
            if (ans === "clear") useHistory.getState().clear();
          }}
        >
          Clear
        </Button>
      </div>
      <div className="thin-scroll min-h-0 flex-1 overflow-auto">
        {list.map((e) => {
          const c = connections.find((x) => x.id === e.connectionId);
          return (
            <div
              key={e.id}
              className="group flex cursor-default items-start gap-3 border-b border-[var(--border-soft)] px-4 py-2 hover:bg-[var(--hover-bg)]"
              onDoubleClick={() => open(e, false)}
            >
              {e.error ? <AlertCircle size={13} className="mt-0.5 shrink-0 text-[var(--diff-del)]" /> : <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-[var(--diff-add)]" />}
              <div className="min-w-0 flex-1">
                <pre className="selectable line-clamp-4 whitespace-pre-wrap break-words font-mono text-[12px] text-[var(--text-main)]">{e.sql}</pre>
                <div className="mt-1 flex items-center gap-2 text-[11.5px] text-[var(--text-dim)]">
                  {c && <DriverBadge driver={c.driver} size={12} />}
                  <span>{e.connectionName}</span>
                  {e.database && <span>· {e.database}</span>}
                  <span>· {clock(e.at)}</span>
                  <span>· {duration(e.elapsedMs)}</span>
                  {e.rows !== null && <span>· {e.rows.toLocaleString()} rows</span>}
                  {e.error && <span className={cx("truncate text-[var(--diff-del)]")}>· {e.error}</span>}
                </div>
              </div>
              <div className="flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100">
                <IconButton size="xs" label="Open in SQL editor" onClick={() => open(e, true)}>
                  <SquareTerminal size={12.5} />
                </IconButton>
                <IconButton size="xs" label="Copy SQL" onClick={() => void copyText(e.sql)}>
                  <Copy size={12} />
                </IconButton>
                <IconButton size="xs" label="Remove" tone="danger" onClick={() => useHistory.getState().remove(e.id)}>
                  <Trash2 size={12} />
                </IconButton>
              </div>
            </div>
          );
        })}
        {!list.length && <div className="p-10 text-center text-[12.5px] text-[var(--text-dim)]">{entries.length ? "Nothing matches." : "Statements you run appear here."}</div>}
      </div>
    </div>
  );
}
