import {
  Columns3,
  Database,
  Eye,
  Folder,
  FolderOpen,
  Globe,
  KeyRound,
  Layers,
  Layers3,
  Link,
  ListOrdered,
  SquareFunction,
  Table2,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { Driver, ObjectKind } from "@/lib/types";
import { cx } from "@/components";

export const DRIVER_COLOR: Record<Driver, string> = {
  postgres: "#4F7CAC",
  mysql: "#E48E00",
  sqlite: "#3FA0D8",
  mssql: "#CC3A3A",
};

const DRIVER_ABBR: Record<Driver, string> = { postgres: "Pg", mysql: "My", sqlite: "Lt", mssql: "Ms" };

/** Small rounded badge with the driver's initials. */
export function DriverBadge({ driver, size = 16, className }: { driver: Driver; size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cx("inline-flex shrink-0 items-center justify-center rounded-[5px] font-semibold leading-none text-white", className)}
      style={{ width: size, height: size, background: DRIVER_COLOR[driver], fontSize: Math.round(size * 0.5) }}
    >
      {DRIVER_ABBR[driver]}
    </span>
  );
}

export const OBJECT_ICON: Record<ObjectKind, LucideIcon> = {
  table: Table2,
  view: Eye,
  matview: Layers3,
  foreign: Globe,
  function: SquareFunction,
  procedure: Workflow,
  sequence: ListOrdered,
  trigger: Zap,
};

const OBJECT_TINT: Partial<Record<ObjectKind, string>> = {
  table: "text-[var(--accent)]",
  view: "text-[var(--diff-add)]",
  matview: "text-[var(--diff-add)]",
  function: "text-amber-500",
  procedure: "text-amber-500",
  trigger: "text-[var(--diff-del)]",
};

export function ObjectIcon({ kind, size = 14 }: { kind: ObjectKind; size?: number }) {
  const Icon = OBJECT_ICON[kind];
  return <Icon size={size} strokeWidth={1.6} className={cx("shrink-0", OBJECT_TINT[kind] ?? "text-[var(--text-muted)]")} />;
}

export function FolderIcon({ open, size = 14 }: { open: boolean; size?: number }) {
  const Icon = open ? FolderOpen : Folder;
  return <Icon size={size} strokeWidth={1.6} className="shrink-0 text-[var(--text-dim)]" />;
}

export function DatabaseIcon({ size = 14, dim }: { size?: number; dim?: boolean }) {
  return <Database size={size} strokeWidth={1.6} className={cx("shrink-0", dim ? "text-[var(--text-dim)]" : "text-[var(--text-muted)]")} />;
}

export function SchemaIcon({ size = 14, dim }: { size?: number; dim?: boolean }) {
  return <Layers size={size} strokeWidth={1.6} className={cx("shrink-0", dim ? "text-[var(--text-dim)]" : "text-[var(--text-muted)]")} />;
}

export function ColumnIcon({ pk, fk, size = 13 }: { pk?: boolean; fk?: boolean; size?: number }) {
  if (pk) return <KeyRound size={size} strokeWidth={1.8} className="shrink-0 text-amber-500" />;
  if (fk) return <Link size={size} strokeWidth={1.8} className="shrink-0 text-[var(--accent)]" />;
  return <Columns3 size={size} strokeWidth={1.6} className="shrink-0 text-[var(--text-dim)]" />;
}
