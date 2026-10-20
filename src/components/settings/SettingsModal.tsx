import { Info, Keyboard, Palette, ShieldAlert, SquareTerminal, Table2, X, type LucideIcon } from "lucide-react";
import { THEME_LIST, type Theme } from "@/lib/themes";
import { shortcutLabel } from "@/lib/platform";
import { isTauri } from "@/lib/api";
import { COMMANDS } from "@/app/commands";
import { useUi, type Preferences, type SettingsTab } from "@/store/ui";
import { APP_VERSION, BUILD_SHA, REPO, openUpdateDialog, useUpdates } from "@/store/updates";
import { Button, Combobox, Dialog, IconButton, Input, Kbd, NavItem, ScrollArea, Segmented, Sep, SettingRow, SettingsCard, Switch } from "@/components";
import { HelixMark } from "@/components/layout/TitleBar";

function usePref<K extends keyof Preferences>(key: K): [Preferences[K], (v: Preferences[K]) => void] {
  const v = useUi((s) => s.prefs[key]);
  const set = useUi((s) => s.setPref);
  return [v, (x) => set(key, x)];
}

function NumberInput({ value, onChange, min, max, width = "w-[90px]" }: { value: number; onChange(v: number): void; min: number; max: number; width?: string }) {
  return (
    <Input
      className={width}
      mono
      value={String(value)}
      onChange={(e) => {
        const n = Number(e.target.value.replace(/\D/g, ""));
        if (!Number.isNaN(n)) onChange(Math.min(max, Math.max(min, n)));
      }}
    />
  );
}

function AppearancePanel() {
  const [theme, setTheme] = usePref("theme");
  const [font, setFont] = usePref("editorFontSize");
  return (
    <SettingsCard>
      <SettingRow title="Theme" hint="Application color scheme — searchable">
        <div className="w-[240px]">
          <Combobox
            value={theme}
            onChange={(v) => setTheme(v as Theme)}
            placeholder="Search themes…"
            emptyText="No theme matches"
            options={THEME_LIST.map((t) => ({ value: t.id, label: t.label, hint: t.kind, swatch: t.swatch }))}
          />
        </div>
      </SettingRow>
      <Sep />
      <SettingRow title="Font size" hint="SQL editor and result grids">
        <Segmented
          size="sm"
          value={String(font)}
          onChange={(v) => setFont(Number(v))}
          options={["11", "12", "13", "14", "15", "16"].map((v) => ({ value: v, label: v }))}
        />
      </SettingRow>
    </SettingsCard>
  );
}

function EditorPanel() {
  const [tab, setTab] = usePref("tabSize");
  const [wrap, setWrap] = usePref("wordWrap");
  const [auto, setAuto] = usePref("autocomplete");
  const [blank, setBlank] = usePref("blankLineDelimiter");
  const [upper, setUpper] = usePref("formatUppercase");
  return (
    <SettingsCard>
      <SettingRow title="Autocomplete" hint="Keywords, tables and columns of the active schema while typing (Ctrl+Space anytime)">
        <Switch on={auto} onChange={setAuto} ariaLabel="Autocomplete" />
      </SettingRow>
      <Sep />
      <SettingRow title="Blank line ends a statement" hint="Ctrl+Enter runs the block under the cursor even without a semicolon">
        <Switch on={blank} onChange={setBlank} ariaLabel="Blank line delimiter" />
      </SettingRow>
      <Sep />
      <SettingRow title="Word wrap">
        <Switch on={wrap} onChange={setWrap} ariaLabel="Word wrap" />
      </SettingRow>
      <Sep />
      <SettingRow title="Indentation" hint="Spaces per level (editor and formatter)">
        <Segmented size="sm" value={String(tab)} onChange={(v) => setTab(Number(v))} options={["2", "4"].map((v) => ({ value: v, label: v }))} />
      </SettingRow>
      <Sep />
      <SettingRow title="Uppercase keywords when formatting" hint="Ctrl+Shift+F">
        <Switch on={upper} onChange={setUpper} ariaLabel="Uppercase keywords" />
      </SettingRow>
    </SettingsCard>
  );
}

