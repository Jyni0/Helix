/**
 * Every command of the app: title-bar menus show them, the global key
 * handler runs them by shortcut, the shortcuts page lists them.
 */
import { api, errorMessage, isTauri } from "@/lib/api";
import { useConnections } from "@/store/connections";
import { openTransactions } from "@/store/editors";
import { toast, useUi } from "@/store/ui";
import { useUpdates } from "@/store/updates";
import { useWorkspace } from "@/store/workspace";
import { editorActions } from "./actions";
import { openSqlFile } from "./files";

export interface Command {
  id: string;
  label: string;
  /** "Ctrl+Shift+F", "Alt+X", "F5"… (Ctrl = ⌘ on macOS). */
  shortcut?: string;
  category: string;
  run(): void;
  enabled?(): boolean;
}

/** The connection the user is working with: the active tab's, else the navigator selection. */
export function currentConnectionId(): string | null {
  const tab = useWorkspace.getState().active();
  if (tab && "connectionId" in tab && tab.connectionId) return tab.connectionId;
  const sel = useConnections.getState().selectedKey;
  const m = sel && /^c:([^/]+)/.exec(sel);
  return m ? m[1] : null;
}

async function win() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

async function toggleFullscreen() {
  if (!isTauri()) {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
    return;
  }
  const w = await win();
  await w.setFullscreen(!(await w.isFullscreen()));
}

export async function quitApp() {
  const open = openTransactions();
  if (open) {
    const ans = await useUi.getState().ask({
      title: "Quit with open transactions?",
      message: `${open === 1 ? "An editor has" : `${open} editors have`} uncommitted changes. They are rolled back when Helix quits.`,
      buttons: [
        { id: "quit", label: "Roll back & Quit", variant: "danger" },
        { id: "cancel", label: "Cancel" },
      ],
      cancelId: "cancel",
    });
    if (ans !== "quit") return;
  }
  await api.quit();
}

function newEditorForCurrent() {
  const id = currentConnectionId();
  const c = id ? useConnections.getState().get(id) : undefined;
  const server = id ? useConnections.getState().servers[id] : undefined;
  useWorkspace.getState().newSql(c ? { connectionId: c.id, database: server?.database ?? (c.database || null) } : {});
}

const active = () => useWorkspace.getState().active();
const sqlActive = () => active()?.kind === "sql";
const withConn = (fn: (id: string) => void) => () => {
  const id = currentConnectionId();
  if (id) fn(id);
  else toast("Select a connection first", "warning");
};

