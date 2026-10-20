import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { useConnections } from "@/store/connections";
import { useUi } from "@/store/ui";
import { Popover, Spinner, cx } from "@/components";
import { DatabaseIcon, DriverBadge, SchemaIcon } from "@/components/navigator/icons";

export interface PickItem {
  value: string;
  label: string;
  icon?: React.ReactNode;
  hint?: string;
  dim?: boolean;
}

/** A toolbar chip that opens a searchable list. */
export function PickChip({
  label,
  icon,
  title,
  items,
  value,
  onPick,
  load,
  disabled,
  empty = "Nothing here",
  testId,
}: {
  label: React.ReactNode;
  icon?: React.ReactNode;
  title: string;
  items?: PickItem[];
  value: string | null;
  onPick(v: string): void;
  /** Loads the items when the list opens. */
  load?(): Promise<PickItem[]>;
  disabled?: boolean;
  empty?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [loaded, setLoaded] = useState<PickItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const anchor = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setError(null);
    if (load) {
      setLoading(true);
      load()
        .then(setLoaded, (e) => setError(errorMessage(e)))
        .finally(() => setLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const all = items ?? loaded ?? [];
  const list = useMemo(() => all.filter((i) => i.label.toLowerCase().includes(q.trim().toLowerCase())), [all, q]);
  useEffect(() => setCursor(Math.max(0, list.findIndex((i) => i.value === value))), [list, value]);

  const pick = (v: string) => {
    setOpen(false);
    onPick(v);
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        title={title}
        data-testid={testId}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          "flex h-7 min-w-0 max-w-[220px] items-center gap-1.5 rounded-lg px-2 text-[12px] transition-colors disabled:opacity-40",
          open ? "bg-[var(--hover-bg)] text-[var(--text-main)]" : "text-[var(--text-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]",
        )}
      >
        {icon}
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown size={12} className="shrink-0 text-[var(--text-dim)]" />
      </button>
      <Popover open={open} anchor={anchor} onClose={() => setOpen(false)} label={title} className="w-[280px]">
        <div className="mb-1 flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--bg-input)] px-2.5">
          <Search size={12} className="shrink-0 text-[var(--text-dim)]" />
          <input
            autoFocus
            aria-label="Filter"
            className="h-full w-full bg-transparent text-[12px] text-[var(--text-main)] outline-none placeholder:text-[var(--text-dim)]"
            placeholder="Filter…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, list.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === "Enter" && list[cursor]) pick(list[cursor].value);
            }}
          />
        </div>
        <div className="thin-scroll flex max-h-[320px] flex-col gap-0.5 overflow-y-auto">
          {loading ? (
            <div className="flex items-center gap-2 px-2.5 py-2 text-[12px] text-[var(--text-dim)]">
              <Spinner size={12} /> Loading…
            </div>
          ) : error ? (
            <div className="px-2.5 py-2 text-[12px] text-[var(--diff-del)]">{error}</div>
          ) : list.length === 0 ? (
            <div className="px-2.5 py-2 text-[12px] text-[var(--text-dim)]">{empty}</div>
          ) : (
            list.map((it, i) => (
              <button
                key={it.value}
                type="button"
                className={cx(
                  "flex min-h-8 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors",
                  i === cursor ? "bg-[var(--hover-bg)]" : "",
                  it.dim ? "text-[var(--text-dim)]" : "text-[var(--text-main)]",
                )}
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(it.value)}
              >
                {it.icon}
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
                {it.hint && <span className="shrink-0 text-[11px] text-[var(--text-dim)]">{it.hint}</span>}
                {it.value === value && <Check size={12} className="shrink-0 text-[var(--accent)]" />}
              </button>
            ))
          )}
        </div>
      </Popover>
    </>
  );
}

export function ConnectionPicker({ value, onPick }: { value: string | null; onPick(id: string): void }) {
  const connections = useConnections((s) => s.connections);
  const status = useConnections((s) => s.status);
  const conn = connections.find((c) => c.id === value);
  return (
    <PickChip
      testId="pick-connection"
      title="Active connection"
      value={value}
      onPick={onPick}
      empty="No connections — create one in the navigator"
      icon={conn ? <DriverBadge driver={conn.driver} size={14} /> : undefined}
      label={
        conn ? (
          <span className="flex items-center gap-1.5">
            {conn.color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: conn.color }} />}
            {conn.name}
          </span>
        ) : (
          <span className="text-amber-500">Choose connection</span>
        )
      }
      items={connections.map((c) => ({
        value: c.id,
        label: c.name,
        icon: <DriverBadge driver={c.driver} size={14} />,
        hint: status[c.id] === "connected" ? "connected" : c.folder || undefined,
      }))}
    />
  );
}

export function DatabasePicker({ connectionId, value, onPick }: { connectionId: string; value: string | null; onPick(db: string): void }) {
  const showSystem = useUi((s) => s.prefs.showSystemObjects);
  return (
    <PickChip
      testId="pick-database"
      title="Active database"
      value={value}
      onPick={onPick}
      icon={<DatabaseIcon size={13} />}
      label={value ?? "database"}
      load={async () => {
        if (!(await useConnections.getState().ensureConnected(connectionId))) return [];
        const list = await api.listDatabases(connectionId);
        return list.filter((d) => showSystem || !d.system || d.name === value).map((d) => ({ value: d.name, label: d.name, icon: <DatabaseIcon size={13} dim={d.system} />, dim: d.system }));
      }}
    />
  );
}

export function SchemaPicker({ connectionId, database, value, onPick }: { connectionId: string; database: string; value: string | null; onPick(s: string): void }) {
  const showSystem = useUi((s) => s.prefs.showSystemObjects);
  return (
    <PickChip
      testId="pick-schema"
      title="Active schema"
      value={value}
      onPick={onPick}
      icon={<SchemaIcon size={13} />}
      label={value ?? "schema"}
      load={async () => {
        if (!(await useConnections.getState().ensureConnected(connectionId))) return [];
        const list = await api.listSchemas(connectionId, database);
        return list.filter((s) => showSystem || !s.system || s.name === value).map((s) => ({ value: s.name, label: s.name, icon: <SchemaIcon size={13} dim={s.system} />, dim: s.system }));
      }}
    />
  );
}
