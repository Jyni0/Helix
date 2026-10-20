import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { motion } from "motion/react";
import { AlertCircle, ChevronRight, ChevronsDownUp, Eye, EyeOff, History, LoaderCircle, Plug, Plus, RefreshCw, Search, Settings, SquareTerminal, Unplug, X } from "lucide-react";
import { blankConnection, useConnections, type Children, type TreeNode } from "@/store/connections";
import { useUi } from "@/store/ui";
import { useWorkspace } from "@/store/workspace";
import { currentConnectionId } from "@/app/commands";
import { ContextMenu, IconButton, NavItem, Pill, ScrollArea, cx, type ContextMenuItem } from "@/components";
import { ColumnIcon, DatabaseIcon, DriverBadge, FolderIcon, ObjectIcon, SchemaIcon } from "./icons";
import { newEditorFor, nodeMenu, openNode } from "./actions";

const MIN_W = 220;
const MAX_W = 560;
const ROW_H = 26;
const INDENT = 14;

type Row =
  | { kind: "folder"; key: string; label: string; depth: number; open: boolean }
  | { kind: "node"; key: string; node: TreeNode; depth: number; open: boolean; loading: boolean }
  | { kind: "status"; key: string; depth: number; text: string; error?: boolean };

function useSidebarResize() {
  const width = useUi((s) => s.prefs.sidebarWidth);
  const setPref = useUi((s) => s.setPref);
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => setPref("sidebarWidth", Math.min(Math.max(startW + ev.clientX - startX, MIN_W), MAX_W));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  return { width: Math.min(Math.max(width, MIN_W), MAX_W), startResize };
}

