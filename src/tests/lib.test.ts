import { describe, expect, it } from "vitest";
import { splitStatements, statementAt } from "@/lib/sql/split";
import { changeStatements, editableSource, ident, isModifying, isReadOnlyStatement, isUnboundedChange, kindOf, literal, qualified, selectData } from "@/lib/sql/dialect";
import { parseCsv, sniffDelimiter } from "@/lib/csv";
import { formatRows } from "@/lib/copy";
import { formatSql } from "@/lib/sql/format";
import { addRow, deleteRows, emptyEdits, setCell, toChanges } from "@/components/grid/edits";
import { parseUrl } from "@/components/connection/ConnectionDialog";
import { compareVersions, pickAsset, versionOf } from "@/store/updates";
import { redactSecrets } from "@/store/history";

const texts = (sql: string, d: Parameters<typeof splitStatements>[1] = "postgres", blank = true) => splitStatements(sql, d, blank).map((s) => s.text);

describe("splitStatements", () => {
  it("splits on semicolons outside strings and comments", () => {
    expect(texts("select 1; select ';' -- ; \n; select 2")).toEqual(["select 1", "select ';' -- ; \n", "select 2"].map((s) => s.trim()));
  });
  it("keeps dollar-quoted bodies whole", () => {
    const sql = "create function f() returns int as $$ begin; return 1; end; $$ language plpgsql;\nselect f()";
    expect(texts(sql)).toHaveLength(2);
  });
  it("blank lines separate statements unless disabled", () => {
    expect(texts("select 1\n\nselect 2")).toEqual(["select 1", "select 2"]);
    expect(texts("select 1\n\nselect 2", "postgres", false)).toEqual(["select 1\n\nselect 2"]);
  });
  it("understands SQL Server GO and routine bodies", () => {
    expect(texts("create procedure p as begin select 1; select 2; end\nGO\nexec p", "mssql")).toEqual(["create procedure p as begin select 1; select 2; end", "exec p"]);
  });
  it("understands MySQL DELIMITER and trigger bodies", () => {
    const sql = "DELIMITER $$\nCREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN SET NEW.a = 1; END$$\nDELIMITER ;\nselect 1;";
    expect(texts(sql, "mysql")).toEqual(["CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN SET NEW.a = 1; END", "select 1"]);
  });
  it("keeps SQLite trigger bodies whole", () => {
    expect(texts("create trigger t after insert on a begin insert into b values (1); update c set x = 1; end; select 1", "sqlite")).toHaveLength(2);
  });
  it("drops comment-only pieces", () => {
    expect(texts("-- just a note\n;\nselect 1")).toEqual(["select 1"]);
  });
  it("finds the statement under the cursor", () => {
    const doc = "select 1;\nselect 2;\n\nselect 3";
    const st = splitStatements(doc, "postgres");
    expect(statementAt(st, doc.indexOf("2"), doc)?.text).toBe("select 2");
    expect(statementAt(st, doc.indexOf("select 2") + 9, doc)?.text).toBe("select 2");
    expect(statementAt(st, doc.length, doc)?.text).toBe("select 3");
  });
});