function ResultsPanel() {
  const [limit, setLimit] = usePref("rowLimit");
  const [nullText, setNullText] = usePref("nullText");
  const [preview, setPreview] = usePref("previewChanges");
  const [openView, setOpenView] = usePref("openTableView");
  const [system, setSystem] = usePref("showSystemObjects");
  return (
    <div className="flex flex-col gap-4">
      <SettingsCard>
        <SettingRow title="Rows per fetch" hint="Queries return this many rows; More / All fetch the rest">
          <NumberInput value={limit} onChange={setLimit} min={1} max={1_000_000} />
        </SettingRow>
        <Sep />
        <SettingRow title="NULL shown as" hint="How empty values look in grids">
          <Input className="w-[140px]" mono value={nullText} onChange={(e) => setNullText(e.target.value)} />
        </SettingRow>
        <Sep />
        <SettingRow title="Preview SQL before saving edits" hint="Show the INSERT / UPDATE / DELETE statements of grid edits first">
          <Switch on={preview} onChange={setPreview} ariaLabel="Preview changes" />
        </SettingRow>
      </SettingsCard>
      <SettingsCard>
        <SettingRow title="Double-clicking a table opens" hint="In the navigator">
          <Segmented
            size="sm"
            value={openView}
            onChange={setOpenView}
            options={[
              { value: "data", label: "Data" },
              { value: "properties", label: "Properties" },
            ]}
          />
        </SettingRow>
        <Sep />
        <SettingRow title="Show system objects" hint="pg_catalog, information_schema, system databases…">
          <Switch on={system} onChange={setSystem} ariaLabel="Show system objects" />
        </SettingRow>
      </SettingsCard>
    </div>
  );
}

function SafetyPanel() {
  const [auto, setAuto] = usePref("autoCommit");
  const [prod, setProd] = usePref("confirmProduction");
  const [unbounded, setUnbounded] = usePref("confirmUnbounded");
  const [stop, setStop] = usePref("stopOnError");
  return (
    <SettingsCard>
      <SettingRow title="Auto-commit new editors" hint="Off: statements run in a transaction you commit or roll back">
        <Switch on={auto} onChange={setAuto} ariaLabel="Auto-commit" />
      </SettingRow>
      <Sep />
      <SettingRow title="Confirm changes on production" hint="Ask before statements that change data or structure on connections of type Production">
        <Switch on={prod} onChange={setProd} ariaLabel="Confirm production" />
      </SettingRow>
      <Sep />
      <SettingRow title="Confirm UPDATE / DELETE without WHERE">
        <Switch on={unbounded} onChange={setUnbounded} ariaLabel="Confirm unbounded" />
      </SettingRow>
      <Sep />
      <SettingRow title="Stop a script on the first error">
        <Switch on={stop} onChange={setStop} ariaLabel="Stop on error" />
      </SettingRow>
    </SettingsCard>
  );
}

function ShortcutsPanel() {
  const groups = [...new Set(COMMANDS.map((c) => c.category))];
  const extra: [string, string][] = [
    ["Autocomplete", "Ctrl+Space"],
    ["Toggle comment", "Ctrl+/"],
    ["Find / replace", "Ctrl+F"],
    ["Grid: copy / with headers", "Ctrl+C / Ctrl+Shift+C"],
    ["Grid: edit cell", "F2"],
    ["Grid: set NULL", "Ctrl+0"],
    ["Grid: add / duplicate row", "Insert / Ctrl+D"],
    ["Grid: delete rows", "Delete"],
  ];
  const row = (label: string, keys: string) => (
    <div key={label} className="flex items-center justify-between py-1 text-[12.5px]">
      <span className="text-[var(--text-main)]">{label}</span>
      <span className="flex items-center gap-1">
        {keys.split(" / ").map((k, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <span className="text-[var(--text-dim)]">/</span>}
            {shortcutLabel(k)
              .split("+")
              .map((p) => (
                <Kbd key={p}>{p}</Kbd>
              ))}
          </span>
        ))}
      </span>
    </div>
  );
  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <SettingsCard key={g} className="gap-0.5">
          <div className="pb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-dim)]">{g}</div>
          {COMMANDS.filter((c) => c.category === g && c.shortcut).map((c) => row(c.label, c.shortcut!))}
        </SettingsCard>
      ))}
      <SettingsCard className="gap-0.5">
        <div className="pb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-dim)]">Editor & grid</div>
        {extra.map(([l, k]) => row(l, k))}
      </SettingsCard>
    </div>
  );
}

