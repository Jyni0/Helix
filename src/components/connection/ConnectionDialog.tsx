import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronRight, Eye, EyeOff, FolderOpen, Link2, Plug, X } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { api, errorMessage, isTauri } from "@/lib/api";
import { DEFAULT_PORT, DRIVER_LABEL } from "@/lib/sql/dialect";
import type { ConnectionConfig, Driver, Environment, TestReport } from "@/lib/types";
import { blankConnection, useConnections } from "@/store/connections";
import { toast } from "@/store/ui";
import { Button, Combobox, Dialog, Field, IconButton, Input, ScrollArea, SectionHeading, Segmented, Sep, SettingRow, SettingsCard, Spinner, Switch, TextArea, cx } from "@/components";
import { DriverBadge } from "@/components/navigator/icons";

const DRIVERS: { id: Driver; hint: string }[] = [
  { id: "postgres", hint: "PostgreSQL 10+" },
  { id: "mysql", hint: "MySQL 5.7+ · MariaDB" },
  { id: "sqlite", hint: "A database file" },
  { id: "mssql", hint: "SQL Server 2012+ · Azure SQL" },
];
const COLORS = ["#F85149", "#E48E00", "#E3B341", "#3FB950", "#2F81F7", "#A371F7", "#DB61A2", "#8B949E"];
const SSL_OPTIONS = [
  { value: "disable", label: "Disable", hint: "plain" },
  { value: "prefer", label: "Prefer", hint: "TLS if offered" },
  { value: "require", label: "Require", hint: "TLS, any cert" },
  { value: "verify-ca", label: "Verify CA", hint: "trusted cert" },
  { value: "verify-full", label: "Verify full", hint: "cert + host" },
];
const ENV_DOT: Record<Environment, string> = { development: "bg-[var(--diff-add)]", test: "bg-amber-500", production: "bg-[var(--diff-del)]" };

