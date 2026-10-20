import { api, errorKind, errorMessage, isTauri } from "@/lib/api";
import { toast } from "@/store/ui";
import { useWorkspace, type SqlTab } from "@/store/workspace";

const SQL_FILTERS = [
  { name: "SQL scripts", extensions: ["sql"] },
  { name: "All files", extensions: ["*"] },
];

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Opens a .sql file in a new editor. */
export async function openSqlFile() {
  if (!isTauri()) return toast("Opening files is available in the desktop app", "info");
  try {
    const path = await api.pickOpenFile(SQL_FILTERS, "Open SQL script");
    if (!path) return;
    const existing = useWorkspace.getState().tabs.find((t) => t.kind === "sql" && t.filePath === path);
    if (existing) return useWorkspace.getState().activate(existing.id);
    const sql = await api.readTextFile(path);
    useWorkspace.getState().newSql({ title: baseName(path), sql, filePath: path, savedSql: sql });
  } catch (e) {
    toast("Could not open the file", "error", errorMessage(e));
  }
}

/** Writes an editor's script to its file (asking for one when it has none or `as`). */
export async function saveSqlTab(tab: SqlTab, as = false): Promise<boolean> {
  if (!isTauri()) {
    toast("Scripts are kept automatically; saving to files is available in the desktop app", "info");
    return false;
  }
  try {
    let path = tab.filePath;
    const pick = () => api.pickSaveFile(tab.filePath ?? `${tab.title.replace(/[\\/:*?"<>|]/g, "_")}.sql`, SQL_FILTERS);
    if (!path || as) {
      path = await pick();
      if (!path) return false;
    }
    try {
      await api.writeTextFile(path, tab.sql);
    } catch (e) {
      // Only files picked in a dialog are writable: ask for this one.
      if (errorKind(e) !== "forbidden") throw e;
      path = await pick();
      if (!path) return false;
      await api.writeTextFile(path, tab.sql);
    }
    useWorkspace.getState().update(tab.id, { filePath: path, savedSql: tab.sql, title: baseName(path) });
    toast(`Saved ${baseName(path)}`, "success");
    return true;
  } catch (e) {
    toast("Could not save the file", "error", errorMessage(e));
    return false;
  }
}
