import type { RowChange } from "@/lib/sql/dialect";
import type { Cell } from "@/lib/types";

/** Pending grid edits over a result's rows (indices into the loaded rows). */
export interface GridEdits {
  /** Changed cells of loaded rows: row → column → new value. */
  updated: Record<number, Record<number, Cell>>;
  /** Loaded rows marked for deletion. */
  deleted: number[];
  /** New rows (displayed after the loaded ones). */
  inserted: Cell[][];
}

export const emptyEdits = (): GridEdits => ({ updated: {}, deleted: [], inserted: [] });

export const hasEdits = (e: GridEdits | undefined): boolean =>
  !!e && (Object.keys(e.updated).length > 0 || e.deleted.length > 0 || e.inserted.length > 0);

export function editCount(e: GridEdits): number {
  return Object.keys(e.updated).length + e.deleted.length + e.inserted.length;
}

/** Sets one cell; `row` counts loaded rows first, then inserted ones. */
export function setCell(e: GridEdits, base: Cell[][], row: number, col: number, value: Cell): GridEdits {
  if (row >= base.length) {
    const inserted = e.inserted.map((r, i) => (i === row - base.length ? r.map((v, c) => (c === col ? value : v)) : r));
    return { ...e, inserted };
  }
  const cur = { ...(e.updated[row] ?? {}) };
  if (base[row][col] === value) delete cur[col];
  else cur[col] = value;
  const updated = { ...e.updated };
  if (Object.keys(cur).length) updated[row] = cur;
  else delete updated[row];
  return { ...e, updated };
}

export function addRow(e: GridEdits, columnCount: number, values?: Cell[]): GridEdits {
  return { ...e, inserted: [...e.inserted, values ? [...values] : Array.from({ length: columnCount }, () => null)] };
}

/** Marks rows deleted (inserted rows simply go away). Toggles back already deleted rows. */
export function deleteRows(e: GridEdits, base: Cell[][], rows: number[]): GridEdits {
  const del = new Set(e.deleted);
  const dropInserted = new Set<number>();
  const allDeleted = rows.filter((r) => r < base.length).every((r) => del.has(r));
  for (const r of rows) {
    if (r >= base.length) dropInserted.add(r - base.length);
    else if (allDeleted) del.delete(r);
    else del.add(r);
  }
  return { ...e, deleted: [...del].sort((a, b) => a - b), inserted: e.inserted.filter((_, i) => !dropInserted.has(i)) };
}

/** The row as shown: loaded values with edits applied. */
export function rowValues(e: GridEdits | undefined, base: Cell[][], row: number): Cell[] {
  if (row >= base.length) return e?.inserted[row - base.length] ?? [];
  const upd = e?.updated[row];
  return upd ? base[row].map((v, c) => (c in upd ? upd[c] : v)) : base[row];
}

/** Edits as INSERT / UPDATE / DELETE changes. */
export function toChanges(e: GridEdits, base: Cell[][], skipInsertColumns: number[] = []): RowChange[] {
  const out: RowChange[] = [];
  for (const r of e.deleted) out.push({ kind: "delete", original: base[r], values: {} });
  for (const [r, cols] of Object.entries(e.updated)) {
    if (e.deleted.includes(+r)) continue;
    out.push({ kind: "update", original: base[+r], values: cols });
  }
  for (const row of e.inserted) {
    const values: Record<number, Cell> = {};
    // Columns left empty in a new row get their default (identity, DEFAULT …).
    row.forEach((v, i) => {
      if (v !== null && !skipInsertColumns.includes(i)) values[i] = v;
    });
    out.push({ kind: "insert", values });
  }
  return out;
}