/** postgres://user:pass@host:5432/db, mysql://…, sqlserver://…, sqlite:///path → fields. */
export function parseUrl(url: string): Partial<ConnectionConfig> & { password?: string } | null {
  const m = /^(postgres(?:ql)?|mysql|mariadb|sqlserver|mssql|sqlite):\/\/(.*)$/i.exec(url.trim());
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const driver: Driver = scheme.startsWith("postgres") ? "postgres" : scheme === "mysql" || scheme === "mariadb" ? "mysql" : scheme === "sqlite" ? "sqlite" : "mssql";
  if (driver === "sqlite") return { driver, filePath: decodeURIComponent(m[2].replace(/^\/(?=[A-Za-z]:)/, "")) };
  try {
    const u = new URL(`http://${m[2]}`);
    const params = u.searchParams;
    const ssl = params.get("sslmode") ?? params.get("ssl-mode");
    return {
      driver,
      host: decodeURIComponent(u.hostname),
      port: u.port ? Number(u.port) : DEFAULT_PORT[driver],
      user: decodeURIComponent(u.username),
      password: u.password ? decodeURIComponent(u.password) : undefined,
      database: decodeURIComponent(u.pathname.replace(/^\//, "")) || params.get("database") || "",
      ...(ssl ? { sslMode: ssl.toLowerCase().replace("_", "-") as ConnectionConfig["sslMode"] } : {}),
    };
  } catch {
    return null;
  }
}

function autoName(c: ConnectionConfig): string {
  if (c.driver === "sqlite") return c.filePath.split(/[\\/]/).pop() || "SQLite";
  return [c.database || DRIVER_LABEL[c.driver], c.host].filter(Boolean).join(" @ ");
}

type TestState = { kind: "idle" } | { kind: "running" } | { kind: "ok"; report: TestReport } | { kind: "error"; message: string };

/** New / edit connection — the two-column window of Settings: database on the left, its settings on the right. */
export function ConnectionDialog() {
  const editing = useConnections((s) => s.editing);
  const connections = useConnections((s) => s.connections);
  const folders = useMemo(() => [...new Set(connections.map((c) => c.folder).filter(Boolean))], [connections]);
  const { closeEditor, save } = useConnections.getState();
  const [c, setC] = useState<ConnectionConfig>(blankConnection());
  const [password, setPassword] = useState("");
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [nameTouched, setNameTouched] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [saving, setSaving] = useState(false);
  const [url, setUrl] = useState("");

  useEffect(() => {
    if (!editing) return;
    setC(editing);
    setPassword("");
    setPasswordTouched(false);
    setShowPassword(false);
    setNameTouched(!!editing.id);
    setAdvanced(false);
    setTest({ kind: "idle" });
    setUrl("");
  }, [editing]);

  const isNew = !editing?.id;
  const server = c.driver !== "sqlite";
  const set = <K extends keyof ConnectionConfig>(k: K, v: ConnectionConfig[K]) => {
    setTest({ kind: "idle" });
    setC((x) => ({ ...x, [k]: v }));
  };
  const name = nameTouched ? c.name : c.name || autoName(c);

  const switchDriver = (driver: Driver) => {
    if (driver === c.driver) return;
    const base = blankConnection(driver);
    setTest({ kind: "idle" });
    setC((x) => ({ ...x, driver, port: base.port, user: base.user, database: base.database, host: driver === "sqlite" ? x.host : x.host || "localhost" }));
  };

  const applyUrl = (text: string) => {
    setUrl(text);
    const p = parseUrl(text);
    if (!p) return;
    const { password: pw, ...fields } = p;
    setC((x) => ({ ...x, ...fields }));
    if (pw !== undefined) {
      setPassword(pw);
      setPasswordTouched(true);
    }
    setTest({ kind: "idle" });
  };

  const config = useMemo<ConnectionConfig>(() => ({ ...c, name: name.trim() }), [c, name]);
  const secrets = passwordTouched || isNew ? { password } : undefined;

  const runTest = async () => {
    setTest({ kind: "running" });
    try {
      setTest({ kind: "ok", report: await api.testConnection(config, secrets) });
    } catch (e) {
      setTest({ kind: "error", message: errorMessage(e) });
    }
  };

  const submit = async (connect: boolean) => {
    if (!config.name) return toast("Give the connection a name", "warning");
    if (!server && !config.filePath.trim()) return toast("Choose the database file", "warning");
    if (server && !config.host.trim()) return toast("Enter the server host", "warning");
    setSaving(true);
    try {
      const saved = await save(config, config.savePassword && (passwordTouched || isNew) ? password : null);
      closeEditor();
      if (connect) {
        const st = useConnections.getState();
        st.select(`c:${saved.id}`);
        await st.toggle({ key: `c:${saved.id}`, type: "connection", label: saved.name, connId: saved.id }, true);
      }
    } catch (e) {
      toast("Could not save the connection", "error", errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const browse = async () => {
    if (!isTauri()) return toast("Choosing files is available in the desktop app", "info");
    const path = await api.pickOpenFile([
      { name: "SQLite databases", extensions: ["db", "sqlite", "sqlite3", "db3", "s3db"] },
      { name: "All files", extensions: ["*"] },
    ]);
    if (path) set("filePath", path);
  };

  return (
    <Dialog
      open={!!editing}
      onClose={closeEditor}
      label={isNew ? "New connection" : "Edit connection"}
      className="h-[min(760px,calc(100vh-40px))] w-[min(980px,calc(100vw-40px))] flex-row"
    >
      {/* Left column — the database */}
      <div className="flex w-[230px] shrink-0 flex-col px-2 py-3">
        <div className="px-2.5 pb-1 pt-1 text-[11px] text-[var(--text-dim)]">Database</div>
        <div className="flex flex-col gap-0.5" role="radiogroup" aria-label="Database">
          {DRIVERS.map((d) => {
            const on = c.driver === d.id;
            return (
              <button
                key={d.id}
                type="button"
                role="radio"
                aria-checked={on}
                data-testid={`driver-${d.id}`}
                onClick={() => switchDriver(d.id)}
                className={cx(
                  "flex items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors",
                  on ? "bg-[var(--hover-bg)] text-[var(--text-main)]" : "text-[var(--text-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]",
                )}
              >
                <DriverBadge driver={d.id} size={26} className="rounded-lg" />
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="text-[13px] font-medium">{DRIVER_LABEL[d.id]}</span>
                  <span className="truncate text-[11px] text-[var(--text-dim)]">{d.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="mt-auto px-2.5 text-[11px] leading-relaxed text-[var(--text-dim)]">
          Passwords are stored encrypted in the system keychain, never in Helix's files.
        </div>
      </div>

      {/* Right column — settings on an inset card, like Settings */}
      <div className="my-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-[18px] border border-[var(--border)] bg-[var(--bg-app)]">
        <div className="flex items-start gap-3 px-7 pb-4 pt-6">
          <DriverBadge driver={c.driver} size={36} className="rounded-xl" />
          <div className="min-w-0 flex-1">
            <div className="text-[17px] font-semibold text-[var(--text-main)]">{isNew ? `New ${DRIVER_LABEL[c.driver]} connection` : `Edit ${editing?.name ?? "connection"}`}</div>
            <div className="mt-0.5 text-[12.5px] text-[var(--text-dim)]">{server ? "Server, sign-in and how Helix treats the connection" : "A database file on this computer"}</div>
          </div>
          <IconButton label="Close" onClick={closeEditor}>
            <X size={14} />
          </IconButton>
        </div>

        <ScrollArea className="min-h-0 flex-1" innerClassName="flex flex-col gap-5 px-7 pb-6 pt-1">
          {server && (
            <div className="flex h-9 items-center gap-2 rounded-xl border border-dashed border-[var(--border)] px-3">
              <Link2 size={13} className="shrink-0 text-[var(--text-dim)]" />
              <input
                aria-label="Connection URL"
                className="h-full min-w-0 flex-1 bg-transparent font-mono text-[12px] text-[var(--text-main)] outline-none placeholder:font-sans placeholder:text-[var(--text-dim)]"
                placeholder="Paste a connection URL to fill the form — postgres://user:pass@host:5432/db"
                value={url}
                onChange={(e) => applyUrl(e.target.value)}
                spellCheck={false}
              />
            </div>
          )}

          <div className="flex flex-col gap-2">
            <SectionHeading>{server ? "Server" : "File"}</SectionHeading>
            <SettingsCard className="gap-3.5 py-4">
              {server ? (
                <>
                  <div className="grid grid-cols-[1fr_110px] gap-3">
                    <Field label="Host" hint={c.driver === "mssql" ? "server\\instance finds a named instance (leave the port empty)" : undefined}>
                      <Input data-autofocus mono value={c.host} placeholder="localhost" onChange={(e) => set("host", e.target.value)} />
                    </Field>
                    <Field label="Port">
                      <Input mono value={c.port ? String(c.port) : ""} placeholder={String(DEFAULT_PORT[c.driver])} onChange={(e) => set("port", Number(e.target.value.replace(/\D/g, "")) || 0)} />
                    </Field>
                  </div>
                  <Field label="Database" hint={c.driver === "mysql" ? "Optional — every database of the server is listed" : undefined}>
                    <Input
                      mono
                      value={c.database}
                      placeholder={c.driver === "postgres" ? "postgres" : c.driver === "mssql" ? "master" : "(any)"}
                      onChange={(e) => set("database", e.target.value)}
                    />
                  </Field>
                </>
              ) : (
                <Field label="Database file" hint="A new, empty database is created when the file does not exist">
                  <div className="flex gap-2">
                    <Input data-autofocus mono value={c.filePath} placeholder="C:\data\app.db" onChange={(e) => set("filePath", e.target.value)} />
                    <Button icon={<FolderOpen size={13} />} onClick={() => void browse()}>
                      Browse
                    </Button>
                  </div>
                </Field>
              )}
            </SettingsCard>
          </div>

          {server && (
            <div className="flex flex-col gap-2">
              <SectionHeading>Authentication</SectionHeading>
              <SettingsCard className="gap-3.5 py-4">
                {c.driver === "mssql" && (
                  <SettingRow title="Method">
                    <Segmented
                      size="sm"
                      value={c.windowsAuth ? "windows" : "sql"}
                      onChange={(v) => set("windowsAuth", v === "windows")}
                      options={[
                        { value: "sql", label: "SQL Server login" },
                        { value: "windows", label: "Windows account" },
                      ]}
                    />
                  </SettingRow>
                )}
                {c.windowsAuth ? (
                  <div className="text-[12.5px] text-[var(--text-dim)]">Helix signs in as the current Windows user.</div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="User">
                        <Input value={c.user} onChange={(e) => set("user", e.target.value)} autoComplete="off" />
                      </Field>
                      <Field label="Password">
                        <div className="relative">
                          <Input
                            type={showPassword ? "text" : "password"}
                            className="pr-9"
                            value={password}
                            placeholder={!isNew && !passwordTouched ? "Unchanged" : ""}
                            onChange={(e) => {
                              setPassword(e.target.value);
                              setPasswordTouched(true);
                              setTest({ kind: "idle" });
                            }}
                            autoComplete="new-password"
                          />
                          <button
                            type="button"
                            aria-label={showPassword ? "Hide password" : "Show password"}
                            title={showPassword ? "Hide password" : "Show password"}
                            className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-[var(--text-dim)] hover:text-[var(--text-main)]"
                            onClick={() => setShowPassword((v) => !v)}
                          >
                            {showPassword ? <EyeOff size={13} /> : <Eye size={13} />}
                          </button>
                        </div>
                      </Field>
                    </div>
                    <Sep />
                    <SettingRow title="Remember password" hint="Off: Helix asks for it on every connect">
                      <Switch on={c.savePassword} onChange={(v) => set("savePassword", v)} ariaLabel="Remember password" />
                    </SettingRow>
                  </>
                )}
              </SettingsCard>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <SectionHeading>Connection</SectionHeading>
            <SettingsCard className="gap-3.5 py-4">
              <Field label="Name">
                <Input
                  value={name}
                  placeholder="My database"
                  onChange={(e) => {
                    setNameTouched(true);
                    set("name", e.target.value);
                  }}
                />
              </Field>
              <Sep />
              <SettingRow title="Type" hint="Production asks before every statement that changes data">
                <Segmented<Environment>
                  size="sm"
                  value={c.environment}
                  onChange={(v) => set("environment", v)}
                  options={(["development", "test", "production"] as Environment[]).map((e) => ({
                    value: e,
                    label: (
                      <span className="flex items-center gap-1.5">
                        <span className={cx("h-1.5 w-1.5 rounded-full", ENV_DOT[e])} />
                        {e === "development" ? "Development" : e === "test" ? "Test" : "Production"}
                      </span>
                    ),
                  }))}
                />
              </SettingRow>
              <Sep />
              <SettingRow title="Color" hint="Marks the connection and its editor tabs">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    title="No color"
                    aria-label="No color"
                    onClick={() => set("color", null)}
                    className={cx("h-5 w-5 rounded-full border border-dashed border-[var(--text-dim)]", !c.color && "ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--bg-surface)]")}
                  />
                  {COLORS.map((col) => (
                    <button
                      key={col}
                      type="button"
                      title={col}
                      aria-label={`Color ${col}`}
                      onClick={() => set("color", col)}
                      className={cx("h-5 w-5 rounded-full transition-transform hover:scale-110", c.color === col && "ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--bg-surface)]")}
                      style={{ background: col }}
                    />
                  ))}
                </div>
              </SettingRow>
              <Sep />
              <SettingRow title="Folder" hint="Groups connections in the navigator">
                <div className="w-[220px]">
                  <Combobox
                    value={c.folder}
                    onChange={(v) => set("folder", v)}
                    placeholder="Type a folder name…"
                    createLabel={(q) => `New folder “${q}”`}
                    options={[{ value: "", label: "(none)" }, ...folders.map((f) => ({ value: f, label: f }))]}
                  />
                </div>
              </SettingRow>
            </SettingsCard>
          </div>

          <div className="flex flex-col gap-2">
            <button
              type="button"
              aria-expanded={advanced}
              onClick={() => setAdvanced((a) => !a)}
              className="flex w-fit items-center gap-1 px-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-dim)] hover:text-[var(--text-main)]"
            >
              <motion.span animate={{ rotate: advanced ? 90 : 0 }} transition={{ duration: 0.12 }} className="flex">
                <ChevronRight size={12} />
              </motion.span>
              Security & advanced
            </button>
            <AnimatePresence initial={false}>
              {advanced && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.16 }} className="overflow-hidden">
                  <SettingsCard className="gap-3.5 py-4">
                    {server && (
                      <>
                        <SettingRow title="SSL / TLS" hint={c.driver === "mssql" ? "Prefer: the login is always encrypted; the rest if the server asks" : "Encryption of the connection"}>
                          <div className="w-[220px]">
                            <Combobox searchable={false} value={c.sslMode} onChange={(v) => set("sslMode", v as ConnectionConfig["sslMode"])} options={SSL_OPTIONS} />
                          </div>
                        </SettingRow>
                        {c.driver === "mssql" && (
                          <>
                            <Sep />
                            <SettingRow title="Trust server certificate" hint="Accept self-signed certificates (ignored by Verify CA / Verify full)">
                              <Switch on={c.trustServerCertificate} onChange={(v) => set("trustServerCertificate", v)} ariaLabel="Trust server certificate" />
                            </SettingRow>
                          </>
                        )}
                        <Sep />
                      </>
                    )}
                    <SettingRow title="Read-only" hint="Only reading statements run; the server enforces it where it can">
                      <Switch on={c.readOnly} onChange={(v) => set("readOnly", v)} ariaLabel="Read-only" />
                    </SettingRow>
                    {server && (
                      <>
                        <Sep />
                        <SettingRow title="Show all databases" hint="List every database of the server, not only the default one">
                          <Switch on={c.showAllDatabases} onChange={(v) => set("showAllDatabases", v)} ariaLabel="Show all databases" />
                        </SettingRow>
                      </>
                    )}
                    <Sep />
                    <SettingRow title="Connect timeout" hint="Seconds">
                      <Input className="w-[90px]" mono value={String(c.connectTimeout)} onChange={(e) => set("connectTimeout", Number(e.target.value.replace(/\D/g, "")) || 15)} />
                    </SettingRow>
                    <Sep />
                    <Field label="Bootstrap queries" hint="Run on every new connection (one per line, ending with ;)">
                      <TextArea
                        mono
                        rows={4}
                        value={c.initSql}
                        placeholder={c.driver === "postgres" ? "SET statement_timeout = '30s';" : c.driver === "mssql" ? "SET LOCK_TIMEOUT 5000;" : "SET time_zone = '+00:00';"}
                        onChange={(e) => set("initSql", e.target.value)}
                      />
                    </Field>
                  </SettingsCard>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </ScrollArea>

        {/* Footer: test result + actions */}
        <div className="flex items-center gap-2 border-t border-[var(--border-soft)] px-5 py-3">
          <Button data-testid="test-connection" icon={test.kind === "running" ? <Spinner size={13} /> : <Plug size={13} />} disabled={test.kind === "running"} onClick={() => void runTest()}>
            Test
          </Button>
          <div className="min-w-0 flex-1 px-1 text-[12px]" aria-live="polite">
            {test.kind === "ok" && (
              <span className="flex min-w-0 items-center gap-1.5 text-[var(--diff-add)]" title={test.report.serverVersion}>
                <CheckCircle2 size={13} className="shrink-0" />
                <span className="shrink-0">Connected in {test.report.elapsedMs} ms</span>
                <span className="truncate font-mono text-[11px] text-[var(--text-dim)]">{test.report.serverVersion}</span>
              </span>
            )}
            {test.kind === "error" && (
              <span className="selectable flex min-w-0 items-start gap-1.5 text-[var(--diff-del)]" title={test.message}>
                <AlertCircle size={13} className="mt-px shrink-0" />
                <span className="line-clamp-2 break-words">{test.message}</span>
              </span>
            )}
          </div>
          <Button variant="ghost" onClick={closeEditor}>
            Cancel
          </Button>
          <Button onClick={() => void submit(false)} disabled={saving}>
            Save
          </Button>
          <Button variant="primary" data-testid="save-connect" icon={saving ? <Spinner size={13} /> : undefined} onClick={() => void submit(true)} disabled={saving}>
            Save & connect
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
