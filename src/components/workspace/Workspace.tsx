import { useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Activity, FileCode, FolderOpen, History, Network, Plus, SquareTerminal, X } from "lucide-react";
import { useConnections } from "@/store/connections";
import { useEditors } from "@/store/editors";
import { isDirty, useWorkspace, type Tab } from "@/store/workspace";
import { useUi } from "@/store/ui";
import { openSqlFile } from "@/app/files";
import { newEditorFor } from "@/components/navigator/actions";
import { currentConnectionId } from "@/app/commands";
import { shortcutLabel } from "@/lib/platform";
import { Button, ContextMenu, Kbd, OverlayScroll, cx, type ContextMenuItem } from "@/components";
import { ObjectIcon } from "@/components/navigator/icons";
import { SqlEditor } from "@/components/editor/SqlEditor";
import { ObjectEditor, TableEditor } from "@/components/table/TableEditor";
import { ErDiagram } from "@/components/erd/ErDiagram";
import { SessionsView } from "@/components/panels/SessionsView";
import { HistoryView } from "@/components/panels/HistoryView";

function TabIcon({ tab }: { tab: Tab }) {
  switch (tab.kind) {
    case "sql":
      return <SquareTerminal size={13} strokeWidth={1.7} className="shrink-0 text-[var(--text-muted)]" />;
    case "table":
    case "object":
      return <ObjectIcon kind={tab.objectKind} size={13} />;
    case "erd":
      return <Network size={13} strokeWidth={1.7} className="shrink-0 text-[var(--text-muted)]" />;
    case "sessions":
      return <Activity size={13} strokeWidth={1.7} className="shrink-0 text-[var(--text-muted)]" />;
    case "history":
      return <History size={13} strokeWidth={1.7} className="shrink-0 text-[var(--text-muted)]" />;
  }
}

