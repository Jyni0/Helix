import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ClipboardPaste, Copy, CopyPlus, Eye, KeyRound, Pencil, Plus, Trash2, CircleSlash, WandSparkles } from "lucide-react";
import type { Cell, ColumnInfo, Driver } from "@/lib/types";
import type { SortKey } from "@/lib/sql/dialect";
import { copyText, formatRows, parseClipboardGrid, type CopyFormat } from "@/lib/copy";
import { ContextMenu, cx, type ContextMenuItem } from "@/components";
import { addRow, deleteRows, rowValues, setCell, type GridEdits } from "./edits";
import { GENERATORS, suggestGenerator, type Generator } from "@/lib/generate";

const ROW_H = 26;
const HEAD_H = 30;
const NUM_W = 52;

export interface CellPos {
  row: number;
  col: number;
}

export interface GridHandle {
  focus(): void;
  /** Rows (display indices) touched by the selection. */
  selectedRows(): number[];
  copy(format: CopyFormat, header?: boolean): void;
}

interface Props {
  columns: ColumnInfo[];
  rows: Cell[][];
  edits?: GridEdits;
  editable?: boolean;
  onEditsChange?(e: GridEdits): void;
  /** Server-side sort: the grid only reports clicks. Without it, the grid sorts itself. */
  sort?: SortKey[];
  onSortChange?(sort: SortKey[]): void;
  nullText: string;
  driver?: Driver;
  /** Table name for "Copy as SQL". */
  tableName?: string;
  /** Primary key columns (marked in the header). */
  keyColumns?: string[];
  onFocusCell?(pos: CellPos | null): void;
  extraMenu?(pos: CellPos, value: Cell): ContextMenuItem[];
  onOpenValue?(): void;
  /** Font size of cells. */
  fontSize?: number;
}

function initialWidth(col: ColumnInfo, rows: Cell[][], index: number): number {
  let max = col.name.length + 3;
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const v = rows[i][index];
    if (v !== null && v.length > max) max = v.length;
  }
  return Math.round(Math.min(Math.max(max * 7.2 + 22, 64), 380));
}

function displayText(v: string): string {
  return v.length > 400 ? v.slice(0, 400).replace(/[\r\n]+/g, " ↵ ") + "…" : v.replace(/[\r\n]+/g, " ↵ ");
}

