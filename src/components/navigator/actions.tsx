/** What the navigator's nodes do: open, context menus, DDL operations. */
import {
  Activity,
  Code,
  Copy,
  Download,
  Eye,
  FilePlus2,
  Hash,
  Network,
  Pencil,
  Plug,
  RefreshCw,
  RotateCw,
  SquarePen,
  SquareTerminal,
  Table2,
  TableProperties,
  Trash2,
  Unplug,
  Upload,
  Eraser,
  CopyPlus,
} from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { copyText } from "@/lib/copy";
import { countSql, createTableTemplate, dropSql, generateSql, qualified, renameSql, selectData, truncateSql, type TableRef } from "@/lib/sql/dialect";
import type { ContextMenuItem } from "@/components";
import { findNode, isRelation, tableInfo, useConnections, type TreeNode } from "@/store/connections";
import { useDialogs } from "@/store/dialogs";
import { prefs, toast, useUi } from "@/store/ui";
import { useWorkspace } from "@/store/workspace";

const conns = () => useConnections.getState();

export function refOf(node: TreeNode): TableRef {
  return { database: node.database ?? "", schema: node.schema ?? null, name: node.object?.name ?? node.label };
}

function driverOf(node: TreeNode) {
  return conns().get(node.connId)?.driver ?? "postgres";
}

/** Opens a SQL editor scoped to the node's connection / database / schema. */
export function newEditorFor(node: TreeNode, sql = "", title?: string) {
  const c = conns().get(node.connId);
  if (!c) return;
  const server = conns().servers[node.connId];
  useWorkspace.getState().newSql({
    connectionId: c.id,
    database: node.database ?? server?.database ?? (c.database || null),
    schema: node.schema ?? null,
    sql,
    ...(title ? { title } : {}),
  });
}

/** Double-click / Enter on a node. */
export function openNode(node: TreeNode) {
  const st = conns();
  switch (node.type) {
    case "object": {
      const o = node.object!;
      if (isRelation(o.kind)) {
        useWorkspace.getState().openTable(
          { connectionId: node.connId, database: node.database!, schema: node.schema ?? null, name: o.name, objectKind: o.kind },
          o.kind === "table" ? prefs().openTableView : "data",
        );
      } else {
        useWorkspace.getState().openObject({
          connectionId: node.connId,
          database: node.database!,
          schema: node.schema ?? null,
          name: o.name,
          objectKind: o.kind,
          signature: o.signature,
        });
      }
      break;
    }
    case "column":
      break;
    default:
      void st.toggle(node);
  }
}

/** Runs DDL on the navigator connection after a confirmation; refreshes the parent. */
async function runDdl(node: TreeNode, title: string, sql: string, confirmLabel: string, danger = true) {
  const ans = await useUi.getState().ask({
    title,
    message: <code className="block whitespace-pre-wrap rounded-lg bg-[var(--bg-input)] p-2.5 font-mono text-[12px] text-[var(--text-main)]">{sql}</code>,
    buttons: [
      { id: "ok", label: confirmLabel, variant: danger ? "danger" : "primary" },
      { id: "cancel", label: "Cancel" },
    ],
    cancelId: "cancel",
  });
  if (ans !== "ok") return false;
  try {
    await api.metaQuery(node.connId, node.database ?? "", sql);
    toast("Done", "success", sql);
    const parentKey = node.key.slice(0, node.key.lastIndexOf("/"));
    const parent = findNode(parentKey.slice(0, parentKey.lastIndexOf("/"))) ?? findNode(parentKey);
    if (parent) await conns().refresh(parent);
    return true;
  } catch (e) {
    toast("Statement failed", "error", errorMessage(e));
    return false;
  }
}

async function countRows(node: TreeNode) {
  const driver = driverOf(node);
  try {
    const [r] = await api.metaQuery(node.connId, node.database ?? "", countSql(driver, refOf(node), ""));
    toast(`${node.label}: ${Number(r.rows[0]?.[0] ?? 0).toLocaleString()} rows`, "info");
  } catch (e) {
    toast("Could not count rows", "error", errorMessage(e));
  }
}

