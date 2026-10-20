import { useCallback, useEffect, useMemo, useState } from "react";
import { Ban, RefreshCw, Search, Square } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import type { ServerSession } from "@/lib/types";
import { useConnections } from "@/store/connections";
import { toast, useUi } from "@/store/ui";
import { Alert, Button, IconButton, Spinner, Switch, cx } from "@/components";

/** Client sessions of the server, with cancel / terminate (DBeaver's Session Manager). */
export function SessionsView({ connectionId }: { connectionId: string }) {
  const conn = useConnections((s) => s.connections.find((c) => c.id === connectionId));
  const [sessions, setSessions] = useState<ServerSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [auto, setAuto] = useState(false);
  const [q, setQ] = useState("");
  const [hideIdle, setHideIdle] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (!(await useConnections.getState().ensureConnected(connectionId))) throw new Error("Not connected");
      setSessions(await api.serverSessions(connectionId));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [auto, load]);

  const list = useMemo(
    () =>
      (sessions ?? []).filter((s) => {
        if (hideIdle && /idle|sleep/i.test(s.state ?? "")) return false;
        const t = q.trim().toLowerCase();
        return !t || [s.id, s.user, s.database, s.client, s.application, s.state, s.query].some((v) => v?.toLowerCase().includes(t));
      }),
    [sessions, q, hideIdle],
  );
  const current = list.find((s) => s.id === selected) ?? null;

  const kill = async (s: ServerSession, cancelOnly: boolean) => {
    const ans = await useUi.getState().ask({
      title: cancelOnly ? `Cancel the query of session ${s.id}?` : `Terminate session ${s.id}?`,
      message: cancelOnly ? "The running statement is stopped; the session stays connected." : `${s.user ?? "The client"} is disconnected; its open transaction is rolled back.`,
      buttons: [
        { id: "ok", label: cancelOnly ? "Cancel query" : "Terminate", variant: "danger" },
        { id: "no", label: "Keep" },
      ],
      cancelId: "no",
    });
    if (ans !== "ok") return;
    try {
      await api.killServerSession(connectionId, s.id, cancelOnly);
      toast(cancelOnly ? "Query cancelled" : "Session terminated", "success");
      void load();
    } catch (e) {
      toast("Failed", "error", errorMessage(e));
    }
  };

  const th = "px-3 py-2 text-left text-[11.5px] font-medium text-[var(--text-dim)]";
  const td = "max-w-0 truncate px-3 py-1.5";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-3 overflow-hidden border-b border-[var(--border-soft)] px-4">
        <div className="flex flex-col leading-tight">
          <span className="text-[13.5px] font-semibold text-[var(--text-main)]">Server sessions</span>
          <span className="text-[12px] text-[var(--text-dim)]">{conn?.name}</span>
        </div>
        <div className="flex-1" />
        <div className="flex h-7 w-[220px] min-w-[120px] shrink items-center gap-1.5 rounded-lg bg-[var(--bg-input)] px-2.5">
          <Search size={12} className="text-[var(--text-dim)]" />
          <input className="h-full min-w-0 flex-1 bg-transparent text-[12px] text-[var(--text-main)] outline-none placeholder:text-[var(--text-dim)]" placeholder="Filter sessions" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
          Hide idle <Switch on={hideIdle} onChange={setHideIdle} ariaLabel="Hide idle sessions" />
        </label>
        <label className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
          Auto-refresh <Switch on={auto} onChange={setAuto} ariaLabel="Auto refresh" />
        </label>
        <IconButton label="Refresh" onClick={() => void load()}>
          {loading ? <Spinner size={13} /> : <RefreshCw size={13} />}
        </IconButton>
      </div>
      {error && (
        <div className="p-4">
          <Alert>{error}</Alert>
        </div>
      )}
      <div className="thin-scroll selectable min-h-0 flex-1 overflow-auto">
        <table className="w-full table-fixed border-collapse text-[12.5px]">
          <thead className="sticky top-0 bg-[var(--bg-sidebar)]">
            <tr className="border-b border-[var(--border-soft)]">
              <th className={cx(th, "w-[80px]")}>ID</th>
              <th className={cx(th, "w-[110px]")}>User</th>
              <th className={cx(th, "w-[120px]")}>Database</th>
              <th className={cx(th, "w-[130px]")}>Client</th>
              <th className={cx(th, "w-[120px]")}>Application</th>
              <th className={cx(th, "w-[90px]")}>State</th>
              <th className={cx(th, "w-[150px]")}>Query start</th>
              <th className={th}>Query</th>
              <th className={cx(th, "w-[76px]")} />
            </tr>
          </thead>
          <tbody>
            {list.map((s) => (
              <tr
                key={s.id}
                onClick={() => setSelected(s.id)}
                className={cx("group border-b border-[var(--border-soft)] text-[var(--text-main)]", selected === s.id ? "bg-[var(--hover-bg)]" : "hover:bg-[var(--hover-bg)]")}
              >
                <td className={cx(td, "font-mono")}>{s.id}</td>
                <td className={td}>{s.user}</td>
                <td className={td}>{s.database}</td>
                <td className={cx(td, "text-[var(--text-muted)]")}>{s.client}</td>
                <td className={cx(td, "text-[var(--text-muted)]")}>{s.application}</td>
                <td className={td}>
                  <span className={cx(/active|running|query/i.test(s.state ?? "") ? "text-[var(--diff-add)]" : "text-[var(--text-dim)]")}>{s.state}</span>
                </td>
                <td className={cx(td, "text-[var(--text-muted)]")}>{s.queryStart}</td>
                <td className={cx(td, "font-mono text-[11.5px] text-[var(--text-muted)]")} title={s.query ?? ""}>
                  {s.query?.replace(/\s+/g, " ")}
                </td>
                <td className="px-2 py-1">
                  <span className="flex gap-0.5 opacity-0 group-hover:opacity-100">
                    {conn?.driver !== "mssql" && (
                      <IconButton size="xs" label="Cancel query" onClick={() => void kill(s, true)}>
                        <Square size={11} />
                      </IconButton>
                    )}
                    <IconButton size="xs" label="Terminate session" tone="danger" onClick={() => void kill(s, false)}>
                      <Ban size={12} />
                    </IconButton>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sessions && !list.length && <div className="p-6 text-center text-[12px] text-[var(--text-dim)]">No sessions</div>}
      </div>
      {current?.query && (
        <div className="max-h-[30%] shrink-0 overflow-auto border-t border-[var(--border-soft)] bg-[var(--bg-sidebar)] p-3">
          <div className="mb-1 flex items-center gap-2 text-[11.5px] text-[var(--text-dim)]">
            Session {current.id} · {current.wait ? `waiting on ${current.wait}` : "not waiting"}
            <div className="flex-1" />
            <Button size="xs" variant="danger-ghost" onClick={() => void kill(current, false)}>
              Terminate
            </Button>
          </div>
          <pre className="selectable whitespace-pre-wrap font-mono text-[12px] text-[var(--text-main)]">{current.query}</pre>
        </div>
      )}
    </div>
  );
}
