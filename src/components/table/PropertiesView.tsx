import { KeyRound, Link } from "lucide-react";
import type { TableInfo } from "@/lib/types";
import { useWorkspace } from "@/store/workspace";
import { SectionHeading, cx } from "@/components";

function Table({ head, rows, mono = [] }: { head: string[]; rows: React.ReactNode[][]; mono?: number[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--border-soft)] bg-[var(--bg-surface)]">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr className="border-b border-[var(--border-soft)] bg-[var(--bg-sidebar)] text-left text-[11.5px] text-[var(--text-dim)]">
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-[var(--border-soft)] last:border-0 hover:bg-[var(--hover-bg)]">
              {r.map((c, j) => (
                <td key={j} className={cx("px-3 py-1.5 align-top text-[var(--text-main)]", mono.includes(j) && "font-mono text-[12px]")}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const dim = (v: React.ReactNode) => <span className="text-[var(--text-dim)]">{v}</span>;

/** Columns, keys, indexes, references, constraints, triggers and properties of a table. */
export function PropertiesView({ info, connectionId, database }: { info: TableInfo; connectionId: string; database: string }) {
  const fkCols = new Set(info.foreignKeys.flatMap((f) => f.columns));
  const openTable = (schema: string | null, name: string) =>
    useWorkspace.getState().openTable({ connectionId, database, schema, name, objectKind: "table" }, "properties");
  const link = (schema: string | null, name: string) => (
    <button type="button" className="text-[var(--accent)] hover:underline" onClick={() => openTable(schema, name)}>
      {schema ? `${schema}.${name}` : name}
    </button>
  );

  return (
    <div className="selectable thin-scroll flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-6 py-5">
      {(info.comment || info.properties.length > 0) && (
        <div className="flex flex-wrap gap-x-8 gap-y-2 rounded-2xl border border-[var(--border-soft)] bg-[var(--bg-surface)] px-4 py-3">
          {info.comment && (
            <div className="w-full text-[12.5px] text-[var(--text-muted)]">
              <span className="text-[var(--text-dim)]">Comment: </span>
              {info.comment}
            </div>
          )}
          {info.properties.map(([k, v]) => (
            <div key={k} className="flex flex-col">
              <span className="text-[11px] text-[var(--text-dim)]">{k}</span>
              <span className="text-[12.5px] text-[var(--text-main)]">{v}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <SectionHeading>Columns · {info.columns.length}</SectionHeading>
        <Table
          head={["#", "Name", "Type", "Not null", "Default", "Comment"]}
          mono={[2, 4]}
          rows={info.columns.map((c, i) => [
            dim(i + 1),
            <span className="flex items-center gap-1.5">
              {c.primaryKey ? <KeyRound size={12} className="text-amber-500" /> : fkCols.has(c.name) ? <Link size={12} className="text-[var(--accent)]" /> : <span className="w-3" />}
              <span className="font-medium">{c.name}</span>
              {c.autoIncrement && <span className="rounded bg-[var(--hover-bg)] px-1 text-[10px] text-[var(--text-dim)]">auto</span>}
            </span>,
            c.dataType,
            c.nullable ? "" : <span className="text-[var(--text-muted)]">✓</span>,
            c.defaultValue ?? "",
            c.comment ? <span className="text-[var(--text-muted)]">{c.comment}</span> : "",
          ])}
        />
      </div>

      {info.indexes.length > 0 && (
        <div className="flex flex-col gap-2">
          <SectionHeading>Indexes · {info.indexes.length}</SectionHeading>
          <Table
            head={["Name", "Columns", "Unique", "Type"]}
            mono={[1]}
            rows={info.indexes.map((x) => [
              <span className="flex items-center gap-1.5">
                {x.primary && <KeyRound size={12} className="text-amber-500" />}
                {x.name}
              </span>,
              x.columns.join(", "),
              x.unique ? "✓" : "",
              dim(x.method ?? ""),
            ])}
          />
        </div>
      )}

      {info.foreignKeys.length > 0 && (
        <div className="flex flex-col gap-2">
          <SectionHeading>Foreign keys · {info.foreignKeys.length}</SectionHeading>
          <Table
            head={["Name", "Columns", "References", "On update", "On delete"]}
            mono={[1]}
            rows={info.foreignKeys.map((f) => [
              f.name,
              f.columns.join(", "),
              <span>
                {link(f.refSchema, f.refTable)} <span className="font-mono text-[12px] text-[var(--text-muted)]">({f.refColumns.join(", ")})</span>
              </span>,
              dim(f.onUpdate ?? ""),
              dim(f.onDelete ?? ""),
            ])}
          />
        </div>
      )}

      {info.references.length > 0 && (
        <div className="flex flex-col gap-2">
          <SectionHeading>Referenced by · {info.references.length}</SectionHeading>
          <Table
            head={["Table", "Columns", "Constraint"]}
            mono={[1]}
            rows={info.references.map((r) => [link(r.schema, r.table), `${r.columns.join(", ")} → ${r.refColumns.join(", ")}`, dim(r.name)])}
          />
        </div>
      )}

      {info.constraints.length > 0 && (
        <div className="flex flex-col gap-2">
          <SectionHeading>Constraints · {info.constraints.length}</SectionHeading>
          <Table head={["Name", "Kind", "Definition"]} mono={[2]} rows={info.constraints.map((c) => [c.name, dim(c.kind), c.definition])} />
        </div>
      )}

      {info.triggers.length > 0 && (
        <div className="flex flex-col gap-2">
          <SectionHeading>Triggers · {info.triggers.length}</SectionHeading>
          <Table
            head={["Name", "Event", "Definition"]}
            mono={[2]}
            rows={info.triggers.map((t) => [t.name, dim(t.event ?? ""), <span className="line-clamp-3 whitespace-pre-wrap">{t.definition ?? ""}</span>])}
          />
        </div>
      )}
    </div>
  );
}
