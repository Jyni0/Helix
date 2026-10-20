import type { Cell, ColumnInfo, Driver } from "./types";
import { ident, literal } from "./sql/dialect";

export type CopyFormat = "tsv" | "csv" | "json" | "sql" | "markdown" | "values";

function csvField(v: Cell, delim: string): string {
  if (v === null) return "";
  return v.includes(delim) || v.includes('"') || v.includes("\n") || v.includes("\r") ? `"${v.replace(/"/g, '""')}"` : v;
}

function jsonValue(v: Cell, kind: ColumnInfo["kind"]): unknown {
  if (v === null) return null;
  // Numbers beyond 2^53 stay strings: JSON readers would lose digits.
  if (kind === "number" && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v) && Math.abs(Number(v)) < 2 ** 53) return Number(v);
  if (kind === "bool") {
    if (/^(t|true|1)$/i.test(v)) return true;
    if (/^(f|false|0)$/i.test(v)) return false;
  }
  if (kind === "json") {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

/** Rows (already cut to the selected columns) as clipboard text. */
export function formatRows(
  format: CopyFormat,
  columns: ColumnInfo[],
  rows: Cell[][],
  opts: { header?: boolean; driver?: Driver; table?: string; nullText?: string } = {},
): string {
  const header = opts.header ?? true;
  switch (format) {
    case "tsv": {
      const lines = rows.map((r) => r.map((v) => (v === null ? (opts.nullText ?? "") : v.replace(/[\t\n\r]+/g, " "))).join("\t"));
      return (header ? [columns.map((c) => c.name).join("\t"), ...lines] : lines).join("\n");
    }
    case "values":
      return rows.map((r) => r.map((v) => v ?? "").join("\t")).join("\n");
    case "csv": {
      const lines = rows.map((r) => r.map((v) => csvField(v, ",")).join(","));
      return (header ? [columns.map((c) => csvField(c.name, ",")).join(","), ...lines] : lines).join("\n");
    }
    case "json":
      return JSON.stringify(
        rows.map((r) => Object.fromEntries(columns.map((c, i) => [c.name, jsonValue(r[i], c.kind)]))),
        null,
        2,
      );
    case "markdown": {
      const esc = (v: string) => v.replace(/\|/g, "\\|").replace(/[\n\r]+/g, " ");
      return [
        `| ${columns.map((c) => esc(c.name)).join(" | ")} |`,
        `|${columns.map(() => " --- |").join("")}`,
        ...rows.map((r) => `| ${r.map((v) => (v === null ? "" : esc(v))).join(" | ")} |`),
      ].join("\n");
    }
    case "sql": {
      const driver = opts.driver ?? "postgres";
      const table = opts.table ?? "table_name";
      const cols = columns.map((c) => ident(driver, c.name)).join(", ");
      return rows.map((r) => `INSERT INTO ${table} (${cols}) VALUES (${r.map((v, i) => literal(driver, v, columns[i].kind)).join(", ")});`).join("\n");
    }
  }
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Older WebViews: the execCommand fallback.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

/** Tab-separated clipboard text (Excel / grid paste) → rows. */
export function parseClipboardGrid(text: string): string[][] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n$/, "")
    .split("\n")
    .map((l) => l.split("\t"));
}
