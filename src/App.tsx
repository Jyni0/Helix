import { useEffect } from "react";
import { isTauri } from "@/lib/api";
import { applyTheme } from "@/lib/themes";
import { useGlobalShortcuts } from "@/app/shortcuts";
import { quitApp } from "@/app/commands";
import { useConnections } from "@/store/connections";
import { openTransactions } from "@/store/editors";
import { useUi } from "@/store/ui";
import { startUpdateChecks } from "@/store/updates";
import { cx } from "@/components";
import { TitleBar } from "@/components/layout/TitleBar";
import { Toaster } from "@/components/layout/Toaster";
import { DialogHost } from "@/components/layout/DialogHost";
import { Navigator } from "@/components/navigator/Navigator";
import { Workspace } from "@/components/workspace/Workspace";
import { ConnectionDialog } from "@/components/connection/ConnectionDialog";
import { ExportDialog } from "@/components/dialogs/ExportDialog";
import { ImportDialog } from "@/components/dialogs/ImportDialog";
import { SettingsModal } from "@/components/settings/SettingsModal";

export default function App() {
  const theme = useUi((s) => s.prefs.theme);
  const sidebarHidden = useUi((s) => s.prefs.sidebarHidden);

  useGlobalShortcuts();

  useEffect(() => {
    void useConnections.getState().load();
  }, []);

  useEffect(() => startUpdateChecks(), []);
  useEffect(() => applyTheme(theme), [theme]);

  // Closing the window with open transactions asks first.
  useEffect(() => {
    if (!isTauri()) return;
    let off: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      off = await getCurrentWindow().onCloseRequested((e) => {
        if (openTransactions()) {
          e.preventDefault();
          void quitApp();
        }
      });
    });
    return () => off?.();
  }, []);

  // No context menu of the webview itself (the app draws its own).
  useEffect(() => {
    const block = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest("input, textarea, .cm-editor")) e.preventDefault();
    };
    document.addEventListener("contextmenu", block);
    return () => document.removeEventListener("contextmenu", block);
  }, []);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <TitleBar />
      {/* overflow-hidden: the row never scrolls sideways. */}
      <div className="flex min-h-0 flex-1 overflow-hidden bg-[var(--bg-sidebar)]">
        {!sidebarHidden && <Navigator />}
        <main
          className={cx(
            "flex min-w-0 flex-1 overflow-hidden bg-[var(--bg-app)]",
            // The page sits in the corner between the sidebar and the title
            // bar like a sheet: rounded top-left, a hairline along both edges.
            !sidebarHidden && "rounded-tl-2xl border-l border-t border-[var(--border-soft)]",
          )}
        >
          <Workspace />
        </main>
      </div>
      <ConnectionDialog />
      <ExportDialog />
      <ImportDialog />
      <SettingsModal />
      <DialogHost />
      <Toaster />
    </div>
  );
}