/** Flattens the expanded part of the tree into rows (filtered by name). */
function useRows(): Row[] {
  const connections = useConnections((s) => s.connections);
  const children = useConnections((s) => s.children);
  const expanded = useConnections((s) => s.expanded);
  const filter = useConnections((s) => s.filter).trim().toLowerCase();

  return useMemo(() => {
    const rows: Row[] = [];
    const matchMemo = new Map<string, boolean>();
    // A node is shown when it (or something loaded under it) matches the filter.
    const matches = (n: TreeNode): boolean => {
      if (!filter) return true;
      const hit = matchMemo.get(n.key);
      if (hit !== undefined) return hit;
      const self = n.label.toLowerCase().includes(filter);
      const ch: Children | undefined = children[n.key];
      const r = self || !!ch?.nodes.some(matches);
      matchMemo.set(n.key, r);
      return r;
    };
    const selfMatch = (n: TreeNode) => !filter || n.label.toLowerCase().includes(filter);

    const walk = (n: TreeNode, depth: number, ancestorMatched: boolean) => {
      if (!ancestorMatched && !matches(n)) return;
      const ch = children[n.key];
      const descendantsMatch = !!filter && !!ch?.nodes.some(matches);
      const open = !!expanded[n.key] || (descendantsMatch && !selfMatch(n));
      rows.push({ kind: "node", key: n.key, node: n, depth, open, loading: ch?.state === "loading" });
      if (!open) return;
      if (!ch || (ch.state === "loading" && !ch.nodes.length)) {
        rows.push({ kind: "status", key: n.key + "#loading", depth: depth + 1, text: "Loading…" });
        return;
      }
      if (ch.state === "error") {
        rows.push({ kind: "status", key: n.key + "#error", depth: depth + 1, text: ch.error ?? "Failed", error: true });
        return;
      }
      if (!ch.nodes.length) rows.push({ kind: "status", key: n.key + "#empty", depth: depth + 1, text: "Empty" });
      const passAll = ancestorMatched || selfMatch(n);
      for (const c of ch.nodes) walk(c, depth + 1, passAll && !!filter ? true : ancestorMatched);
    };

    const folders = new Map<string, typeof connections>();
    for (const c of connections) {
      const f = c.folder.trim();
      if (!folders.has(f)) folders.set(f, []);
      folders.get(f)!.push(c);
    }
    const ordered = [...folders.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
    for (const f of ordered) {
      const list = folders.get(f)!;
      let depth = 0;
      if (f) {
        const key = `f:${f}`;
        const nodes = list.map((c) => ({ key: `c:${c.id}`, type: "connection", label: c.name, connId: c.id }) as TreeNode);
        if (filter && !f.toLowerCase().includes(filter) && !nodes.some(matches)) continue;
        const open = expanded[key] !== false || (!!filter && nodes.some(matches));
        rows.push({ kind: "folder", key, label: f, depth: 0, open });
        if (!open) continue;
        depth = 1;
      }
      for (const c of list) walk({ key: `c:${c.id}`, type: "connection", label: c.name, connId: c.id }, depth, !!filter && f.toLowerCase().includes(filter));
    }
    return rows;
  }, [connections, children, expanded, filter]);
}

function NodeIcon({ node, open }: { node: TreeNode; open: boolean }) {
  const conn = useConnections((s) => s.connections.find((c) => c.id === node.connId));
  const status = useConnections((s) => s.status[node.connId]);
  switch (node.type) {
    case "connection":
      return (
        <span className="relative flex shrink-0">
          <DriverBadge driver={conn?.driver ?? "postgres"} size={16} />
          {status === "connected" && (
            <span className="absolute -bottom-0.5 -right-0.5 h-[7px] w-[7px] rounded-full border-[1.5px] border-[var(--bg-sidebar)] bg-[var(--diff-add)]" />
          )}
          {status === "error" && <span className="absolute -bottom-0.5 -right-0.5 h-[7px] w-[7px] rounded-full border-[1.5px] border-[var(--bg-sidebar)] bg-[var(--diff-del)]" />}
        </span>
      );
    case "database":
      return <DatabaseIcon dim={node.system} />;
    case "schema":
      return <SchemaIcon dim={node.system} />;
    case "category":
      return <FolderIcon open={open} />;
    case "object":
      return <ObjectIcon kind={node.object!.kind} />;
    case "column":
      return <ColumnIcon pk={node.primaryKey} fk={node.foreignKey} />;
  }
}

function TreeRow({
  row,
  selected,
  onSelect,
  onMenu,
}: {
  row: Row;
  selected: boolean;
  onSelect: (key: string) => void;
  onMenu: (e: React.MouseEvent, row: Row) => void;
}) {
  const st = useConnections.getState();
  const conn = useConnections((s) => (row.kind === "node" ? s.connections.find((c) => c.id === row.node.connId) : undefined));
  const connecting = useConnections((s) => row.kind === "node" && row.node.type === "connection" && s.status[row.node.connId] === "connecting");
  const pad = 6 + row.depth * INDENT;

  if (row.kind === "status") {
    return (
      <div
        className={cx("flex h-[26px] items-center gap-1.5 truncate pr-2 text-[12px]", row.error ? "text-[var(--diff-del)]" : "text-[var(--text-dim)]")}
        style={{ paddingLeft: pad + 18 }}
        title={row.text}
      >
        {row.error && <AlertCircle size={12} className="shrink-0" />}
        <span className="truncate">{row.text}</span>
      </div>
    );
  }

  const leaf = row.kind === "node" && (row.node.leaf || row.node.type === "column");
  const toggle = () => {
    if (row.kind === "folder") {
      useConnections.setState((s) => ({ expanded: { ...s.expanded, [row.key]: !row.open } }));
    } else if (!leaf) void st.toggle(row.node);
  };

  return (
    <div
      role="treeitem"
      aria-expanded={leaf ? undefined : row.open}
      aria-selected={selected}
      data-testid={row.kind === "node" ? `node-${row.node.type}` : "node-folder"}
      data-key={row.key}
      className={cx(
        "group relative flex h-[26px] cursor-default items-center gap-1.5 rounded-lg pr-2 text-[12.5px] transition-colors",
        selected ? "bg-[var(--hover-bg)] text-[var(--text-main)]" : "text-[var(--text-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]",
      )}
      style={{ paddingLeft: pad }}
      onMouseDown={() => onSelect(row.key)}
      onClick={(e) => {
        // A click on the chevron toggles; a click on a connection connects.
        if ((e.target as HTMLElement).closest("[data-chevron]")) toggle();
      }}
      onDoubleClick={() => (row.kind === "folder" ? toggle() : leaf || row.node.type === "object" ? openNode(row.node) : toggle())}
      onContextMenu={(e) => onMenu(e, row)}
    >
      {row.kind === "node" && row.node.type === "connection" && conn?.color && (
        <span className="absolute bottom-1 left-0 top-1 w-[3px] rounded-full" style={{ background: conn.color }} />
      )}
      <span data-chevron className={cx("flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-dim)]", leaf && "invisible")}>
        {(row.kind === "node" && row.loading) || connecting ? (
          <LoaderCircle size={12} className="animate-spin" />
        ) : (
          <motion.span animate={{ rotate: row.open ? 90 : 0 }} transition={{ duration: 0.12 }} className="flex">
            <ChevronRight size={13} strokeWidth={1.8} />
          </motion.span>
        )}
      </span>
      {row.kind === "folder" ? <FolderIcon open={row.open} /> : <NodeIcon node={row.node} open={row.open} />}
      <span className={cx("truncate", row.kind === "node" && row.node.system && "text-[var(--text-dim)]")}>{row.kind === "folder" ? row.label : row.node.label}</span>
      {row.kind === "node" && row.node.type === "connection" && conn?.environment === "production" && (
        <Pill tone="danger" className="h-4 px-1 text-[9.5px]">
          PROD
        </Pill>
      )}
      {row.kind === "node" && row.node.type === "connection" && conn?.readOnly && (
        <Pill className="h-4 px-1 text-[9.5px]">RO</Pill>
      )}
      {row.kind === "node" && row.node.hint && <span className="ml-1 min-w-0 shrink truncate text-[11px] text-[var(--text-dim)]">{row.node.hint}</span>}
    </div>
  );
}

export function Navigator() {
  const { width, startResize } = useSidebarResize();
  const rows = useRows();
  const loaded = useConnections((s) => s.loaded);
  const empty = useConnections((s) => s.connections.length === 0);
  const filter = useConnections((s) => s.filter);
  const selectedKey = useConnections((s) => s.selectedKey);
  const { setFilter, select, collapseAll, openEditor } = useConnections.getState();
  const { openSettings } = useUi.getState();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: ContextMenuItem[] } | null>(null);

  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_H, overscan: 16 });

  /** Menu for the navigator itself (blank space or a folder row). */
  const generalMenu = (folder?: string): ContextMenuItem[] => {
    const st = useConnections.getState();
    const ids = st.connections.filter((c) => folder === undefined || (c.folder || "").trim() === folder).map((c) => c.id);
    const connected = ids.filter((id) => st.status[id] === "connected");
    const showSystem = useUi.getState().prefs.showSystemObjects;
    return [
      { icon: <Plus size={13} />, label: folder ? `New Connection in “${folder}”` : "New Connection", hint: folder ? undefined : "Ctrl+Shift+N", onClick: () => openEditor(folder ? { ...blankConnection(), folder } : undefined) },
      { icon: <SquareTerminal size={13} />, label: "New SQL Editor", onClick: () => useWorkspace.getState().newSql() },
      "separator",
      { icon: <Plug size={13} />, label: folder ? "Connect All in Folder" : "Connect All", disabled: connected.length === ids.length, onClick: () => ids.forEach((id) => void st.ensureConnected(id)) },
      { icon: <Unplug size={13} />, label: folder ? "Disconnect All in Folder" : "Disconnect All", disabled: connected.length === 0, onClick: () => connected.forEach((id) => void st.disconnect(id)) },
      { icon: <RefreshCw size={13} />, label: "Reload Connections", onClick: () => void st.load() },
      "separator",
      { icon: <ChevronsDownUp size={13} />, label: "Collapse All", onClick: collapseAll },
      {
        icon: showSystem ? <EyeOff size={13} /> : <Eye size={13} />,
        label: showSystem ? "Hide System Objects" : "Show System Objects",
        onClick: () => useUi.getState().setPref("showSystemObjects", !showSystem),
      },
    ];
  };

  const onMenu = (e: React.MouseEvent, row: Row) => {
    e.preventDefault();
    select(row.key);
    if (row.kind === "folder") setMenu({ at: { x: e.clientX, y: e.clientY }, items: generalMenu(row.label) });
    if (row.kind !== "node") return;
    setMenu({ at: { x: e.clientX, y: e.clientY }, items: nodeMenu(row.node) });
  };

  const onBlankMenu = (e: React.MouseEvent) => {
    if (e.defaultPrevented) return; // a row handled it
    e.preventDefault();
    setMenu({ at: { x: e.clientX, y: e.clientY }, items: generalMenu() });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const idx = rows.findIndex((r) => r.key === selectedKey);
    const nav = rows.filter((r) => r.kind !== "status");
    const pos = nav.findIndex((r) => r.key === selectedKey);
    const cur = rows[idx];
    const go = (r: Row | undefined) => {
      if (!r) return;
      select(r.key);
      virt.scrollToIndex(rows.indexOf(r), { align: "auto" });
    };
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        go(nav[Math.min(pos + 1, nav.length - 1)] ?? nav[0]);
        break;
      case "ArrowUp":
        e.preventDefault();
        go(nav[Math.max(pos - 1, 0)]);
        break;
      case "ArrowRight":
        if (cur?.kind === "node" && !cur.open && !cur.node.leaf && cur.node.type !== "column") void useConnections.getState().toggle(cur.node, true);
        else if (cur?.kind === "folder" && !cur.open) useConnections.setState((s) => ({ expanded: { ...s.expanded, [cur.key]: true } }));
        else go(nav[pos + 1]);
        break;
      case "ArrowLeft":
        if (cur?.kind === "node" && cur.open) void useConnections.getState().toggle(cur.node, false);
        else if (cur?.kind === "folder" && cur.open) useConnections.setState((s) => ({ expanded: { ...s.expanded, [cur.key]: false } }));
        else if (cur) {
          const parent = [...nav.slice(0, pos)].reverse().find((r) => r.depth < cur.depth);
          go(parent);
        }
        break;
      case "Enter":
        if (cur?.kind === "node") openNode(cur.node);
        break;
      case "ContextMenu":
        if (cur?.kind === "node") {
          const el = scrollRef.current?.querySelector(`[data-key="${CSS.escape(cur.key)}"]`)?.getBoundingClientRect();
          setMenu({ at: { x: (el?.left ?? 40) + 40, y: el?.bottom ?? 100 }, items: nodeMenu(cur.node) });
        }
        break;
      default:
        return;
    }
  };

  const HEADER_BTN = "text-[var(--text-dim)]";

  return (
    <aside aria-label="Database navigator" className="relative flex h-full shrink-0 flex-col bg-[var(--bg-sidebar)] text-[13px] leading-tight" style={{ width }}>
      <div className="flex h-7 items-center gap-0.5 px-2.5 pt-2.5 box-content">
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-[var(--bg-input)] px-2.5">
          <Search size={12} className="shrink-0 text-[var(--text-dim)]" />
          <input
            aria-label="Filter navigator"
            className="h-full min-w-0 flex-1 bg-transparent text-[12px] text-[var(--text-main)] outline-none placeholder:text-[var(--text-dim)]"
            placeholder="Filter loaded objects"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setFilter("")}
          />
          {filter && (
            <button type="button" className="text-[var(--text-dim)] hover:text-[var(--text-main)]" onClick={() => setFilter("")} title="Clear">
              <X size={11} />
            </button>
          )}
        </div>
          <IconButton size="xs" className={HEADER_BTN} label="New connection (Ctrl+Shift+N)" data-testid="new-connection" onClick={() => openEditor()}>
            <Plus size={14} />
          </IconButton>
          <IconButton
            size="xs"
            className={HEADER_BTN}
            label="New SQL editor (Ctrl+])"
            onClick={() => {
              const id = currentConnectionId();
              if (id) newEditorFor({ key: `c:${id}`, type: "connection", label: "", connId: id });
              else useWorkspace.getState().newSql();
            }}
          >
            <SquareTerminal size={13} />
          </IconButton>
          <IconButton
            size="xs"
            className={HEADER_BTN}
            label="Refresh (F5)"
            onClick={() => {
              const key = selectedKey ?? "";
              const st = useConnections.getState();
              const m = /^c:([^/]+)/.exec(key);
              const c = m && st.get(m[1]);
              if (c) void st.refresh({ key: `c:${c.id}`, type: "connection", label: c.name, connId: c.id });
              else void st.load();
            }}
          >
            <RefreshCw size={12.5} />
          </IconButton>
          <IconButton size="xs" className={HEADER_BTN} label="Collapse all" onClick={collapseAll}>
            <ChevronsDownUp size={13} />
          </IconButton>
      </div>

      {loaded && empty ? (
        <div className="flex flex-1 flex-col items-center px-6 pt-[18vh] text-center">
          <div className="text-[13px] font-medium text-[var(--text-main)]">No connections yet</div>
          <div className="mt-1 text-[12px] leading-relaxed text-[var(--text-dim)]">PostgreSQL, MySQL, SQLite and SQL Server.</div>
          <button
            type="button"
            className="mt-3 flex h-7 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 text-[12px] font-medium text-white hover:bg-[var(--accent-hover)]"
            onClick={() => openEditor()}
          >
            <Plus size={13} /> New connection
          </button>
        </div>
      ) : (
        <div className="mt-1.5 flex min-h-0 flex-1 flex-col" onContextMenu={onBlankMenu} data-testid="navigator-body">
        <ScrollArea scrollRef={scrollRef as React.RefObject<HTMLDivElement>} className="min-h-0 flex-1" innerClassName="px-1.5 pb-2 outline-none">
          <div role="tree" tabIndex={0} aria-label="Connections" className="relative outline-none" style={{ height: virt.getTotalSize() }} onKeyDown={onKeyDown}>
            {virt.getVirtualItems().map((v) => {
              const row = rows[v.index];
              return (
                <div key={row.key} className="absolute left-0 right-0" style={{ top: v.start, height: ROW_H }}>
                  <TreeRow row={row} selected={row.key === selectedKey} onSelect={select} onMenu={onMenu} />
                </div>
              );
            })}
          </div>
        </ScrollArea>
        </div>
      )}

      <div className="mt-auto flex shrink-0 flex-col gap-0.5 px-2.5 pb-3 pt-1">
        <NavItem icon={<History size={16} strokeWidth={1.5} className="shrink-0" />} onClick={() => useWorkspace.getState().openHistory()}>
          <span className="flex-1">Query History</span>
        </NavItem>
        <NavItem data-testid="open-settings" icon={<Settings size={16} strokeWidth={1.5} className="shrink-0" />} onClick={() => openSettings()}>
          <span>Settings</span>
        </NavItem>
      </div>

      <div className="sidebar-resizer" onMouseDown={startResize} role="separator" aria-orientation="vertical" aria-label="Resize navigator" />
      <ContextMenu at={menu?.at ?? null} items={menu?.items ?? []} onClose={() => setMenu(null)} />
    </aside>
  );
}