describe("dialect", () => {
  it("quotes identifiers only when needed", () => {
    expect(ident("postgres", "users")).toBe("users");
    expect(ident("postgres", "Users")).toBe('"Users"');
    expect(ident("postgres", "order")).toBe('"order"');
    expect(ident("mysql", "my col")).toBe("`my col`");
    expect(ident("mssql", "x]y")).toBe("[x]]y]");
  });
  it("qualifies names per server", () => {
    const t = { database: "shop", schema: "sales", name: "orders" };
    expect(qualified("postgres", t)).toBe("sales.orders");
    expect(qualified("mssql", t, "shop")).toBe("sales.orders");
    expect(qualified("mssql", t, "master")).toBe("shop.sales.orders");
    expect(qualified("mysql", { ...t, schema: null }, "other")).toBe("shop.orders");
    expect(qualified("sqlite", { database: "main", schema: null, name: "t" })).toBe("t");
  });
  it("writes literals by kind", () => {
    expect(literal("postgres", "12.5", "number")).toBe("12.5");
    expect(literal("postgres", "12abc", "number")).toBe("'12abc'");
    expect(literal("mysql", "it's \\", "text")).toBe("'it''s \\\\'");
    expect(literal("mssql", "é", "text")).toBe("N'é'");
    expect(literal("sqlite", "0x01ff", "binary")).toBe("X'01ff'");
    expect(literal("postgres", "0x01ff", "binary")).toBe("'\\x01ff'");
    expect(literal("mssql", "true", "bool")).toBe("1");
    expect(literal("postgres", null, "text")).toBe("NULL");
  });
  it("knows column kinds", () => {
    expect(kindOf("character varying(20)")).toBe("text");
    expect(kindOf("numeric(10,2)")).toBe("number");
    expect(kindOf("tinyint(1)")).toBe("number");
    expect(kindOf("bit")).toBe("bool");
    expect(kindOf("timestamp with time zone")).toBe("date");
    expect(kindOf("int IDENTITY(1,1)")).toBe("number");
  });
  it("builds data queries", () => {
    expect(selectData("postgres", { database: "d", schema: "public", name: "t" }, "a > 1", [{ column: "b", desc: true }])).toBe(
      "SELECT * FROM public.t\nWHERE a > 1\nORDER BY b DESC",
    );
  });
  it("classifies statements", () => {
    expect(isModifying("  -- x\n delete from t")).toBe(true);
    expect(isModifying("select 1")).toBe(false);
    expect(isUnboundedChange("update t set a = 1")).toBe(true);
    expect(isUnboundedChange("update t set a = 'where' where id = 1")).toBe(false);
    expect(isUnboundedChange("delete from t where id = 1")).toBe(false);
    expect(isReadOnlyStatement("with x as (select 1) select * from x")).toBe(true);
    expect(isReadOnlyStatement("insert into t values (1)")).toBe(false);
  });
  it("recognises editable queries", () => {
    expect(editableSource("select * from public.orders where id > 3 order by id")).toEqual({ name: "orders", schema: "public", database: null });
    expect(editableSource('SELECT * FROM "Weird Name";')).toEqual({ name: "Weird Name", schema: null, database: null });
    expect(editableSource("select * from a join b on a.id = b.id")).toBeNull();
    expect(editableSource("select id from t")).toBeNull();
  });
});

describe("grid edits → SQL", () => {
  const base = [
    ["1", "Ada", null],
    ["2", "Linus", "x"],
  ];
  const target = {
    driver: "postgres" as const,
    table: { database: "d", schema: "public", name: "people" },
    columns: [
      { name: "id", kind: "number" as const },
      { name: "name", kind: "text" as const },
      { name: "note", kind: "text" as const },
    ],
    keyColumns: ["id"],
  };
  it("updates, inserts and deletes by key", () => {
    let e = setCell(emptyEdits(), base, 0, 1, "Ada L.");
    e = setCell(e, base, 0, 2, "hi");
    e = deleteRows(e, base, [1]);
    e = addRow(e, 3);
    e = setCell(e, base, 2, 1, "New");
    expect(changeStatements(target, toChanges(e, base))).toEqual([
      "DELETE FROM public.people WHERE id = 2",
      "UPDATE public.people SET name = 'Ada L.', note = 'hi' WHERE id = 1",
      "INSERT INTO public.people (name) VALUES ('New')",
    ]);
  });
  it("setting a cell back to its value drops the change", () => {
    const e = setCell(setCell(emptyEdits(), base, 1, 1, "X"), base, 1, 1, "Linus");
    expect(e.updated).toEqual({});
  });
  it("without a key, matches on all comparable values (NULL-safe)", () => {
    const e = deleteRows(emptyEdits(), base, [0]);
    expect(changeStatements({ ...target, keyColumns: [] }, toChanges(e, base))).toEqual(["DELETE FROM public.people WHERE id = 1 AND name = 'Ada' AND note IS NULL"]);
  });
  it("deleting an inserted row discards it; deleting twice restores", () => {
    let e = addRow(emptyEdits(), 3);
    e = deleteRows(e, base, [2]);
    expect(e.inserted).toHaveLength(0);
    e = deleteRows(deleteRows(e, base, [0]), base, [0]);
    expect(e.deleted).toEqual([]);
  });
});

