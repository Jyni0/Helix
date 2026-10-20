import { cx } from "../cx.u";

export type PillTone = "neutral" | "accent" | "success" | "danger" | "warning";

const PILL: Record<PillTone, string> = {
  neutral: "bg-[var(--hover-bg)] text-[var(--text-muted)]",
  accent: "bg-[var(--accent)]/15 text-[var(--accent)]",
  success: "bg-[var(--diff-add)]/15 text-[var(--diff-add)]",
  danger: "bg-[var(--diff-del)]/15 text-[var(--diff-del)]",
  warning: "bg-amber-500/15 text-amber-500",
};

/** Small status pill (provider, sync error). */
export function Pill({ tone = "neutral", children, className }: { tone?: PillTone; children: React.ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-[10.5px] font-medium", PILL[tone], className)}>
      {children}
    </span>
  );
}

/** Keyboard key hint. */
export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-md bg-[var(--bg-input)] px-1 font-sans text-[10px] text-[var(--text-dim)]">
      {children}
    </kbd>
  );
}