function compare(a: Cell, b: Cell, numeric: boolean): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (numeric) {
    const d = Number(a) - Number(b);
    if (!Number.isNaN(d)) return d;
  }
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** The result grid: virtualized rows, rectangular selection, inline editing. */
export const ResultGrid = forwardRef<GridHandle, Props>(function ResultGrid(props, ref) {
  const { columns, rows: base, edits, editable = false, onEditsChange, nullText, fontSize = 12.5 } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<number[]>(() => columns.map((c, i) => initialWidth(c, base, i)));
  const [localSort, setLocalSort] = useState<SortKey[]>([]);
  const [anchor, setAnchor] = useState<CellPos | null>(null);
  const [focus, setFocus] = useState<CellPos | null>(null);
  const [rowMode, setRowMode] = useState(false);
  const [editing, setEditing] = useState<{ pos: CellPos; value: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const dragging = useRef(false);

  // New result columns: fresh widths.
  const colKey = columns.map((c) => c.name).join("\u0001");
  useEffect(() => {
    setWidths(columns.map((c, i) => initialWidth(c, base, i)));
    setAnchor(null);
    setFocus(null);
    setEditing(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colKey]);

  const sort = props.onSortChange ? (props.sort ?? []) : localSort;
  const total = base.length + (edits?.inserted.length ?? 0);
  const deleted = useMemo(() => new Set(edits?.deleted ?? []), [edits]);

  /** Display order → row index. */
  const order = useMemo(() => {
    const idx = Array.from({ length: base.length }, (_, i) => i);
    if (!props.onSortChange && localSort.length) {
      const keys = localSort.map((s) => ({ i: columns.findIndex((c) => c.name === s.column), desc: s.desc })).filter((k) => k.i >= 0);
      idx.sort((a, b) => {
        for (const k of keys) {
          const c = compare(base[a][k.i], base[b][k.i], columns[k.i].kind === "number");
          if (c) return k.desc ? -c : c;
        }
        return a - b;
      });
    }
    for (let i = base.length; i < total; i++) idx.push(i);
    return idx;
  }, [base, columns, localSort, props.onSortChange, total]);

  const lefts = useMemo(() => {
    const out: number[] = [];
    let x = NUM_W;
    for (const w of widths) {
      out.push(x);
      x += w;
    }
    out.push(x);
    return out;
  }, [widths]);
  const totalWidth = lefts[lefts.length - 1] ?? NUM_W;

  const virt = useVirtualizer({ count: order.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_H, overscan: 12 });

  const valueAt = useCallback((dispRow: number, col: number): Cell => rowValues(edits, base, order[dispRow])[col] ?? null, [edits, base, order]);

  const sel = useMemo(() => {
    if (!anchor || !focus) return null;
    return {
      r0: Math.min(anchor.row, focus.row),
      r1: Math.max(anchor.row, focus.row),
      c0: rowMode ? 0 : Math.min(anchor.col, focus.col),
      c1: rowMode ? columns.length - 1 : Math.max(anchor.col, focus.col),
    };
  }, [anchor, focus, rowMode, columns.length]);

  useEffect(() => {
    props.onFocusCell?.(focus ? { row: order[focus.row], col: focus.col } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, order]);

  const scrollTo = (pos: CellPos) => {
    virt.scrollToIndex(pos.row, { align: "auto" });
    const el = scrollRef.current;
    if (!el) return;
    const l = lefts[pos.col];
    const r = lefts[pos.col + 1];
    if (l - NUM_W < el.scrollLeft) el.scrollLeft = l - NUM_W;
    else if (r > el.scrollLeft + el.clientWidth) el.scrollLeft = r - el.clientWidth;
  };

  const move = (pos: CellPos, extend: boolean) => {
    const p = { row: Math.max(0, Math.min(order.length - 1, pos.row)), col: Math.max(0, Math.min(columns.length - 1, pos.col)) };
    if (!order.length) return;
    setFocus(p);
    if (!extend) {
      setAnchor(p);
      setRowMode(false);
    }
    scrollTo(p);
  };

  const selectedCells = (): { rows: number[]; cols: number[] } => {
    if (!sel) return { rows: [], cols: [] };
    const rows: number[] = [];
    for (let r = sel.r0; r <= sel.r1; r++) rows.push(r);
    const cols: number[] = [];
    for (let c = sel.c0; c <= sel.c1; c++) cols.push(c);
    return { rows, cols };
  };

  const copy = (format: CopyFormat, header = false) => {
    const { rows, cols } = selectedCells();
    if (!rows.length) return;
    const data = rows.map((r) => cols.map((c) => valueAt(r, c)));
    const cs = cols.map((c) => columns[c]);
    const text =
      format === "values" && rows.length === 1 && cols.length === 1
        ? (data[0][0] ?? "")
        : formatRows(format === "values" && header ? "tsv" : format, cs, data, { header, driver: props.driver, table: props.tableName, nullText: "" });
    void copyText(text);
  };

  useImperativeHandle(ref, () => ({
    focus: () => scrollRef.current?.focus(),
    selectedRows: () => selectedCells().rows.map((r) => order[r]),
    copy,
  }));

  const commitEdit = (value: Cell, next?: CellPos) => {
    if (!editing || !edits || !onEditsChange) return;
    onEditsChange(setCell(edits, base, order[editing.pos.row], editing.pos.col, value));
    setEditing(null);
    if (next) move(next, false);
    requestAnimationFrame(() => scrollRef.current?.focus());
  };

  const startEdit = (pos: CellPos, initial?: string) => {
    if (!editable || !edits) return;
    const r = order[pos.row];
    if (r < base.length && deleted.has(r)) return;
    const v = valueAt(pos.row, pos.col);
    setEditing({ pos, value: initial ?? v ?? "" });
  };

  const setNull = () => {
    if (!editable || !edits || !onEditsChange) return;
    const { rows, cols } = selectedCells();
    let e = edits;
    for (const r of rows) for (const c of cols) e = setCell(e, base, order[r], c, null);
    onEditsChange(e);
  };

  /** Fills every selected cell with a fresh generated value (`gen` null: the
   * best fit for each cell's column). */
  const generate = (gen: Generator | null) => {
    if (!editable || !edits || !onEditsChange) return;
    const { rows, cols } = selectedCells();
    let e = edits;
    for (const r of rows) {
      if (order[r] < base.length && deleted.has(order[r])) continue;
      for (const c of cols) e = setCell(e, base, order[r], c, (gen ?? suggestGenerator(columns[c])).make());
    }
    onEditsChange(e);
  };

  const generateItems = (col: number): ContextMenuItem[] => {
    const best = suggestGenerator(columns[col]);
    const groups = [...new Set(GENERATORS.map((g) => g.group))];
    return [
      { icon: <WandSparkles size={13} />, label: `Best fit — ${best.label}`, hint: "Ctrl+G", onClick: () => generate(null) },
      "separator",
      ...groups.map((group) => ({
        label: group,
        items: GENERATORS.filter((g) => g.group === group).map((g) => ({ label: g.label, onClick: () => generate(g) })),
      })),
    ];
  };

  const paste = async () => {
    if (!editable || !edits || !onEditsChange || !focus) return;
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return;
    }
    const grid = parseClipboardGrid(text);
    let e = edits;
    grid.forEach((line, dr) => {
      line.forEach((v, dc) => {
        const r = focus.row + dr;
        const c = focus.col + dc;
        if (c >= columns.length) return;
        if (r >= order.length) return;
        e = setCell(e, base, order[r], c, v);
      });
    });
    onEditsChange(e);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const f = focus ?? { row: 0, col: 0 };
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 300) / ROW_H) - 1);
    switch (e.key) {
      case "ArrowDown":
        move({ row: ctrl ? order.length - 1 : f.row + 1, col: f.col }, e.shiftKey);
        break;
      case "ArrowUp":
        move({ row: ctrl ? 0 : f.row - 1, col: f.col }, e.shiftKey);
        break;
      case "ArrowRight":
        move({ row: f.row, col: ctrl ? columns.length - 1 : f.col + 1 }, e.shiftKey);
        break;
      case "ArrowLeft":
        move({ row: f.row, col: ctrl ? 0 : f.col - 1 }, e.shiftKey);
        break;
      case "PageDown":
        move({ row: f.row + page, col: f.col }, e.shiftKey);
        break;
      case "PageUp":
        move({ row: f.row - page, col: f.col }, e.shiftKey);
        break;
      case "Home":
        move({ row: ctrl ? 0 : f.row, col: 0 }, e.shiftKey);
        break;
      case "End":
        move({ row: ctrl ? order.length - 1 : f.row, col: columns.length - 1 }, e.shiftKey);
        break;
      case "Tab":
        move({ row: f.row, col: f.col + (e.shiftKey ? -1 : 1) }, false);
        break;
      case "Enter":
      case "F2":
        if (focus && editable) startEdit(focus);
        else if (e.key === "Enter" && focus) props.onOpenValue?.();
        break;
      case "Delete":
        if (editable && edits && onEditsChange && sel) onEditsChange(deleteRows(edits, base, selectedCells().rows.map((r) => order[r])));
        break;
      case "Insert":
        if (editable && edits && onEditsChange) onEditsChange(addRow(edits, columns.length));
        break;
      case "Escape":
        setAnchor(focus);
        setRowMode(false);
        break;
      default:
        if (ctrl && e.key.toLowerCase() === "a") {
          setAnchor({ row: 0, col: 0 });
          setFocus({ row: order.length - 1, col: columns.length - 1 });
          setRowMode(false);
        } else if (ctrl && (e.code === "KeyC" || e.key.toLowerCase() === "c")) {
          copy(e.shiftKey ? "tsv" : "values", e.shiftKey);
        } else if (ctrl && (e.code === "KeyV" || e.key.toLowerCase() === "v")) {
          void paste();
        } else if (ctrl && e.code === "KeyD" && editable && edits && onEditsChange && focus) {
          onEditsChange(addRow(edits, columns.length, rowValues(edits, base, order[focus.row])));
        } else if (ctrl && e.code === "Digit0") {
          setNull();
        } else if (ctrl && e.code === "KeyG" && editable) {
          generate(null);
        } else if (!ctrl && !e.altKey && e.key.length === 1 && focus && editable) {
          startEdit(focus, e.key);
        } else return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const toggleSort = (col: string, additive: boolean) => {
    const cur = sort.find((s) => s.column === col);
    let next: SortKey[];
    if (!cur) next = additive ? [...sort, { column: col, desc: false }] : [{ column: col, desc: false }];
    else if (!cur.desc) next = sort.map((s) => (s.column === col ? { ...s, desc: true } : s)).filter((s) => additive || s.column === col);
    else next = additive ? sort.filter((s) => s.column !== col) : [];
    if (props.onSortChange) props.onSortChange(next);
    else setLocalSort(next);
  };

  const startResize = (e: React.MouseEvent, i: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[i];
    const onMove = (ev: MouseEvent) => setWidths((w) => w.map((x, k) => (k === i ? Math.max(40, startW + ev.clientX - startX) : x)));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const autofit = (i: number) => {
    let max = columns[i].name.length + 3;
    for (let r = 0; r < Math.min(order.length, 1000); r++) {
      const v = valueAt(r, i);
      if (v !== null) max = Math.max(max, Math.min(v.length, 120));
    }
    setWidths((w) => w.map((x, k) => (k === i ? Math.round(Math.max(max * 7.2 + 22, 48)) : x)));
  };

  const openMenu = (e: React.MouseEvent, pos: CellPos) => {
    e.preventDefault();
    if (!sel || pos.row < sel.r0 || pos.row > sel.r1 || pos.col < sel.c0 || pos.col > sel.c1) {
      setAnchor(pos);
      setFocus(pos);
      setRowMode(false);
    }
    const value = valueAt(pos.row, pos.col);
    const items: ContextMenuItem[] = [
      { icon: <Copy size={13} />, label: "Copy", hint: "Ctrl+C", onClick: () => copy("values") },
      { icon: <Copy size={13} />, label: "Copy with Headers", hint: "Ctrl+Shift+C", onClick: () => copy("tsv", true) },
      {
        icon: <Copy size={13} />,
        label: "Copy as",
        items: [
          { label: "CSV", onClick: () => copy("csv", true) },
          { label: "JSON", onClick: () => copy("json", true) },
          { label: "Markdown", onClick: () => copy("markdown", true) },
          { label: "SQL INSERT", onClick: () => copy("sql", true) },
        ],
      },
      { icon: <Copy size={13} />, label: "Copy Column Name", onClick: () => void copyText(columns[pos.col].name) },
      "separator",
      { icon: <Eye size={13} />, label: "View Value", hint: "Enter", onClick: () => props.onOpenValue?.() },
      { icon: <ArrowUp size={13} />, label: "Sort Ascending", onClick: () => (props.onSortChange ?? setLocalSort)([{ column: columns[pos.col].name, desc: false }]) },
      { icon: <ArrowDown size={13} />, label: "Sort Descending", onClick: () => (props.onSortChange ?? setLocalSort)([{ column: columns[pos.col].name, desc: true }]) },
    ];
    if (editable && edits && onEditsChange) {
      const rowsSel = (sel ? selectedCells().rows : [pos.row]).map((r) => order[r]);
      items.push(
        "separator",
        { icon: <Pencil size={13} />, label: "Edit Cell", hint: "F2", onClick: () => startEdit(pos) },
        { icon: <CircleSlash size={13} />, label: "Set to NULL", hint: "Ctrl+0", onClick: setNull },
        { icon: <WandSparkles size={13} />, label: "Generate Value", items: generateItems(pos.col) },
        { icon: <ClipboardPaste size={13} />, label: "Paste", hint: "Ctrl+V", onClick: () => void paste() },
        "separator",
        { icon: <Plus size={13} />, label: "Add Row", hint: "Insert", onClick: () => onEditsChange(addRow(edits, columns.length)) },
        { icon: <CopyPlus size={13} />, label: "Duplicate Row", hint: "Ctrl+D", onClick: () => onEditsChange(addRow(edits, columns.length, rowValues(edits, base, order[pos.row]))) },
        {
          icon: <Trash2 size={13} />,
          label: rowsSel.length > 1 ? `Delete ${rowsSel.length} Rows` : "Delete Row",
          hint: "Delete",
          danger: true,
          onClick: () => onEditsChange(deleteRows(edits, base, rowsSel)),
        },
      );
    }
    const extra = props.extraMenu?.({ row: order[pos.row], col: pos.col }, value);
    if (extra?.length) items.push("separator", ...extra);
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const onCellDown = (e: React.MouseEvent, pos: CellPos) => {
    if (e.button !== 0) return;
    scrollRef.current?.focus();
    if (e.shiftKey && anchor) setFocus(pos);
    else {
      setAnchor(pos);
      setFocus(pos);
      setRowMode(false);
    }
    dragging.current = true;
    const up = () => {
      dragging.current = false;
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mouseup", up);
  };

  const onRowNumDown = (e: React.MouseEvent, row: number) => {
    if (e.button !== 0) return;
    scrollRef.current?.focus();
    if (e.shiftKey && anchor) setFocus({ row, col: columns.length - 1 });
    else {
      setAnchor({ row, col: 0 });
      setFocus({ row, col: columns.length - 1 });
    }
    setRowMode(true);
  };

  const keys = new Set(props.keyColumns ?? []);
  const items = virt.getVirtualItems();

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        tabIndex={0}
        role="grid"
        aria-rowcount={order.length}
        aria-colcount={columns.length}
        data-testid="result-grid"
        className="thin-scroll relative min-h-0 flex-1 overflow-auto outline-none"
        style={{ fontSize }}
        onKeyDown={onKeyDown}
      >
        <div style={{ width: totalWidth, height: HEAD_H + virt.getTotalSize(), position: "relative" }}>
          {/* Header */}
          <div className="sticky top-0 z-20 flex border-b border-[var(--border)] bg-[var(--bg-sidebar)]" style={{ height: HEAD_H, width: totalWidth }}>
            <div className="sticky left-0 z-10 shrink-0 border-r border-[var(--border-soft)] bg-[var(--bg-sidebar)]" style={{ width: NUM_W }} />
            {columns.map((c, i) => {
              const s = sort.find((x) => x.column === c.name);
              const si = sort.findIndex((x) => x.column === c.name);
              return (
                <div
                  key={i}
                  role="columnheader"
                  title={`${c.name} · ${c.typeName || "?"}\nClick to sort, Shift+click to add`}
                  className="group relative flex shrink-0 cursor-pointer items-center gap-1 border-r border-[var(--border-soft)] px-2 text-[12px] text-[var(--text-main)] hover:bg-[var(--hover-bg)]"
                  style={{ width: widths[i] }}
                  onClick={(e) => toggleSort(c.name, e.shiftKey)}
                >
                  {keys.has(c.name) && <KeyRound size={11} className="shrink-0 text-amber-500" />}
                  <span className="min-w-0 truncate font-medium">{c.name}</span>
                  <span className="min-w-0 shrink truncate text-[10.5px] text-[var(--text-dim)]">{c.typeName}</span>
                  {s && (
                    <span className="ml-auto flex shrink-0 items-center text-[var(--accent)]">
                      {s.desc ? <ArrowDown size={11} /> : <ArrowUp size={11} />}
                      {sort.length > 1 && <span className="text-[9.5px]">{si + 1}</span>}
                    </span>
                  )}
                  <span
                    className="absolute -right-[3px] top-0 z-10 h-full w-[6px] cursor-col-resize hover:bg-[var(--accent)]/40"
                    onMouseDown={(e) => startResize(e, i)}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      autofit(i);
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                </div>
              );
            })}
          </div>

          {/* Rows */}
          {items.map((v) => {
            const dispRow = v.index;
            const r = order[dispRow];
            const isNew = r >= base.length;
            const isDel = !isNew && deleted.has(r);
            const changed = !isNew ? edits?.updated[r] : undefined;
            const vals = rowValues(edits, base, r);
            const rowSel = !!sel && dispRow >= sel.r0 && dispRow <= sel.r1;
            return (
              <div
                key={v.key}
                role="row"
                className={cx("absolute left-0 flex border-b border-[var(--border-soft)]", isNew && "row-new", isDel && "row-deleted")}
                style={{ top: HEAD_H + v.start, height: ROW_H, width: totalWidth }}
              >
                <div
                  className={cx(
                    "sticky left-0 z-10 flex shrink-0 cursor-default items-center justify-end border-r border-[var(--border-soft)] bg-[var(--bg-sidebar)] pr-2 font-mono text-[10.5px] tabular-nums",
                    rowSel ? "text-[var(--text-main)]" : "text-[var(--text-dim)]",
                  )}
                  style={{ width: NUM_W }}
                  onMouseDown={(e) => onRowNumDown(e, dispRow)}
                  onContextMenu={(e) => openMenu(e, { row: dispRow, col: 0 })}
                >
                  {isNew ? "+" : dispRow + 1}
                </div>
                {columns.map((c, ci) => {
                  const val = vals[ci];
                  const inSel = rowSel && ci >= sel!.c0 && ci <= sel!.c1;
                  const isFocus = focus?.row === dispRow && focus.col === ci;
                  const num = c.kind === "number";
                  const isEditing = editing?.pos.row === dispRow && editing.pos.col === ci;
                  return (
                    <div
                      key={ci}
                      role="gridcell"
                      aria-selected={inSel}
                      className={cx(
                        "relative flex shrink-0 items-center overflow-hidden border-r border-[var(--border-soft)] px-2",
                        num && "justify-end font-mono text-[0.94em] tabular-nums",
                        (c.kind === "uuid" || c.kind === "binary" || c.kind === "json") && "font-mono text-[0.92em]",
                        changed && ci in changed && "cell-changed",
                        inSel && "bg-[color-mix(in_srgb,var(--accent)_16%,transparent)]",
                        isFocus && "outline outline-[1.5px] -outline-offset-[1.5px] outline-[var(--accent)]",
                      )}
                      style={{ width: widths[ci] }}
                      onMouseDown={(e) => onCellDown(e, { row: dispRow, col: ci })}
                      onMouseEnter={() => dragging.current && setFocus({ row: dispRow, col: ci })}
                      onDoubleClick={() => (editable ? startEdit({ row: dispRow, col: ci }) : props.onOpenValue?.())}
                      onContextMenu={(e) => openMenu(e, { row: dispRow, col: ci })}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          className="absolute inset-0 z-10 bg-[var(--bg-surface)] pl-2 pr-7 font-[inherit] text-[var(--text-main)] outline outline-[1.5px] -outline-offset-[1.5px] outline-[var(--accent)]"
                          value={editing.value}
                          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if ((e.ctrlKey || e.metaKey) && e.code === "KeyG") {
                              e.preventDefault();
                              setEditing({ ...editing, value: suggestGenerator(c).make() });
                            } else if (e.key === "Enter") commitEdit(editing.value, { row: dispRow + 1, col: ci });
                            else if (e.key === "Tab") {
                              e.preventDefault();
                              commitEdit(editing.value, { row: dispRow, col: ci + (e.shiftKey ? -1 : 1) });
                            } else if (e.key === "Escape") {
                              setEditing(null);
                              scrollRef.current?.focus();
                            }
                          }}
                          onBlur={() => editing && commitEdit(editing.value)}
                        />
                      ) : null}
                      {isEditing ? (
                        <button
                          type="button"
                          title="Generate value (Ctrl+G)"
                          aria-label="Generate value"
                          className="absolute right-1 top-1/2 z-20 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-[var(--text-dim)] hover:bg-[var(--hover-bg)] hover:text-[var(--accent)]"
                          onMouseDown={(e) => {
                            // Keep the input's value: commit it, then offer generators for the cell.
                            e.preventDefault();
                            e.stopPropagation();
                            const r = e.currentTarget.getBoundingClientRect();
                            commitEdit(editing!.value);
                            setMenu({ x: r.left, y: r.bottom + 2, items: generateItems(ci) });
                          }}
                        >
                          <WandSparkles size={12} />
                        </button>
                      ) : val === null ? (
                        <span className="cell-null truncate">{nullText}</span>
                      ) : c.kind === "bool" ? (
                        <span className={cx("truncate", /^(t|true|1)$/i.test(val) ? "text-[var(--diff-add)]" : "text-[var(--text-muted)]")}>{val}</span>
                      ) : (
                        <span className="truncate whitespace-pre">{displayText(val)}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        {!order.length && (
          <div className="pointer-events-none absolute inset-x-0 top-[60px] text-center text-[12px] text-[var(--text-dim)]">No rows</div>
        )}
      </div>
      <ContextMenu at={menu ? { x: menu.x, y: menu.y } : null} items={menu?.items ?? []} onClose={() => setMenu(null)} />
    </div>
  );
});