describe("csv", () => {
  it("parses quotes, doubled quotes and newlines", () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi"""\n"multi\nline",2\n')).toEqual([
      ["a", "b"],
      ["x, y", 'he said "hi"'],
      ["multi\nline", "2"],
    ]);
  });
  it("sniffs the delimiter", () => {
    expect(sniffDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(sniffDelimiter("a\tb\n")).toBe("\t");
  });
});

describe("copy formats", () => {
  const cols = [
    { name: "id", typeName: "int4", kind: "number" as const },
    { name: "note", typeName: "text", kind: "text" as const },
  ];
  const rows = [
    ["1", "a,b"],
    ["2", null],
  ];
  it("csv / tsv / json / sql / markdown", () => {
    expect(formatRows("csv", cols, rows)).toBe('id,note\n1,"a,b"\n2,');
    expect(formatRows("tsv", cols, rows, { header: false })).toBe("1\ta,b\n2\t");
    expect(JSON.parse(formatRows("json", cols, rows))).toEqual([
      { id: 1, note: "a,b" },
      { id: 2, note: null },
    ]);
    expect(formatRows("sql", cols, rows, { driver: "postgres", table: "t" })).toBe("INSERT INTO t (id, note) VALUES (1, 'a,b');\nINSERT INTO t (id, note) VALUES (2, NULL);");
    expect(formatRows("markdown", cols, rows).split("\n")[1]).toBe("| --- | --- |");
  });
});

describe("formatSql", () => {
  it("formats in the dialect", () => {
    expect(formatSql("select a,b from t where x=1", "postgres", { uppercase: true, tabWidth: 2 })).toBe("SELECT\n  a,\n  b\nFROM\n  t\nWHERE\n  x = 1");
  });
});

describe("connection URLs", () => {
  it("parses server URLs", () => {
    expect(parseUrl("postgres://bob:p%40ss@db.local:6543/shop?sslmode=require")).toEqual({
      driver: "postgres",
      host: "db.local",
      port: 6543,
      user: "bob",
      password: "p@ss",
      database: "shop",
      sslMode: "require",
    });
    expect(parseUrl("mysql://root@localhost/app")?.port).toBe(3306);
    expect(parseUrl("sqlite:///C:/data/x.db")).toEqual({ driver: "sqlite", filePath: "C:/data/x.db" });
    expect(parseUrl("not a url")).toBeNull();
  });
});

describe("updates (Nox Code)", () => {
  it("compares versions", () => {
    expect(compareVersions("1.10.0", "1.9.3")).toBe(1);
    expect(compareVersions("v1.0.0", "1.0")).toBe(0);
    expect(versionOf("Release-2.3.1", null)).toBe("2.3.1");
  });
  it("picks the installer for the platform", () => {
    const assets = ["Helix_1.1.0_x64-setup.exe", "Helix_1.1.0_x64_en-US.msi", "Helix_1.1.0_aarch64.dmg", "Helix_1.1.0_x64.dmg", "Helix_1.1.0_amd64.AppImage"].map((name) => ({
      name,
      url: `https://github.com/x/${name}`,
      size: 1,
      digest: null,
    }));
    expect(pickAsset(assets, "windows", "x86_64")?.name).toBe("Helix_1.1.0_x64-setup.exe");
    expect(pickAsset(assets, "macos", "aarch64")?.name).toBe("Helix_1.1.0_aarch64.dmg");
    expect(pickAsset(assets, "linux", "x86_64")?.name).toBe("Helix_1.1.0_amd64.AppImage");
  });
});

describe("history redaction", () => {
  it("masks passwords in statements", () => {
    expect(redactSecrets("CREATE USER bob WITH PASSWORD 'hunter2'")).toBe("CREATE USER bob WITH PASSWORD '••••••'");
    expect(redactSecrets("ALTER USER 'a'@'%' IDENTIFIED BY 's3cr''et'")).toBe("ALTER USER 'a'@'%' IDENTIFIED BY '••••••'");
    expect(redactSecrets("ALTER USER x IDENTIFIED WITH mysql_native_password BY 'p'")).toContain("BY '••••••'");
    expect(redactSecrets("CREATE LOGIN l WITH PASSWORD = N'Str0ng!'")).toBe("CREATE LOGIN l WITH PASSWORD = '••••••'");
    expect(redactSecrets("select 'password' from t")).toBe("select 'password' from t");
  });
});

describe("value generators", () => {
  it("picks a generator from the column", async () => {
    const { suggestGenerator } = await import("@/lib/generate");
    const col = (name: string, typeName: string, kind: import("@/lib/types").ColumnKind) => suggestGenerator({ name, typeName, kind }).id;
    expect(col("id", "uuid", "uuid")).toBe("uuid");
    expect(col("email", "varchar", "text")).toBe("email");
    expect(col("full_name", "text", "text")).toBe("full");
    expect(col("username", "text", "text")).toBe("user");
    expect(col("created_at", "timestamp", "date")).toBe("now");
    expect(col("born", "date", "date")).toBe("date");
    expect(col("price", "numeric", "number")).toBe("decimal");
    expect(col("active", "boolean", "bool")).toBe("bool");
  });
  it("makes well-formed values", async () => {
    const { generatorById } = await import("@/lib/generate");
    expect(generatorById("uuid")!.make()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(generatorById("email")!.make()).toMatch(/^[a-z0-9._]+@[a-z.]+$/);
    expect(generatorById("datetime")!.make()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(generatorById("time")!.make()).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});