/** Settings → About: updates from GitHub releases (Nox Code's update system). */
function UpdatesCard() {
  const [auto, setAuto] = usePref("checkForUpdates");
  const status = useUpdates((s) => s.status);
  const latest = useUpdates((s) => s.info?.version);
  const checkedAt = useUpdates((s) => s.checkedAt);
  const error = useUpdates((s) => s.error);
  const hint =
    !isTauri()
      ? "Available in the desktop app"
      : status === "checking"
        ? "Checking GitHub…"
        : status === "available"
          ? `Helix ${latest} is available`
          : status === "downloading"
            ? `Downloading Helix ${latest}…`
            : status === "installing"
              ? "Installing…"
              : status === "current"
                ? `Up to date — ${APP_VERSION} is the latest release${checkedAt ? ` · checked ${new Date(checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}`
                : status === "error"
                  ? `Check failed: ${error}`
                  : REPO
                    ? `Checks the releases of github.com/${REPO}`
                    : "This build does not know its GitHub repository";
  return (
    <SettingsCard>
      <SettingRow title="Updates" hint={hint}>
        {status === "available" ? (
          <Button size="sm" variant="primary" data-testid="about-update" onClick={openUpdateDialog}>
            Update…
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={!isTauri() || status === "checking" || status === "downloading" || status === "installing" || !REPO}
            onClick={() => void useUpdates.getState().check(true)}
          >
            Check for updates
          </Button>
        )}
      </SettingRow>
      <Sep />
      <SettingRow title="Check automatically" hint="On start and every 6 hours">
        <Switch on={auto} onChange={setAuto} ariaLabel="Check for updates automatically" />
      </SettingRow>
    </SettingsCard>
  );
}

function AboutPanel() {
  const reset = useUi((s) => s.resetPrefs);
  return (
    <div className="flex flex-col gap-4">
      <SettingsCard>
        <div className="flex items-center gap-4 py-2">
          <HelixMark size={52} />
          <div>
            <div className="text-[22px] font-semibold text-[var(--text-main)]">Helix</div>
            <div className="text-[12.5px] text-[var(--text-dim)]">
              Version {APP_VERSION}
              {BUILD_SHA ? ` · ${BUILD_SHA.slice(0, 7)}` : ""} · {isTauri() ? "Desktop" : "Browser preview"}
            </div>
          </div>
        </div>
        <div className="text-[12.5px] leading-relaxed text-[var(--text-muted)]">
          A universal database client for PostgreSQL, MySQL / MariaDB, SQLite and Microsoft SQL Server. Built with Tauri 2 and Rust (sqlx, tiberius), React,
          CodeMirror 6 — in the design language of Trajectory and Nox Code.
        </div>
      </SettingsCard>
      <UpdatesCard />
      <SettingsCard>
        <SettingRow title="Credentials" hint="Passwords live in the system keychain (Credential Manager / Keychain / Secret Service)" />
        <Sep />
        <SettingRow title="Reset settings" hint="Every preference back to its default (the theme stays)">
          <Button size="sm" variant="danger-ghost" onClick={reset}>
            Reset
          </Button>
        </SettingRow>
      </SettingsCard>
    </div>
  );
}

type NavEntry = { id: SettingsTab; label: string; icon: LucideIcon };
const NAV: { group?: string; items: NavEntry[] }[] = [
  { items: [{ id: "appearance", label: "Appearance", icon: Palette }] },
  {
    group: "Database",
    items: [
      { id: "editor", label: "SQL Editor", icon: SquareTerminal },
      { id: "results", label: "Results & Navigator", icon: Table2 },
      { id: "safety", label: "Transactions & Safety", icon: ShieldAlert },
    ],
  },
  { group: "Help", items: [{ id: "shortcuts", label: "Keyboard Shortcuts", icon: Keyboard }] },
];

const TITLES: Record<SettingsTab, [string, string]> = {
  appearance: ["Appearance", "Color theme and text size"],
  editor: ["SQL Editor", "Completion, statements and formatting"],
  results: ["Results & Navigator", "Fetching, editing and the object tree"],
  safety: ["Transactions & Safety", "Commit mode and confirmations"],
  shortcuts: ["Keyboard Shortcuts", "Every shortcut of Helix"],
  about: ["About", "Version and updates"],
};

/** Settings — the same two-column window as Trajectory's. */
export function SettingsModal() {
  const open = useUi((s) => s.settingsOpen);
  const tab = useUi((s) => s.settingsTab);
  const { closeSettings, openSettings } = useUi.getState();

  const navButton = (it: NavEntry) => {
    const Icon = it.icon;
    const on = tab === it.id;
    return (
      <NavItem
        key={it.id}
        data-testid={`settings-tab-${it.id}`}
        aria-current={on ? "page" : undefined}
        active={on}
        className={on ? "text-[var(--text-main)]" : ""}
        icon={<Icon size={15} strokeWidth={1.7} className="shrink-0" />}
        onClick={() => openSettings(it.id)}
      >
        <span className="truncate">{it.label}</span>
      </NavItem>
    );
  };

  return (
    <Dialog open={open} onClose={closeSettings} label="Settings" className="h-[min(720px,calc(100vh-40px))] w-[min(1100px,calc(100vw-40px))] flex-row">
      <div className="flex w-[210px] shrink-0 flex-col">
        <ScrollArea className="min-h-0 flex-1" innerClassName="flex flex-col gap-4 px-2 py-3">
          {NAV.map((grp, gi) => (
            <div key={grp.group ?? gi} className="flex flex-col gap-0.5">
              {grp.group && <div className="px-2.5 pb-1 text-[11px] text-[var(--text-dim)]">{grp.group}</div>}
              {grp.items.map(navButton)}
            </div>
          ))}
        </ScrollArea>
        <div className="px-2 pb-3">{navButton({ id: "about", label: "About", icon: Info })}</div>
      </div>

      <div className="my-2 mr-2 flex min-w-0 flex-1 overflow-hidden rounded-[18px] border border-[var(--border)] bg-[var(--bg-app)]">
        <ScrollArea className="min-w-0 flex-1" innerClassName="min-w-0 px-8 py-6">
          <div className="mb-5 flex items-start">
            <div className="min-w-0">
              <div className="text-[17px] font-semibold text-[var(--text-main)]">{TITLES[tab][0]}</div>
              <div className="mt-0.5 text-[12.5px] text-[var(--text-dim)]">{TITLES[tab][1]}</div>
            </div>
            <IconButton label="Close settings" className="ml-auto" onClick={closeSettings}>
              <X size={14} />
            </IconButton>
          </div>
          {tab === "appearance" && <AppearancePanel />}
          {tab === "editor" && <EditorPanel />}
          {tab === "results" && <ResultsPanel />}
          {tab === "safety" && <SafetyPanel />}
          {tab === "shortcuts" && <ShortcutsPanel />}
          {tab === "about" && <AboutPanel />}
        </ScrollArea>
      </div>
    </Dialog>
  );
}
