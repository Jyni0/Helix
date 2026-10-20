import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "@/App";
import { setApi } from "@/lib/api";
import { createMockBackend } from "@/lib/mockBackend";
import { useConnections } from "@/store/connections";
import { useEditors } from "@/store/editors";
import { useWorkspace } from "@/store/workspace";
import { useHistory } from "@/store/history";
import { ResultGrid } from "@/components/grid/ResultGrid";
import { emptyEdits } from "@/components/grid/edits";

function reset(demo = true) {
  setApi(createMockBackend({ demo }));
  useConnections.setState({ connections: [], loaded: false, status: {}, servers: {}, editing: null, children: {}, expanded: {}, objects: {}, filter: "", selectedKey: null });
  useWorkspace.setState({ tabs: [], activeId: null, counter: 0, closed: [] });
  useEditors.setState({ editors: {} });
  useHistory.setState({ entries: [] });
}

describe("app", () => {
  beforeEach(() => reset());

  it("lists saved connections in the navigator", async () => {
    render(<App />);
    expect(await screen.findByText("Shop — production")).toBeInTheDocument();
    expect(screen.getByText("Analytics")).toBeInTheDocument();
    expect(screen.getByText("PROD")).toBeInTheDocument();
  });

  it("connecting expands databases, schemas and tables", async () => {
    render(<App />);
    await screen.findByText("Shop — production");
    const st = useConnections.getState();
    await act(() => st.toggle({ key: "c:demo-pg", type: "connection", label: "", connId: "demo-pg" }, true));
    expect(useConnections.getState().status["demo-pg"]).toBe("connected");
    await act(() => st.toggle({ key: "c:demo-pg/d:shop", type: "database", label: "shop", connId: "demo-pg", database: "shop" }, true));
    expect(screen.getByText("public")).toBeInTheDocument();
    expect(screen.queryByText("pg_catalog")).not.toBeInTheDocument();
  });

  it("runs a statement in a SQL editor and shows the result and history", async () => {
    render(<App />);
    await screen.findByText("Shop — production");
    let tabId = "";
    act(() => {
      tabId = useWorkspace.getState().newSql({ connectionId: "demo-pg", database: "shop", schema: "public" });
    });
    await act(() => useEditors.getState().run(tabId, { connectionId: "demo-pg", database: "shop", schema: "public" }, ["select * from customers where country = 'Japan'"]));
    const rt = useEditors.getState().editors[tabId];
    expect(rt.results).toHaveLength(1);
    expect(rt.results[0].rows.every((r) => r[3] === "Japan")).toBe(true);
    expect(rt.results[0].source?.name).toBe("customers");
    expect(useHistory.getState().entries[0].sql).toContain("Japan");
    await waitFor(() => expect(screen.getAllByTestId("result-tab")).toHaveLength(1));
  });

  it("asks before UPDATE without WHERE", async () => {
    render(<App />);
    await screen.findByText("Shop — production");
    let tabId = "";
    act(() => {
      tabId = useWorkspace.getState().newSql({ connectionId: "demo-my", database: "shop" });
    });
    let done: Promise<void> | undefined;
    act(() => {
      done = useEditors.getState().run(tabId, { connectionId: "demo-my", database: "shop", schema: null }, ["update customers set active = false"]);
    });
    expect(await screen.findByText("Change every row?")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Cancel"));
    await act(() => done!);
    expect(useEditors.getState().editors[tabId]?.results ?? []).toHaveLength(0);
  });

  it("a SQL error becomes an error result", async () => {
    render(<App />);
    await screen.findByText("Analytics");
    let tabId = "";
    act(() => {
      tabId = useWorkspace.getState().newSql({ connectionId: "demo-my", database: "shop" });
    });
    await act(() => useEditors.getState().run(tabId, { connectionId: "demo-my", database: "shop", schema: null }, ["select nope from customers"]));
    expect(useEditors.getState().editors[tabId].results[0].error).toMatch(/column/);
  });

  it("saves a new connection from the dialog", async () => {
    reset(false);
    render(<App />);
    fireEvent.click(await screen.findByTestId("new-connection"));
    fireEvent.click(screen.getByTestId("driver-sqlite"));
    fireEvent.change(screen.getByPlaceholderText("C:\\data\\app.db"), { target: { value: "C:/x/app.db" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(useConnections.getState().connections).toHaveLength(1));
    expect(useConnections.getState().connections[0]).toMatchObject({ driver: "sqlite", name: "app.db", filePath: "C:/x/app.db" });
  });
});

describe("ResultGrid", () => {
  const columns = [
    { name: "id", typeName: "int4", kind: "number" as const },
    { name: "name", typeName: "text", kind: "text" as const },
  ];
  const rows = [
    ["2", "b"],
    ["1", null],
  ];

  it("shows NULL text and sorts on header click", () => {
    render(<ResultGrid columns={columns} rows={rows} nullText="[NULL]" />);
    expect(screen.getByText("[NULL]")).toBeInTheDocument();
    const firstId = () => screen.getAllByRole("row")[0].querySelectorAll("[role=gridcell]")[0].textContent;
    expect(firstId()).toBe("2");
    fireEvent.click(screen.getAllByRole("columnheader")[0]);
    expect(firstId()).toBe("1");
  });

  it("edits a cell inline", () => {
    let edits = emptyEdits();
    const { rerender } = render(<ResultGrid columns={columns} rows={rows} nullText="[NULL]" editable edits={edits} onEditsChange={(e) => (edits = e)} />);
    fireEvent.doubleClick(screen.getAllByRole("gridcell")[1]);
    const input = screen.getByDisplayValue("b");
    fireEvent.change(input, { target: { value: "bee" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(edits.updated).toEqual({ 0: { 1: "bee" } });
    rerender(<ResultGrid columns={columns} rows={rows} nullText="[NULL]" editable edits={edits} onEditsChange={(e) => (edits = e)} />);
    expect(screen.getByText("bee")).toBeInTheDocument();
  });
});
