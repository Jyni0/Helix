import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDownToLine, Copy, Minus, Square, X } from "lucide-react";
import { isTauri } from "@/lib/api";
import { isMac, shortcutLabel } from "@/lib/platform";
import { COMMANDS, MENUS, quitApp } from "@/app/commands";
import { openUpdateDialog, useUpdateAvailable, useUpdates } from "@/store/updates";
import { cx } from "@/components";

async function win() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

/** Shown while a newer release is on GitHub; shows the download while it runs (Nox Code's). */
function UpdateButton() {
  const available = useUpdateAvailable();
  const version = useUpdates((s) => s.info?.version);
  const status = useUpdates((s) => s.status);
  const progress = useUpdates((s) => s.progress);
  const pct = progress?.total ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : null;
  const label =
    status === "downloading" ? `Downloading${pct !== null ? ` ${pct}%` : "…"}` : status === "installing" ? "Installing…" : `Update${version ? ` · ${version}` : ""}`;
  return (
    <AnimatePresence>
      {available && (
        <motion.button
          type="button"
          data-testid="update-button"
          title={status === "available" ? `Helix ${version} is available — click to install` : label}
          className="mr-2 flex h-[24px] items-center gap-1.5 rounded-lg bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] px-2.5 text-[12px] font-medium text-[var(--accent)] transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_26%,transparent)]"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={{ duration: 0.15 }}
          onClick={() => status === "available" && openUpdateDialog()}
        >
          <ArrowDownToLine size={13} strokeWidth={2} className={cx(status === "downloading" && "animate-bounce")} />
          {label}
        </motion.button>
      )}
    </AnimatePresence>
  );
}

/** The helix mark (the app icon's strands). */
export function HelixMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden>
      <defs>
        <linearGradient id="hx" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#14b8a6" />
          <stop offset="1" stopColor="#0e5f8a" />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="240" fill="url(#hx)" />
      <g stroke="#fff" strokeLinecap="round" opacity="0.62" strokeWidth="34">
        <path d="M391 282H633M412 442H612M380 512H644M412 582H612M391 742H633" />
      </g>
      <g fill="none" stroke="#fff" strokeWidth="64" strokeLinecap="round">
        <path d="M362 232C362 372 662 372 662 512S362 652 362 792" />
        <path d="M662 232C662 372 362 372 362 512S662 652 662 792" />
      </g>
    </svg>
  );
}

/**
 * The window's own title bar (the native frame is off): app name, menus with
 * their shortcuts, the update button and the window buttons. On macOS the
 * native traffic lights sit on the left instead of our buttons.
 */
export function TitleBar() {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let off: (() => void) | undefined;
    void win().then(async (w) => {
      setMaximized(await w.isMaximized());
      off = await w.onResized(() => void w.isMaximized().then(setMaximized));
    });
    return () => off?.();
  }, []);

  useEffect(() => {
    if (!openMenu) return;
    const close = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpenMenu(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [openMenu]);

  const minimize = () => isTauri() && void win().then((w) => w.minimize());
  const toggleMax = () => isTauri() && void win().then((w) => w.toggleMaximize());

  const WIN_BTN =
    "flex w-[54px] items-center justify-center text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]";

  return (
    <div ref={barRef} data-tauri-drag-region className="flex h-[34px] shrink-0 select-none items-center bg-[var(--bg-titlebar)]">
      {/* Left: app menu */}
      <div className={`flex h-full items-center gap-1 ${isMac && isTauri() ? "pl-[78px]" : "pl-3"}`} data-tauri-drag-region>
        <span className="mr-0.5 bg-[var(--text-muted)] bg-clip-text px-2 text-[13px] font-semibold tracking-wide text-transparent" data-tauri-drag-region>
          Helix
        </span>
        {Object.keys(MENUS).map((m) => (
          <div key={m} className="relative flex h-full items-center">
            <button
              type="button"
              className={`mr-0.5 rounded-md px-2.5 py-1 text-[13px] transition-colors ${
                openMenu === m
                  ? "bg-[var(--hover-bg)] text-[var(--text-main)]"
                  : "text-[var(--text-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
              }`}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setOpenMenu(openMenu === m ? null : m);
              }}
              onMouseEnter={() => openMenu && setOpenMenu(m)}
            >
              {m}
            </button>
            <AnimatePresence>
              {openMenu === m && (
                <motion.div
                  role="menu"
                  className="absolute left-0 top-[calc(100%+4px)] z-[300] flex min-w-[250px] flex-col gap-0.5 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-1 shadow-[var(--shadow-popup)]"
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.12 }}
                >
                  {MENUS[m].map((id, i) => {
                    if (id === "-") return <div key={`sep-${i}`} className="mx-1.5 my-0.5 h-px bg-[var(--border)]" />;
                    const cmd = COMMANDS.find((c) => c.id === id)!;
                    const disabled = cmd.enabled ? !cmd.enabled() : false;
                    return (
                      <button
                        key={id}
                        type="button"
                        role="menuitem"
                        disabled={disabled}
                        className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-[var(--text-main)] transition-colors hover:bg-[var(--hover-bg)] disabled:opacity-40 disabled:hover:bg-transparent"
                        onClick={() => {
                          setOpenMenu(null);
                          cmd.run();
                        }}
                      >
                        <span className="flex-1">{cmd.label}</span>
                        {cmd.shortcut && <span className="pl-4 text-[11px] text-[var(--text-dim)]">{shortcutLabel(cmd.shortcut)}</span>}
                      </button>
                    );
                  })}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ))}
      </div>

      {/* Center: drag region */}
      <div className="h-full flex-1" data-tauri-drag-region />

      <UpdateButton />

      {/* Right: window controls — 54px wide, full height (macOS has its own) */}
      {!(isMac && isTauri()) && (
        <div className="flex h-full items-stretch">
          <button type="button" className={WIN_BTN} onClick={minimize} title="Minimize">
            <Minus size={15} strokeWidth={1} />
          </button>
          <button type="button" className={WIN_BTN} onClick={toggleMax} title={maximized ? "Restore" : "Maximize"}>
            {maximized ? <Copy size={13} strokeWidth={1} /> : <Square size={13} strokeWidth={1} />}
          </button>
          <button
            type="button"
            className="flex w-[54px] items-center justify-center text-[var(--text-muted)] transition-colors hover:bg-[#E81123] hover:text-white"
            onClick={() => void quitApp()}
            title="Close"
          >
            <X size={15} strokeWidth={1.2} />
          </button>
        </div>
      )}
    </div>
  );
}
