import { useEffect, useMemo, useState } from "react";
import { Braces, Copy, CircleSlash, X } from "lucide-react";
import type { Cell, ColumnInfo } from "@/lib/types";
import { copyText } from "@/lib/copy";
import { prettyJson } from "@/lib/format";
import { Button, IconButton, cx } from "@/components";

/** The selected cell in full: long text, pretty JSON, editing. */
export function ValuePanel({
  column,
  value,
  editable,
  onApply,
  onClose,
  nullText,
}: {
  column: ColumnInfo | null;
  value: Cell;
  editable: boolean;
  onApply(v: Cell): void;
  onClose(): void;
  nullText: string;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const [pretty, setPretty] = useState(true);
  useEffect(() => setDraft(value ?? ""), [value, column]);
  const json = useMemo(() => (value !== null ? prettyJson(value) : null), [value]);
  const shown = !editable && pretty && json ? json : null;
  const dirty = editable && draft !== (value ?? "");

  return (
    <div className="flex h-full w-full flex-col border-l border-[var(--border-soft)] bg-[var(--bg-app)]">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--border-soft)] pl-3 pr-1.5">
        <div className="min-w-0 flex-1 truncate text-[12px]">
          <span className="font-medium text-[var(--text-main)]">{column?.name ?? "Value"}</span>
          {column && <span className="ml-1.5 text-[11px] text-[var(--text-dim)]">{column.typeName}</span>}
        </div>
        {json && !editable && (
          <IconButton size="xs" label={pretty ? "Show raw" : "Format JSON"} className={cx(pretty && "text-[var(--accent)]")} onClick={() => setPretty((p) => !p)}>
            <Braces size={13} />
          </IconButton>
        )}
        <IconButton size="xs" label="Copy value" disabled={value === null} onClick={() => void copyText(shown ?? value ?? "")}>
          <Copy size={12.5} />
        </IconButton>
        <IconButton size="xs" label="Close value panel" onClick={onClose}>
          <X size={13} />
        </IconButton>
      </div>
      {!column ? (
        <div className="p-4 text-[12px] text-[var(--text-dim)]">Select a cell to see its value.</div>
      ) : editable ? (
        <>
          <textarea
            aria-label="Cell value"
            className="thin-scroll min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-[12px] leading-relaxed text-[var(--text-main)] outline-none"
            value={draft}
            placeholder={value === null ? nullText : ""}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
          />
          <div className="flex shrink-0 gap-1.5 border-t border-[var(--border-soft)] p-2">
            {json && (
              <Button size="xs" variant="ghost" icon={<Braces size={12} />} onClick={() => setDraft(prettyJson(draft) ?? draft)}>
                Format
              </Button>
            )}
            <Button size="xs" variant="ghost" icon={<CircleSlash size={12} />} onClick={() => onApply(null)}>
              NULL
            </Button>
            <div className="flex-1" />
            <Button size="xs" variant="primary" disabled={!dirty} onClick={() => onApply(draft)}>
              Apply
            </Button>
          </div>
        </>
      ) : value === null ? (
        <div className="cell-null p-3 font-mono text-[12px]">{nullText}</div>
      ) : (
        <pre className="selectable thin-scroll min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-[12px] leading-relaxed text-[var(--text-main)]">
          {shown ?? value}
        </pre>
      )}
    </div>
  );
}

/** One row as a two-column list of field / value (DBeaver's record mode). */
export function RecordView({ columns, row, nullText, onPick }: { columns: ColumnInfo[]; row: Cell[] | null; nullText: string; onPick?(col: number): void }) {
  if (!row) return <div className="p-4 text-[12px] text-[var(--text-dim)]">Select a row to show it as a record.</div>;
  return (
    <div className="thin-scroll selectable min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-[12.5px]">
        <tbody>
          {columns.map((c, i) => (
            <tr key={i} className="border-b border-[var(--border-soft)] hover:bg-[var(--hover-bg)]" onClick={() => onPick?.(i)}>
              <td className="w-[1%] whitespace-nowrap border-r border-[var(--border-soft)] bg-[var(--bg-sidebar)] px-3 py-1.5 align-top">
                <span className="font-medium text-[var(--text-main)]">{c.name}</span>
                <span className="ml-2 text-[11px] text-[var(--text-dim)]">{c.typeName}</span>
              </td>
              <td className={cx("px-3 py-1.5 align-top", c.kind === "number" || c.kind === "json" || c.kind === "uuid" ? "font-mono text-[12px]" : "")}>
                {row[i] === null ? <span className="cell-null">{nullText}</span> : <span className="whitespace-pre-wrap break-all">{row[i]}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