function TabButton({ tab, index, active }: { tab: Tab; index: number; active: boolean }) {
  const color = useConnections((s) => ("connectionId" in tab && tab.connectionId ? s.connections.find((c) => c.id === tab.connectionId)?.color : null));
  const prod = useConnections((s) => ("connectionId" in tab && tab.connectionId ? s.connections.find((c) => c.id === tab.connectionId)?.environment === "production" : false));
  const running = useEditors((s) => !!s.editors[tab.id]?.running);
  const pending = useEditors((s) => !!s.editors[tab.id]?.session?.inTransaction);
  const { activate, close, closeOthers, closeAll, move } = useWorkspace.getState();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const dirty = isDirty(tab);

  const items: ContextMenuItem[] = [
    { label: "Close", hint: shortcutLabel("Ctrl+W"), onClick: () => close(tab.id) },
    { label: "Close Others", onClick: () => closeOthers(tab.id) },
    { label: "Close All", onClick: () => closeAll() },
    ...(tab.kind === "sql"
      ? ([
          "separator",
          {
            label: "Rename…",
            onClick: async () => {
              const t = await useUi.getState().prompt({ title: "Rename editor", label: "Title", value: tab.title, okLabel: "Rename" });
              if (t?.trim()) useWorkspace.getState().update(tab.id, { title: t.trim() });
            },
          },
          { label: "Duplicate", onClick: () => useWorkspace.getState().newSql({ ...tab, id: undefined, title: `${tab.title} (copy)`, filePath: null, savedSql: null }) },
        ] as ContextMenuItem[])
      : []),
  ];

  return (
    <>
      <div
        role="tab"
        aria-selected={active}
        data-testid="workspace-tab"
        draggable
        onDragStart={(e) => e.dataTransfer.setData("application/x-helix-tab", String(index))}
        onDragOver={(e) => e.dataTransfer.types.includes("application/x-helix-tab") && e.preventDefault()}
        onDrop={(e) => {
          const from = Number(e.dataTransfer.getData("application/x-helix-tab"));
          if (!Number.isNaN(from) && from !== index) move(from, index);
        }}
        onMouseDown={(e) => e.button === 0 && activate(tab.id)}
        onAuxClick={(e) => e.button === 1 && close(tab.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        title={tab.kind === "sql" && tab.filePath ? tab.filePath : tab.title}
        className={cx(
          "group relative flex h-[30px] max-w-[220px] shrink-0 cursor-default select-none items-center gap-1.5 rounded-[10px] pl-2.5 pr-1 text-[12.5px] transition-colors",
          active ? "bg-[var(--bg-elevated)] text-[var(--text-main)] shadow-[0_0_0_1px_var(--border)]" : "bg-[var(--bg-surface)] text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-main)]",
        )}
      >
        {color && <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-full" style={{ background: color }} />}
        <TabIcon tab={tab} />
        <span className="min-w-0 truncate">{tab.title}</span>
        {prod && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--diff-del)]" title="Production connection" />}
        {running && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--accent)]" title="Running" />}
        {pending && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" title="Uncommitted transaction" />}
        <button
          type="button"
          aria-label={`Close ${tab.title}`}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => close(tab.id)}
          className={cx("flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[var(--text-dim)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]", !active && !dirty && "opacity-0 group-hover:opacity-100")}
        >
          {dirty ? <span className="h-2 w-2 rounded-full bg-[var(--text-muted)] group-hover:hidden" /> : null}
          <X size={12} className={cx(dirty && "hidden group-hover:block")} />
        </button>
      </div>
      <ContextMenu at={menu} items={items} onClose={() => setMenu(null)} />
    </>
  );
}

function Welcome() {
  const hasConnections = useConnections((s) => s.connections.length > 0);
  const { openEditor } = useConnections.getState();
  const connections = useConnections((s) => s.connections);
  const recent = useMemo(() => [...connections].filter((c) => c.lastUsedAt).sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)).slice(0, 5), [connections]);
  const shortcuts: [string, string][] = [
    ["New SQL editor", "Ctrl+]"],
    ["Execute statement", "Ctrl+Enter"],
    ["Execute script", "Alt+X"],
    ["Explain plan", "Ctrl+Shift+E"],
    ["Format SQL", "Ctrl+Shift+F"],
    ["Query history", "Ctrl+H"],
  ];
  return (
    <motion.div
      className="mx-auto flex w-full max-w-[560px] flex-col items-center pt-[12vh]"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
    >
      <h1 className="text-[16px] font-semibold text-[var(--text-main)]">Helix</h1>
      <div className="mt-1 max-w-[400px] text-center text-[12.5px] leading-relaxed text-[var(--text-dim)]">
        A database client for PostgreSQL, MySQL, SQLite and SQL Server.
      </div>
      <div className="mt-5 flex gap-2">
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => openEditor()}>
          New connection
        </Button>
        <Button
          icon={<SquareTerminal size={14} />}
          onClick={() => {
            const id = currentConnectionId() ?? recent[0]?.id;
            if (id) newEditorFor({ key: `c:${id}`, type: "connection", label: "", connId: id });
            else useWorkspace.getState().newSql();
          }}
        >
          SQL editor
        </Button>
        <Button icon={<FolderOpen size={14} />} onClick={() => void openSqlFile()}>
          Open script
        </Button>
      </div>
      {hasConnections && recent.length > 0 && (
        <div className="mt-8 w-full">
          <div className="mb-2 px-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-dim)]">Recent connections</div>
          <div className="flex flex-col gap-0.5">
            {recent.map((c) => (
              <button
                key={c.id}
                type="button"
                className="flex h-9 items-center gap-2.5 rounded-xl px-3 text-left text-[13px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
                onClick={() => newEditorFor({ key: `c:${c.id}`, type: "connection", label: c.name, connId: c.id })}
              >
                <FileCode size={14} className="text-[var(--text-dim)]" />
                <span className="flex-1 truncate">{c.name}</span>
                <span className="text-[11.5px] text-[var(--text-dim)]">{c.driver === "sqlite" ? c.filePath : `${c.host}${c.database ? ` / ${c.database}` : ""}`}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="mt-8 grid w-full grid-cols-2 gap-x-6 gap-y-2 px-1">
        {shortcuts.map(([label, keys]) => (
          <div key={label} className="flex items-center justify-between text-[12px] text-[var(--text-dim)]">
            <span>{label}</span>
            <span className="flex gap-1">
              {shortcutLabel(keys)
                .split("+")
                .map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
            </span>
          </div>
        ))}
      </div>
    </motion.div>
  );
}

function TabContent({ tab }: { tab: Tab }) {
  switch (tab.kind) {
    case "sql":
      return <SqlEditor tab={tab} />;
    case "table":
      return <TableEditor tab={tab} />;
    case "object":
      return <ObjectEditor tab={tab} />;
    case "erd":
      return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ErDiagram connectionId={tab.connectionId} database={tab.database} schema={tab.schema} />
        </div>
      );
    case "sessions":
      return <SessionsView connectionId={tab.connectionId} />;
    case "history":
      return <HistoryView />;
  }
}

/** Editor tabs and the content of the active one (inactive SQL editors stay mounted). */
export function Workspace() {
  const tabs = useWorkspace((s) => s.tabs);
  const activeId = useWorkspace((s) => s.activeId);
  const stripRef = useRef<HTMLDivElement>(null);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {tabs.length > 0 && (
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--border-soft)] px-1.5">
          <OverlayScroll innerRef={stripRef} wheelX wrapperClassName="min-w-0 flex-1" className="flex items-center gap-1 overflow-x-auto py-1">
            {tabs.map((t, i) => (
              <TabButton key={t.id} tab={t} index={i} active={t.id === active?.id} />
            ))}
          </OverlayScroll>
          <button
            type="button"
            title="New SQL editor (Ctrl+])"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--text-dim)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
            onClick={() => {
              const id = currentConnectionId();
              if (id) newEditorFor({ key: `c:${id}`, type: "connection", label: "", connId: id });
              else useWorkspace.getState().newSql();
            }}
          >
            <Plus size={14} />
          </button>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
        {tabs.length === 0 ? (
          <Welcome />
        ) : (
          tabs.map((t) =>
            // SQL editors stay mounted (cursor, undo history); the rest only when shown.
            t.kind === "sql" || t.id === active?.id ? (
              <div key={t.id} className={cx("absolute inset-0 flex min-h-0 min-w-0", t.id !== active?.id && "invisible pointer-events-none")} aria-hidden={t.id !== active?.id}>
                <TabContent tab={t} />
              </div>
            ) : null,
          )
        )}
      </div>
    </div>
  );
}