export const COMMANDS: Command[] = [
  // File
  { id: "conn.new", label: "New Connection…", shortcut: "Ctrl+Shift+N", category: "File", run: () => useConnections.getState().openEditor() },
  { id: "sql.new", label: "New SQL Editor", shortcut: "Ctrl+]", category: "File", run: newEditorForCurrent },
  { id: "file.open", label: "Open SQL File…", shortcut: "Ctrl+O", category: "File", run: () => void openSqlFile() },
  { id: "file.save", label: "Save Script", shortcut: "Ctrl+S", category: "File", enabled: sqlActive, run: () => editorActions(useWorkspace.getState().activeId)?.save() },
  { id: "file.saveAs", label: "Save Script As…", shortcut: "Ctrl+Shift+S", category: "File", enabled: sqlActive, run: () => editorActions(useWorkspace.getState().activeId)?.save(true) },
  {
    id: "tab.close",
    label: "Close Tab",
    shortcut: "Ctrl+W",
    category: "File",
    enabled: () => !!active(),
    run: () => {
      const id = useWorkspace.getState().activeId;
      if (id) useWorkspace.getState().close(id);
    },
  },
  { id: "tab.reopen", label: "Reopen Closed Tab", shortcut: "Ctrl+Shift+T", category: "File", run: () => useWorkspace.getState().reopenClosed() },
  { id: "settings", label: "Settings", shortcut: "Ctrl+,", category: "File", run: () => useUi.getState().openSettings() },
  { id: "app.quit", label: "Quit Helix", shortcut: "Ctrl+Q", category: "File", run: () => void quitApp() },

  // SQL editor
  { id: "sql.run", label: "Execute Statement", shortcut: "Ctrl+Enter", category: "Query", enabled: sqlActive, run: () => editorActions(useWorkspace.getState().activeId)?.runStatement() },
  { id: "sql.script", label: "Execute Script", shortcut: "Alt+X", category: "Query", enabled: sqlActive, run: () => editorActions(useWorkspace.getState().activeId)?.runScript() },
  { id: "sql.explain", label: "Explain Execution Plan", shortcut: "Ctrl+Shift+E", category: "Query", enabled: sqlActive, run: () => editorActions(useWorkspace.getState().activeId)?.explain() },
  { id: "sql.cancel", label: "Cancel Query", shortcut: "Ctrl+Shift+Q", category: "Query", enabled: sqlActive, run: () => editorActions(useWorkspace.getState().activeId)?.cancel() },
  { id: "sql.format", label: "Format SQL", shortcut: "Ctrl+Shift+F", category: "Query", enabled: sqlActive, run: () => editorActions(useWorkspace.getState().activeId)?.format() },
  { id: "history", label: "Query History", shortcut: "Ctrl+H", category: "Query", run: () => useWorkspace.getState().openHistory() },

  // Database
  {
    id: "db.connect",
    label: "Connect",
    category: "Database",
    run: withConn((id) => void useConnections.getState().ensureConnected(id)),
  },
  { id: "db.disconnect", label: "Disconnect", category: "Database", run: withConn((id) => void useConnections.getState().disconnect(id)) },
  { id: "db.reconnect", label: "Reconnect", category: "Database", run: withConn((id) => void useConnections.getState().reconnect(id)) },
  {
    id: "db.edit",
    label: "Edit Connection…",
    shortcut: "F4",
    category: "Database",
    run: withConn((id) => {
      const c = useConnections.getState().get(id);
      if (c) {
        const { hasPassword: _h, connected: _c, ...config } = c;
        useConnections.getState().openEditor(config);
      }
    }),
  },
  {
    id: "db.sessions",
    label: "Server Sessions",
    category: "Database",
    run: withConn((id) => {
      const c = useConnections.getState().get(id);
      if (c?.driver === "sqlite") return toast("SQLite has no server sessions", "info");
      if (c) useWorkspace.getState().openSessions(c.id, c.name);
    }),
  },
  {
    id: "db.disconnectAll",
    label: "Disconnect All",
    category: "Database",
    run: () => {
      const st = useConnections.getState();
      for (const [id, s] of Object.entries(st.status)) if (s === "connected") void st.disconnect(id);
    },
  },

  // View
  { id: "view.sidebar", label: "Toggle Navigator", shortcut: "Ctrl+B", category: "View", run: () => useUi.getState().setPref("sidebarHidden", !useUi.getState().prefs.sidebarHidden) },
  {
    id: "view.refresh",
    label: "Refresh Navigator",
    shortcut: "F5",
    category: "View",
    run: () => {
      const st = useConnections.getState();
      for (const c of st.connections) if (st.status[c.id] === "connected") void st.refresh({ key: `c:${c.id}`, type: "connection", label: c.name, connId: c.id });
    },
  },
  { id: "tab.next", label: "Next Tab", shortcut: "Ctrl+Tab", category: "View", run: () => useWorkspace.getState().cycle(1) },
  { id: "tab.prev", label: "Previous Tab", shortcut: "Ctrl+Shift+Tab", category: "View", run: () => useWorkspace.getState().cycle(-1) },
  { id: "view.fullscreen", label: "Toggle Fullscreen", shortcut: "F11", category: "View", run: () => void toggleFullscreen() },
  { id: "view.reload", label: "Reload Window", category: "View", run: () => location.reload() },

  // Help
  { id: "help.shortcuts", label: "Keyboard Shortcuts", category: "Help", run: () => useUi.getState().openSettings("shortcuts") },
  { id: "help.updates", label: "Check for Updates…", category: "Help", run: () => void useUpdates.getState().check(true) },
  {
    id: "help.releases",
    label: "Release Notes",
    category: "Help",
    run: () => void api.openUrl(`https://github.com/${__REPO__ || "Jyni0/Helix"}/releases`).catch((e) => toast("Could not open the browser", "error", errorMessage(e))),
  },
  { id: "help.about", label: "About Helix", category: "Help", run: () => useUi.getState().openSettings("about") },
];

export const command = (id: string) => COMMANDS.find((c) => c.id === id)!;

/** Title-bar menus: command ids, "-" = separator. */
export const MENUS: Record<string, string[]> = {
  File: ["conn.new", "sql.new", "-", "file.open", "file.save", "file.saveAs", "-", "tab.close", "tab.reopen", "-", "settings", "-", "app.quit"],
  Query: ["sql.run", "sql.script", "sql.explain", "sql.cancel", "-", "sql.format", "-", "history"],
  Database: ["db.connect", "db.disconnect", "db.reconnect", "-", "db.edit", "db.sessions", "-", "db.disconnectAll"],
  View: ["view.sidebar", "view.refresh", "-", "tab.next", "tab.prev", "-", "view.fullscreen", "view.reload"],
  Help: ["help.shortcuts", "-", "help.updates", "help.releases", "-", "help.about"],
};
