import { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Info, Pin, PinOff, ScrollText, Square, Trash2, X } from "lucide-react";
import { duration, clock, oneLine } from "@/lib/format";
import { useEditors, type ResultSet, type Scope } from "@/store/editors";
import { Button, IconButton, OverlayScroll, Spinner, cx } from "@/components";
import { ResultView } from "@/components/grid/ResultView";

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(t);
  }, []);
  return <span className="font-mono tabular-nums">{duration(Date.now() - since)}</span>;
}

function ErrorView({ result }: { result: ResultSet }) {
  return (
    <div className="thin-scroll selectable flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
      <div className="flex items-start gap-2.5 rounded-xl border border-[var(--diff-del)]/40 bg-[var(--diff-del)]/10 px-3.5 py-3 text-[12.5px] text-[var(--diff-del)]">
        <AlertCircle size={15} className="mt-px shrink-0" />
        <div className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed">{result.error}</div>
      </div>
      <pre className="whitespace-pre-wrap rounded-xl bg-[var(--bg-input)] p-3 font-mono text-[11.5px] text-[var(--text-muted)]">{result.sql}</pre>
    </div>
  );
}

const NO_LOG: never[] = [];

function LogView({ ownerId }: { ownerId: string }) {
  const log = useEditors((s) => s.editors[ownerId]?.log ?? NO_LOG);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [log.length]);
  if (!log.length) return <div className="p-4 text-[12px] text-[var(--text-dim)]">Nothing executed yet.</div>;
  return (
    <div className="thin-scroll selectable min-h-0 flex-1 overflow-auto font-mono text-[11.5px]">
      <table className="w-full border-collapse">
        <tbody>
          {log.map((e) => (
            <tr key={e.id} className="border-b border-[var(--border-soft)] align-top hover:bg-[var(--hover-bg)]">
              <td className="w-[1%] whitespace-nowrap px-3 py-1.5 text-[var(--text-dim)]">{clock(e.at)}</td>
              <td className="w-[1%] px-1 py-1.5">
                {e.kind === "ok" ? (
                  <CheckCircle2 size={12} className="text-[var(--diff-add)]" />
                ) : e.kind === "error" ? (
                  <AlertCircle size={12} className="text-[var(--diff-del)]" />
                ) : (
                  <Info size={12} className="text-[var(--accent)]" />
                )}
              </td>
              <td className="max-w-0 px-2 py-1.5">
                <div className="truncate text-[var(--text-main)]" title={e.sql}>
                  {oneLine(e.sql, 300)}
                </div>
                <div className={cx("whitespace-pre-wrap break-words font-sans text-[12px]", e.kind === "error" ? "text-[var(--diff-del)]" : "text-[var(--text-muted)]")}>{e.message}</div>
              </td>
              <td className="w-[1%] whitespace-nowrap px-3 py-1.5 text-right text-[var(--text-dim)]">{e.elapsedMs !== null ? duration(e.elapsedMs) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div ref={end} />
    </div>
  );
}

/** Result tabs of an editor + the execution log. */
export function ResultsPanel({ ownerId, scope, onCancel }: { ownerId: string; scope: Scope | null; onCancel(): void }) {
  const rt = useEditors((s) => s.editors[ownerId]);
  const { patch, closeResult, togglePin, fetchMore, clearResults, run } = useEditors.getState();
  const results = rt?.results ?? [];
  const active = rt?.active ?? (results.at(-1)?.id ?? "log");
  const current = results.find((r) => r.id === active);
  const running = rt?.running;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--bg-app)]">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--border-soft)] bg-[var(--bg-sidebar)] pl-1.5 pr-2">
        <OverlayScroll wheelX wrapperClassName="min-w-0 flex-1" className="flex items-center gap-0.5 overflow-x-auto">
          {results.map((r) => (
            <div
              key={r.id}
              role="tab"
              aria-selected={active === r.id}
              data-testid="result-tab"
              onClick={() => patch(ownerId, { active: r.id })}
              onAuxClick={(e) => e.button === 1 && closeResult(ownerId, r.id)}
              className={cx(
                "group flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg pl-2.5 pr-1 text-[12px] transition-colors",
                active === r.id ? "bg-[var(--hover-bg)] text-[var(--text-main)]" : "text-[var(--text-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]",
              )}
              title={oneLine(r.sql, 300)}
            >
              {r.error ? <AlertCircle size={12} className="text-[var(--diff-del)]" /> : r.pinned ? <Pin size={11} className="text-[var(--accent)]" /> : null}
              <span>{r.title}</span>
              {!r.error && <span className="text-[10.5px] text-[var(--text-dim)]">{r.rows.length}{r.hasMore ? "+" : ""}</span>}
              <button
                type="button"
                title={r.pinned ? "Unpin" : "Pin (kept on the next run)"}
                className="rounded p-0.5 text-[var(--text-dim)] opacity-0 hover:text-[var(--text-main)] group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  togglePin(ownerId, r.id);
                }}
              >
                {r.pinned ? <PinOff size={11} /> : <Pin size={11} />}
              </button>
              <button
                type="button"
                title="Close"
                className="rounded p-0.5 text-[var(--text-dim)] opacity-0 hover:text-[var(--text-main)] group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  closeResult(ownerId, r.id);
                }}
              >
                <X size={11} />
              </button>
            </div>
          ))}
          <div
            role="tab"
            aria-selected={active === "log"}
            data-testid="log-tab"
            onClick={() => patch(ownerId, { active: "log" })}
            className={cx(
              "flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[12px] transition-colors",
              active === "log" ? "bg-[var(--hover-bg)] text-[var(--text-main)]" : "text-[var(--text-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]",
            )}
          >
            <ScrollText size={12} />
            Output
          </div>
        </OverlayScroll>
        {running ? (
          <div className="flex shrink-0 items-center gap-2 pl-2 text-[12px] text-[var(--text-muted)]">
            <Spinner size={12} className="text-[var(--accent)]" />
            <span>
              {running.total > 1 ? `Statement ${running.index + 1} of ${running.total} · ` : "Executing · "}
              <Elapsed since={running.startedAt} />
            </span>
            <Button size="xs" variant="danger-ghost" icon={<Square size={10} fill="currentColor" />} onClick={onCancel} data-testid="cancel-query">
              Cancel
            </Button>
          </div>
        ) : (
          results.length > 0 && (
            <IconButton size="xs" label="Close all results" onClick={() => clearResults(ownerId)}>
              <Trash2 size={12} />
            </IconButton>
          )
        )}
      </div>

      {active === "log" || !current ? (
        <LogView ownerId={ownerId} />
      ) : current.error ? (
        <ErrorView result={current} />
      ) : scope ? (
        <ResultView
          key={current.id}
          ownerId={ownerId}
          scope={scope}
          result={current}
          source={current.plan ? null : current.source}
          onReload={() => run(ownerId, scope, [current.sql], { limit: current.limit, replace: current.id })}
          onFetchMore={(all) => void fetchMore(ownerId, scope, current.id, all)}
          name={current.source?.name}
          loading={!!running}
        />
      ) : null}
    </div>
  );
}
