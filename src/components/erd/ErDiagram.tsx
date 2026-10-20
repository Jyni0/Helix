import { useEffect, useMemo, useRef, useState } from "react";
import { Download, KeyRound, LayoutGrid, Maximize2, RefreshCw, ZoomIn, ZoomOut } from "lucide-react";
import { api, errorMessage, isTauri } from "@/lib/api";
import type { ModelTable } from "@/lib/types";
import { schemaModel, useConnections } from "@/store/connections";
import { toast } from "@/store/ui";
import { useWorkspace } from "@/store/workspace";
import { Alert, IconButton, Segmented, Spinner, cx } from "@/components";

const HEAD = 30;
const ROW = 20;
const PAD = 10;
const GAP_X = 70;
const GAP_Y = 40;

interface Pos {
  x: number;
  y: number;
}

function tableWidth(t: ModelTable, keysOnly: boolean): number {
  const cols = keysOnly ? t.columns.filter((c) => c.primaryKey || t.foreignKeys.some((f) => f.columns.includes(c.name))) : t.columns;
  const longest = Math.max(t.name.length * 7.6 + 34, ...cols.map((c) => c.name.length * 7.2 + Math.min(c.dataType.length + 2, 24) * 6.6 + 64));
  return Math.round(Math.min(Math.max(longest, 160), 420));
}

function visibleColumns(t: ModelTable, keysOnly: boolean) {
  return keysOnly ? t.columns.filter((c) => c.primaryKey || t.foreignKeys.some((f) => f.columns.includes(c.name))) : t.columns;
}

function tableHeight(t: ModelTable, keysOnly: boolean) {
  return HEAD + Math.max(1, visibleColumns(t, keysOnly).length) * ROW + 6;
}

/** Related tables next to each other: BFS over foreign keys, packed into balanced columns. */
function autoLayout(tables: ModelTable[], keysOnly: boolean): Record<string, Pos> {
  const adj = new Map<string, Set<string>>();
  for (const t of tables) adj.set(t.name, adj.get(t.name) ?? new Set());
  for (const t of tables)
    for (const f of t.foreignKeys) {
      if (!adj.has(f.refTable) || f.refTable === t.name) continue;
      adj.get(t.name)!.add(f.refTable);
      adj.get(f.refTable)!.add(t.name);
    }
  const seen = new Set<string>();
  const order: string[] = [];
  const byDegree = [...tables].sort((a, b) => (adj.get(b.name)?.size ?? 0) - (adj.get(a.name)?.size ?? 0));
  for (const start of byDegree) {
    if (seen.has(start.name)) continue;
    const queue = [start.name];
    seen.add(start.name);
    while (queue.length) {
      const n = queue.shift()!;
      order.push(n);
      for (const m of [...(adj.get(n) ?? [])].sort((a, b) => (adj.get(b)?.size ?? 0) - (adj.get(a)?.size ?? 0))) {
        if (!seen.has(m)) {
          seen.add(m);
          queue.push(m);
        }
      }
    }
  }
  const map = new Map(tables.map((t) => [t.name, t]));
  const cols = Math.max(1, Math.round(Math.sqrt(tables.length * 1.4)));
  const colY = Array(cols).fill(0) as number[];
  const colW = Array(cols).fill(0) as number[];
  const place: Record<string, { col: number; y: number }> = {};
  for (const name of order) {
    const t = map.get(name)!;
    let c = 0;
    for (let i = 1; i < cols; i++) if (colY[i] < colY[c]) c = i;
    place[name] = { col: c, y: colY[c] };
    colY[c] += tableHeight(t, keysOnly) + GAP_Y;
    colW[c] = Math.max(colW[c], tableWidth(t, keysOnly));
  }
  const xs: number[] = [];
  let x = 40;
  for (let i = 0; i < cols; i++) {
    xs.push(x);
    x += colW[i] + GAP_X;
  }
  const out: Record<string, Pos> = {};
  for (const [name, p] of Object.entries(place)) out[name] = { x: xs[p.col], y: 40 + p.y };
  return out;
}

