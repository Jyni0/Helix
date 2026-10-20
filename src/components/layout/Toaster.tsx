import { AnimatePresence, motion } from "motion/react";
import { AlertCircle, CheckCircle2, Info, TriangleAlert, X } from "lucide-react";
import { useUi } from "@/store/ui";
import { cx } from "@/components";

const ICONS = { info: Info, success: CheckCircle2, error: AlertCircle, warning: TriangleAlert };
const COLOR = { info: "text-[var(--accent)]", success: "text-[var(--diff-add)]", error: "text-[var(--diff-del)]", warning: "text-amber-500" };

/** Toasts, bottom center (Trajectory's look; a second line for details). */
export function Toaster() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-9 left-1/2 z-[700] flex -translate-x-1/2 flex-col items-center gap-2" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const Icon = ICONS[t.kind];
          return (
            <motion.div
              key={t.id}
              layout
              data-testid="toast"
              role={t.kind === "error" ? "alert" : "status"}
              initial={{ opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.98 }}
              transition={{ type: "spring", stiffness: 500, damping: 34 }}
              className={cx(
                "pointer-events-auto flex max-w-[520px] items-start gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] py-2 pl-3 pr-1.5 text-[13px] text-[var(--text-main)] shadow-[var(--shadow-popup)]",
              )}
            >
              <Icon size={15} className={cx("mt-[3px] shrink-0", COLOR[t.kind])} />
              <div className="min-w-0 flex-1 py-px">
                <div className="truncate">{t.message}</div>
                {t.detail && <div className="selectable mt-0.5 line-clamp-4 whitespace-pre-wrap break-words text-[12px] text-[var(--text-dim)]">{t.detail}</div>}
              </div>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => dismiss(t.id)}
                className="rounded-lg p-1 text-[var(--text-dim)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
              >
                <X size={13} />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