async function generate(node: TreeNode, kind: "select" | "insert" | "update" | "delete" | "merge" | "ddl") {
  const driver = driverOf(node);
  try {
    let sql: string;
    if (kind === "ddl") {
      sql = await api.objectDdl(node.connId, node.database ?? "", node.schema ?? null, node.object!.name, node.object!.kind, node.object!.signature);
    } else {
      const info = await tableInfo(node.connId, node.database ?? "", node.schema ?? null, node.object!.name);
      sql = generateSql(driver, kind, refOf(node), info.columns);
    }
    newEditorFor(node, sql, `${node.label} (${kind.toUpperCase()})`);
  } catch (e) {
    toast("Could not generate SQL", "error", errorMessage(e));
  }
}

export function nodeMenu(node: TreeNode): ContextMenuItem[] {
  const st = conns();
  const c = st.get(node.connId);
  if (!c) return [];
  const connected = st.status[node.connId] === "connected";
  const driver = c.driver;
  const refresh: ContextMenuItem = { icon: <RefreshCw size={13} />, label: "Refresh", hint: "F5", onClick: () => void st.refresh(node) };
  const copyName: ContextMenuItem = { icon: <Copy size={13} />, label: "Copy Name", onClick: () => void copyText(node.label) };

  switch (node.type) {
    case "connection":
      return [
        connected
          ? { icon: <Unplug size={13} />, label: "Disconnect", onClick: () => void st.disconnect(c.id) }
          : { icon: <Plug size={13} />, label: "Connect", onClick: () => void st.toggle(node, true) },
        { icon: <RotateCw size={13} />, label: "Reconnect", disabled: !connected, onClick: () => void st.reconnect(c.id) },
        "separator",
        { icon: <SquareTerminal size={13} />, label: "New SQL Editor", hint: "Ctrl+]", onClick: () => newEditorFor(node) },
        ...(driver !== "sqlite"
          ? [{ icon: <Activity size={13} />, label: "Server Sessions", onClick: () => useWorkspace.getState().openSessions(c.id, c.name) } as ContextMenuItem]
          : []),
        "separator",
        {
          icon: <Pencil size={13} />,
          label: "Edit Connection…",
          hint: "F4",
          onClick: () => {
            const { hasPassword: _h, connected: _c, ...config } = c;
            st.openEditor(config);
          },
        },
        { icon: <CopyPlus size={13} />, label: "Duplicate", onClick: () => void st.duplicate(c.id) },
        {
          icon: <Trash2 size={13} />,
          label: "Delete",
          danger: true,
          onClick: async () => {
            const ans = await useUi.getState().ask({
              title: `Delete “${c.name}”?`,
              message: "The connection settings and its saved password are removed. Databases are not touched.",
              buttons: [
                { id: "delete", label: "Delete", variant: "danger" },
                { id: "cancel", label: "Cancel" },
              ],
              cancelId: "cancel",
            });
            if (ans === "delete") await st.remove(c.id).catch((e) => toast("Could not delete", "error", errorMessage(e)));
          },
        },
        "separator",
        refresh,
      ];
    case "database":
    case "schema": {
      const schema = node.schema ?? null;
      return [
        { icon: <SquareTerminal size={13} />, label: "New SQL Editor", onClick: () => newEditorFor(node) },
        ...((node.type === "schema" || driver === "mysql" || driver === "sqlite")
          ? [
              { icon: <Network size={13} />, label: "ER Diagram", onClick: () => useWorkspace.getState().openErd(c.id, node.database!, schema) } as ContextMenuItem,
              {
                icon: <FilePlus2 size={13} />,
                label: "Create Table…",
                onClick: () => newEditorFor(node, createTableTemplate(driver, { database: node.database!, schema: node.schema ?? null, name: "new_table" }), "Create table"),
              } as ContextMenuItem,
            ]
          : []),
        "separator",
        copyName,
        refresh,
      ];
    }
    case "category":
      return [
        ...(node.category === "table"
          ? [
              {
                icon: <FilePlus2 size={13} />,
                label: "Create Table…",
                onClick: () => newEditorFor(node, createTableTemplate(driver, { database: node.database!, schema: node.schema ?? null, name: "new_table" }), "Create table"),
              } as ContextMenuItem,
            ]
          : []),
        refresh,
      ];
    case "object": {
      const o = node.object!;
      const ref = refOf(node);
      if (isRelation(o.kind)) {
        const isTable = o.kind === "table";
        return [
          { icon: <Table2 size={13} />, label: "Read Data", onClick: () => useWorkspace.getState().openTable({ connectionId: c.id, database: node.database!, schema: node.schema ?? null, name: o.name, objectKind: o.kind }, "data") },
          { icon: <TableProperties size={13} />, label: "Properties", onClick: () => useWorkspace.getState().openTable({ connectionId: c.id, database: node.database!, schema: node.schema ?? null, name: o.name, objectKind: o.kind }, "properties") },
          { icon: <Code size={13} />, label: "View DDL", onClick: () => useWorkspace.getState().openTable({ connectionId: c.id, database: node.database!, schema: node.schema ?? null, name: o.name, objectKind: o.kind }, "ddl") },
          "separator",
          {
            icon: <SquarePen size={13} />,
            label: "Generate SQL",
            items: [
              { label: "SELECT", onClick: () => void generate(node, "select") },
              ...(isTable
                ? ([
                    { label: "INSERT", onClick: () => void generate(node, "insert") },
                    { label: "UPDATE", onClick: () => void generate(node, "update") },
                    { label: "DELETE", onClick: () => void generate(node, "delete") },
                    { label: driver === "mssql" ? "MERGE" : "UPSERT", onClick: () => void generate(node, "merge") },
                  ] as ContextMenuItem[])
                : []),
              "separator",
              { label: "DDL", onClick: () => void generate(node, "ddl") },
            ],
          },
          { icon: <SquareTerminal size={13} />, label: "Query in SQL Editor", onClick: () => newEditorFor(node, selectData(driver, ref, "", []) + ";", o.name) },
          "separator",
          {
            icon: <Download size={13} />,
            label: "Export Data…",
            onClick: () => useDialogs.getState().openExport({ connectionId: c.id, database: node.database!, sql: selectData(driver, ref, "", []), name: o.name }),
          },
          ...(isTable
            ? [
                {
                  icon: <Upload size={13} />,
                  label: "Import Data…",
                  disabled: c.readOnly,
                  onClick: () => useDialogs.getState().openImport({ connectionId: c.id, database: node.database!, schema: node.schema ?? null, table: o.name }),
                } as ContextMenuItem,
                { icon: <Hash size={13} />, label: "Count Rows", onClick: () => void countRows(node) } as ContextMenuItem,
              ]
            : []),
          "separator",
          copyName,
          { icon: <Copy size={13} />, label: "Copy Qualified Name", onClick: () => void copyText(qualified(driver, ref)) },
          ...(c.readOnly
            ? []
            : ([
                "separator",
                ...(isTable
                  ? [
                      {
                        icon: <Pencil size={13} />,
                        label: "Rename…",
                        onClick: async () => {
                          const name = await useUi.getState().prompt({ title: `Rename ${o.name}`, label: "New name", value: o.name, okLabel: "Rename" });
                          if (name && name !== o.name) await runDdl(node, "Rename table?", renameSql(driver, ref, name), "Rename", false);
                        },
                      } as ContextMenuItem,
                      { icon: <Eraser size={13} />, label: "Truncate…", danger: true, onClick: () => void runDdl(node, `Delete every row of ${o.name}?`, truncateSql(driver, ref), "Truncate") } as ContextMenuItem,
                    ]
                  : []),
                { icon: <Trash2 size={13} />, label: "Drop…", danger: true, onClick: () => void runDdl(node, `Drop ${o.name}?`, dropSql(driver, o.kind, ref), "Drop") },
              ] as ContextMenuItem[])),
          "separator",
          refresh,
        ];
      }
      return [
        {
          icon: <Eye size={13} />,
          label: "Open Source",
          onClick: () => openNode(node),
        },
        { icon: <SquarePen size={13} />, label: "Open in SQL Editor", onClick: () => void generate(node, "ddl") },
        "separator",
        copyName,
        ...(c.readOnly || o.kind === "trigger"
          ? []
          : ([
              "separator",
              { icon: <Trash2 size={13} />, label: "Drop…", danger: true, onClick: () => void runDdl(node, `Drop ${o.name}?`, dropSql(driver, o.kind, ref, o.signature), "Drop") },
            ] as ContextMenuItem[])),
      ];
    }
    case "column":
      return [copyName];
  }
}