/** Copies the SVG with theme colours inlined (exports look like the screen). */
function exportSvg(svg: SVGSVGElement, bbox: { x: number; y: number; w: number; h: number }): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const style = getComputedStyle(document.documentElement);
  const inline = (s: string) => s.replace(/var\((--[\w-]+)\)/g, (_, v) => style.getPropertyValue(v).trim() || "#888");
  clone.querySelectorAll("*").forEach((el) => {
    for (const attr of ["fill", "stroke", "style", "color"]) {
      const v = el.getAttribute(attr);
      if (v?.includes("var(")) el.setAttribute(attr, inline(v));
    }
  });
  const g = clone.querySelector("g[data-viewport]");
  g?.setAttribute("transform", "");
  clone.setAttribute("viewBox", `${bbox.x - 20} ${bbox.y - 20} ${bbox.w + 40} ${bbox.h + 40}`);
  clone.setAttribute("width", String(bbox.w + 40));
  clone.setAttribute("height", String(bbox.h + 40));
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const bg = inline("var(--bg-app)");
  return `<?xml version="1.0" encoding="UTF-8"?>\n${clone.outerHTML.replace(/^<svg/, `<svg style="background:${bg};font-family:Inter,Segoe UI,sans-serif"`)}`;
}

export function ErDiagram({ connectionId, database, schema, focusTable }: { connectionId: string; database: string; schema: string | null; focusTable?: string }) {
  const [model, setModel] = useState<ModelTable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const [keysOnly, setKeysOnly] = useState(false);
  const storeKey = `helix.erd.${connectionId}|${database}|${schema ?? ""}${focusTable ? `|${focusTable}` : ""}`;
  const [positions, setPositions] = useState<Record<string, Pos>>(() => {
    try {
      return JSON.parse(localStorage.getItem(storeKey) ?? "{}");
    } catch {
      return {};
    }
  });
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [hover, setHover] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ kind: "pan" | "table"; name?: string; sx: number; sy: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    (async () => {
      if (!(await useConnections.getState().ensureConnected(connectionId))) throw new Error("Not connected");
      return schemaModel(connectionId, database, schema, n > 0);
    })().then(
      (m) => alive && setModel(m),
      (e) => alive && setError(errorMessage(e)),
    );
    return () => {
      alive = false;
    };
  }, [connectionId, database, schema, n]);

  /** The tables drawn: the whole schema, or one table with its neighbours. */
  const tables = useMemo(() => {
    if (!model) return [];
    if (!focusTable) return model;
    const related = new Set([focusTable]);
    for (const t of model) {
      if (t.name === focusTable) t.foreignKeys.forEach((f) => related.add(f.refTable));
      if (t.foreignKeys.some((f) => f.refTable === focusTable)) related.add(t.name);
    }
    return model.filter((t) => related.has(t.name));
  }, [model, focusTable]);

  const layout = useMemo(() => {
    const auto = autoLayout(tables, keysOnly);
    const out: Record<string, Pos> = {};
    for (const t of tables) out[t.name] = positions[t.name] ?? auto[t.name];
    return out;
  }, [tables, positions, keysOnly]);

  const bbox = useMemo(() => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const t of tables) {
      const p = layout[t.name];
      if (!p) continue;
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + tableWidth(t, keysOnly));
      y1 = Math.max(y1, p.y + tableHeight(t, keysOnly));
    }
    return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 100, h: 100 };
  }, [tables, layout, keysOnly]);

  const fit = () => {
    const el = boxRef.current;
    if (!el) return;
    const k = Math.min(1.4, Math.max(0.15, Math.min((el.clientWidth - 40) / bbox.w, (el.clientHeight - 40) / bbox.h)));
    setView({ k, x: (el.clientWidth - bbox.w * k) / 2 - bbox.x * k, y: (el.clientHeight - bbox.h * k) / 2 - bbox.y * k });
  };

  // Fit once the model arrives.
  const fitted = useRef(false);
  useEffect(() => {
    if (tables.length && !fitted.current) {
      fitted.current = true;
      requestAnimationFrame(fit);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables.length]);

  const savePositions = (p: Record<string, Pos>) => {
    setPositions(p);
    try {
      localStorage.setItem(storeKey, JSON.stringify(p));
    } catch {
      /* ignore */
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const k = Math.min(3, Math.max(0.1, view.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    setView({ k, x: mx - ((mx - view.x) * k) / view.k, y: my - ((my - view.y) * k) / view.k });
  };

  const onPointerDown = (e: React.PointerEvent, name?: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (name) {
      const p = layout[name];
      drag.current = { kind: "table", name, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y };
    } else drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (d.kind === "pan") setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
    else setPositions((p) => ({ ...layout, ...p, [d.name!]: { x: Math.round(d.ox + dx / view.k), y: Math.round(d.oy + dy / view.k) } }));
  };
  const onPointerUp = () => {
    if (drag.current?.kind === "table") savePositions({ ...layout, ...positions });
    drag.current = null;
  };

  const doExport = async () => {
    if (!svgRef.current) return;
    const text = exportSvg(svgRef.current, bbox);
    if (!isTauri()) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
      a.download = `${focusTable ?? schema ?? database}.svg`;
      a.click();
      return;
    }
    const path = await api.pickSaveFile(`${focusTable ?? schema ?? database}.svg`, [{ name: "SVG image", extensions: ["svg"] }]);
    if (!path) return;
    try {
      await api.writeTextFile(path, text);
      toast("Diagram exported", "success", path);
    } catch (e) {
      toast("Export failed", "error", errorMessage(e));
    }
  };

  if (error)
    return (
      <div className="p-5">
        <Alert>{error}</Alert>
      </div>
    );
  if (!model)
    return (
      <div className="flex flex-1 items-center justify-center text-[var(--text-dim)]">
        <Spinner size={18} />
      </div>
    );

  const tableMap = new Map(tables.map((t) => [t.name, t]));
  const colY = (t: ModelTable, col: string) => {
    const i = visibleColumns(t, keysOnly).findIndex((c) => c.name === col);
    return HEAD + (i < 0 ? 0 : i) * ROW + ROW / 2 + 2;
  };

  const edges = tables.flatMap((t) =>
    t.foreignKeys
      .filter((f) => tableMap.has(f.refTable))
      .map((f) => {
        const ref = tableMap.get(f.refTable)!;
        const a = layout[t.name];
        const b = layout[ref.name];
        const aw = tableWidth(t, keysOnly);
        const bw = tableWidth(ref, keysOnly);
        const ay = a.y + colY(t, f.columns[0]);
        const by = b.y + colY(ref, f.refColumns[0]);
        let ax: number, bx: number, c1: number, c2: number;
        if (ref === t) {
          ax = a.x + aw;
          bx = a.x + aw;
          c1 = ax + 40;
          c2 = bx + 40;
        } else if (b.x > a.x + aw) {
          ax = a.x + aw;
          bx = b.x;
          c1 = ax + 50;
          c2 = bx - 50;
        } else if (b.x + bw < a.x) {
          ax = a.x;
          bx = b.x + bw;
          c1 = ax - 50;
          c2 = bx + 50;
        } else {
          ax = a.x + aw;
          bx = b.x + bw;
          c1 = Math.max(ax, bx) + 60;
          c2 = c1;
        }
        const active = hover === t.name || hover === ref.name;
        return { key: `${t.name}.${f.name}`, d: `M${ax},${ay} C${c1},${ay} ${c2},${by} ${bx},${by}`, ax, ay, bx, by, active, label: `${f.columns.join(", ")} → ${ref.name}(${f.refColumns.join(", ")})` };
      }),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--border-soft)] px-3">
        <span className="flex-1 text-[11.5px] text-[var(--text-dim)]">
          {tables.length} tables · {edges.length} relations · drag tables, scroll to zoom, double-click to open
        </span>
        <Segmented
          size="xs"
          value={keysOnly ? "keys" : "all"}
          onChange={(v) => setKeysOnly(v === "keys")}
          options={[
            { value: "all", label: "All columns" },
            { value: "keys", label: "Keys" },
          ]}
        />
        <IconButton size="xs" label="Zoom in" onClick={() => setView((v) => ({ ...v, k: Math.min(3, v.k * 1.2) }))}>
          <ZoomIn size={13} />
        </IconButton>
        <IconButton size="xs" label="Zoom out" onClick={() => setView((v) => ({ ...v, k: Math.max(0.1, v.k / 1.2) }))}>
          <ZoomOut size={13} />
        </IconButton>
        <IconButton size="xs" label="Fit to screen" onClick={fit}>
          <Maximize2 size={12.5} />
        </IconButton>
        <IconButton
          size="xs"
          label="Auto layout"
          onClick={() => {
            savePositions({});
            requestAnimationFrame(fit);
          }}
        >
          <LayoutGrid size={13} />
        </IconButton>
        <IconButton size="xs" label="Reload model" onClick={() => setN((x) => x + 1)}>
          <RefreshCw size={12.5} />
        </IconButton>
        <IconButton size="xs" label="Export as SVG" onClick={() => void doExport()}>
          <Download size={13} />
        </IconButton>
      </div>
      <div
        ref={boxRef}
        className="relative min-h-0 flex-1 cursor-grab overflow-hidden bg-[var(--bg-app)] active:cursor-grabbing"
        style={{ backgroundImage: "radial-gradient(color-mix(in srgb, var(--text-main) 9%, transparent) 1px, transparent 1px)", backgroundSize: `${20 * view.k}px ${20 * view.k}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
        onWheel={onWheel}
        onPointerDown={(e) => onPointerDown(e)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {!tables.length && <div className="p-6 text-[12.5px] text-[var(--text-dim)]">No tables in this schema.</div>}
        <svg ref={svgRef} className="absolute inset-0 h-full w-full select-none" data-testid="erd">
          <defs>
            <marker id="erd-one" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10" fill="none" stroke="var(--accent)" strokeWidth="1.4" />
            </marker>
            <marker id="erd-many" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7">
              <circle cx="5" cy="5" r="3.2" fill="var(--bg-app)" stroke="var(--text-dim)" strokeWidth="1.4" />
            </marker>
          </defs>
          <g data-viewport transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {edges.map((e) => (
              <path
                key={e.key}
                d={e.d}
                fill="none"
                stroke={e.active ? "var(--accent)" : "var(--text-dim)"}
                strokeOpacity={e.active ? 1 : 0.55}
                strokeWidth={e.active ? 1.8 : 1.2}
                markerStart="url(#erd-many)"
                markerEnd="url(#erd-one)"
              >
                <title>{e.label}</title>
              </path>
            ))}
            {tables.map((t) => {
              const p = layout[t.name];
              const w = tableWidth(t, keysOnly);
              const h = tableHeight(t, keysOnly);
              const cols = visibleColumns(t, keysOnly);
              const fk = new Set(t.foreignKeys.flatMap((f) => f.columns));
              const focus = t.name === focusTable;
              return (
                <g
                  key={t.name}
                  transform={`translate(${p.x},${p.y})`}
                  className="cursor-move"
                  onPointerDown={(e) => onPointerDown(e, t.name)}
                  onPointerEnter={() => setHover(t.name)}
                  onPointerLeave={() => setHover(null)}
                  onDoubleClick={() => useWorkspace.getState().openTable({ connectionId, database, schema, name: t.name, objectKind: t.kind === "view" ? "view" : "table" })}
                >
                  <rect width={w} height={h} rx={10} fill="var(--bg-surface)" stroke={focus || hover === t.name ? "var(--accent)" : "var(--border)"} strokeWidth={focus ? 1.6 : 1} />
                  <path d={`M0,10 a10,10 0 0 1 10,-10 h${w - 20} a10,10 0 0 1 10,10 v${HEAD - 10} h-${w} z`} fill={t.kind === "view" ? "color-mix(in srgb, var(--diff-add) 16%, var(--bg-surface))" : "color-mix(in srgb, var(--accent) 16%, var(--bg-surface))"} />
                  <text x={PAD} y={19} fontSize={12.5} fontWeight={600} fill="var(--text-main)">
                    {t.name}
                  </text>
                  {t.kind === "view" && (
                    <text x={w - PAD} y={19} fontSize={10} textAnchor="end" fill="var(--text-dim)">
                      view
                    </text>
                  )}
                  {cols.map((c, i) => (
                    <g key={c.name} transform={`translate(0,${HEAD + i * ROW + 2})`}>
                      {c.primaryKey ? (
                        <text x={PAD} y={14} fontSize={10.5} fill="#e3b341">
                          ⚿
                        </text>
                      ) : fk.has(c.name) ? (
                        <text x={PAD} y={14} fontSize={10.5} fill="var(--accent)">
                          ↗
                        </text>
                      ) : null}
                      <text x={PAD + 15} y={14} fontSize={11.5} fill={c.primaryKey ? "var(--text-main)" : "var(--text-muted)"} fontWeight={c.primaryKey ? 600 : 400}>
                        {c.name}
                      </text>
                      <text x={w - PAD} y={14} fontSize={10.5} textAnchor="end" fill="var(--text-dim)" fontFamily="JetBrains Mono, monospace">
                        {c.dataType.length > 22 ? c.dataType.slice(0, 21) + "…" : c.dataType}
                        {c.nullable ? "" : " !"}
                      </text>
                    </g>
                  ))}
                </g>
              );
            })}
          </g>
        </svg>
        <div className={cx("pointer-events-none absolute bottom-3 right-3 rounded-lg bg-[var(--bg-surface)]/80 px-2 py-1 text-[11px] text-[var(--text-dim)]")}>
          {Math.round(view.k * 100)}% <KeyRound size={10} className="ml-2 inline text-amber-500" /> key · ! not null
        </div>
      </div>
    </div>
  );
}
