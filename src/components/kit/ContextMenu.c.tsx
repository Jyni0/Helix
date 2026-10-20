/**
 * Right-click menu opened at a pointer position (RowMenu's look, but anchored
 * to a point instead of a trigger button). Clamped to the viewport; closes on
 * outside click, Escape, scroll or resize. Items with `items` open a submenu
 * to the side on hover.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import { ChevronRight } from "lucide-react";

export type ContextMenuItem =
  | {
      icon?: React.ReactNode;
      label: string;
      onClick?: () => void;
      danger?: boolean;
      disabled?: boolean;
      /** Right-aligned hint, e.g. a shortcut. */
      hint?: string;
      /** A submenu. */
      items?: ContextMenuItem[];
    }
  | "separator";

const PANEL =
  "flex min-w-[200px] flex-col gap-0.5 rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-1.5 shadow-[var(--shadow-popup)]";

function MenuList({ items, onClose }: { items: ContextMenuItem[]; onClose: () => void }) {
  const [sub, setSub] = useState<number | null>(null);
  const [flip, setFlip] = useState(false);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  return (
    <>
      {items.map((it, i) =>
        it === "separator" ? (
          <div key={"sep" + i} className="my-0.5 h-px bg-[var(--border-soft,var(--border))]" />
        ) : (
          <div
            key={it.label}
            ref={(el) => (rowRefs.current[i] = el)}
            className="relative"
            onMouseEnter={() => {
              if (!it.items) return setSub(null);
              const r = rowRefs.current[i]?.getBoundingClientRect();
              setFlip(!!r && r.right + 220 > window.innerWidth);
              setSub(i);
            }}
          >
            <button
              disabled={it.disabled}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-[var(--hover-bg)] disabled:pointer-events-none disabled:opacity-40 ${
                it.danger ? "text-[var(--diff-del)]" : "text-[var(--text-main)]"
              } ${sub === i ? "bg-[var(--hover-bg)]" : ""}`}
              onClick={() => {
                if (it.items) return setSub(i);
                onClose();
                it.onClick?.();
              }}
            >
              <span className="flex w-4 shrink-0 justify-center">{it.icon}</span>
              <span className="flex-1 whitespace-nowrap">{it.label}</span>
              {it.hint && <span className="pl-3 text-[11px] text-[var(--text-dim)]">{it.hint}</span>}
              {it.items && <ChevronRight size={12} className="text-[var(--text-dim)]" />}
            </button>
            {it.items && sub === i && (
              <div className={`absolute top-[-6px] z-10 ${flip ? "right-[calc(100%+4px)]" : "left-[calc(100%+4px)]"} ${PANEL}`}>
                <MenuList items={it.items} onClose={onClose} />
              </div>
            )}
          </div>
        ),
      )}
    </>
  );
}

export function ContextMenu({
  at,
  items,
  onClose,
}: {
  /** Client coordinates of the click; null = closed. */
  at: { x: number; y: number } | null;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (!at) return;
    const w = ref.current?.offsetWidth ?? 200;
    const h = ref.current?.offsetHeight ?? items.length * 30;
    setPos({
      left: Math.max(8, Math.min(at.x, window.innerWidth - w - 8)),
      top: Math.max(8, at.y + h > window.innerHeight - 8 ? at.y - h : at.y),
    });
  }, [at, items.length]);

  useEffect(() => {
    if (!at) return;
    const close = () => onCloseRef.current();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [at]);

  return createPortal(
    <AnimatePresence>
      {at && (
        <motion.div
          ref={ref}
          role="menu"
          style={{ position: "fixed", top: pos.top, left: pos.left }}
          className={`z-[600] ${PANEL}`}
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.97 }}
          transition={{ duration: 0.1, ease: "easeOut" }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <MenuList items={items} onClose={onClose} />
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
