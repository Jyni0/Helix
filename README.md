# Helix

A cross-platform desktop database client in the spirit of DBeaver: **Tauri 2 (Rust)** + **React 18 / TypeScript / Tailwind 4 / Motion / Zustand** — the same stack and design system as Trajectory and Nox Code.

Supported databases: **PostgreSQL**, **MySQL / MariaDB**, **SQLite** and **Microsoft SQL Server**.

## Quick start

```bash
npm install
npm run tauri dev        # desktop app
```

The UI also runs in a browser against an in-memory mock backend (no Rust, no databases):

```bash
npm run dev              # http://localhost:1450        — empty start
                         # http://localhost:1450/?demo  — sample connections over a demo shop database
```

## Features

**Connections**
- PostgreSQL, MySQL/MariaDB, SQLite, SQL Server (SQL login, Windows authentication, `server\instance` via SQL Browser, Azure redirects).
- Paste a URL (`postgres://user:pass@host:5432/db`, `mysql://…`, `sqlserver://…`, `sqlite:///path`) to fill the form; test before saving.
- SSL/TLS modes, read-only connections, connect timeout, bootstrap SQL run on every connection.
- Connection types Dev / Test / **Prod** (production asks before statements that change data), colors, folders.
- Passwords live in the system keychain (Credential Manager / Keychain / Secret Service), or are asked on connect.

**Navigator**
- Lazy tree: connections → databases → schemas → tables, views, materialized views, foreign tables, functions, procedures, sequences, triggers → columns (keys marked).
- Filter, keyboard navigation, system objects on demand.
- Context menus: read data, properties, DDL, generate SQL (SELECT / INSERT / UPDATE / DELETE / UPSERT·MERGE / DDL), export, import, count rows, copy names, rename, truncate, drop, create table, ER diagram, server sessions.

**SQL editor** (CodeMirror 6)
- Dialect highlighting, autocomplete of keywords, tables and columns of the active schema.
- `Ctrl+Enter` runs the statement under the cursor (or the selection), `Alt+X` the whole script, `Ctrl+Shift+E` explains the plan, `Ctrl+Shift+F` formats.
- A statement splitter that understands quotes, comments, `$$` bodies, MySQL `DELIMITER`, SQL Server `GO`, BEGIN…END routine bodies and (optionally) blank lines.
- Each editor has its own server session: active database / schema pickers, **auto-commit or manual commit** with Commit / Rollback and a pending-changes counter, cancel of running queries (server-side cancel on PostgreSQL / MySQL).
- Result tabs (pin to keep them), an output log, row limit with *More* / *All*, total row count.
- Scripts persist across restarts; open / save `.sql` files. Query history with search.
- Safety: confirmation for UPDATE / DELETE without WHERE and for changes on production connections; read-only connections refuse writes.

**Results grid**
- Virtualized, sortable (client-side, or server-side in table data), resizable / auto-fit columns, rectangular selection, keyboard navigation.
- Copy as TSV / CSV / JSON / Markdown / SQL INSERT; paste from spreadsheets.
- Inline editing of table rows (also of `SELECT * FROM table` results): edit, set NULL, add / duplicate / delete rows; saving shows the generated SQL first and runs it in one transaction.
- Value panel (full text, pretty JSON, editing) and record (transposed) view.

**Table editor**
- Data (WHERE filter with history, filter by cell value), Properties (columns, indexes, foreign keys, references, constraints, triggers, size / rows / engine), DDL, and a diagram of the table with its neighbours.

**ER diagrams** of whole schemas: auto layout of related tables, drag, zoom / pan, keys-only mode, saved positions, SVG export.

**Export / import**
- Export any query or table — every row, streamed by the Rust core — to CSV, TSV, JSON, SQL INSERTs, Markdown, XML or HTML.
- Import CSV into a table with column mapping, delimiter detection and preview.

**Server sessions** (PostgreSQL, MySQL, SQL Server): live list with filter / auto-refresh, cancel query, terminate session.

**App**: 16 themes, settings, keyboard shortcuts page, custom title bar with menus. Updates from GitHub releases (the Nox Code update system): a check on start and every 6 hours, an *Update* button in the title bar that downloads the installer for the platform and runs it.

## Security

- **Passwords** are never written to Helix's files: they go to the OS keychain (Windows Credential Manager / macOS Keychain / Secret Service), which encrypts them per user. They cannot be hashed — the client must send the real password to the server — so encrypted OS storage is the right place. "Remember password" off keeps them in memory only for the session.
- `connections.json` (app data folder) holds host / user / options only. Query history masks passwords in statements (`PASSWORD '…'`, `IDENTIFIED BY '…'`).
- **File access**: open / save dialogs run in the Rust core, and the UI can only read or write files the user picked there (`files.rs`) — a compromised page cannot touch other files.
- **Updates** are downloaded only from GitHub over HTTPS and checked against the release asset's SHA-256 digest before they run.
- **TLS**: PostgreSQL / MySQL modes disable → verify-full; SQL Server `verify-ca` / `verify-full` always validate the certificate (even with "trust server certificate" on).
- Catalog queries embed object names only as escaped literals / identifiers; a test suite runs every catalog call with hostile names (`'`, `"`, `;DROP …`, `--`) on all four servers.

## Updates and releases

Releases come from `github.com/Jyni0/Helix` (from `package.json` → `repository`). The app reads the latest release through the GitHub API, compares the version in the tag (`Release-1.2.0`, `v1.2.0`) with its own and picks the installer by file name (Tauri's default names):

- Windows — `*_x64-setup.exe` (or `.msi`): runs passively, Helix restarts on the new version;
- macOS — `*_aarch64.dmg` / `*_x64.dmg`: opens in Finder;
- Linux — AppImage, `.deb` or `.rpm`.

To release: bump `version` in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, build with `npm run tauri build` and upload the installers to a new GitHub release. `.github/workflows/release.yml` (started by hand) builds Windows, macOS and Linux into a draft release.

## Tests

```bash
npm test                 # frontend unit + component tests (vitest)
npm run test:e2e         # Playwright against the demo backend
npm run test:rust        # Rust unit tests + SQLite integration suite
```

The Rust integration suite runs against real servers when `HELIX_DB_TESTS=1` and these containers are up:

```bash
docker run -d --name helix-pg -e POSTGRES_PASSWORD=helixpw -p 55432:5432 postgres:16
docker run -d --name helix-my -e MYSQL_ROOT_PASSWORD=helixpw -e MYSQL_DATABASE=helix -p 53306:3306 mysql:8.4
docker run -d --name helix-ms -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD=Helix_pw123! -p 51433:1433 mcr.microsoft.com/mssql/server:2022-latest
```

## Structure

```
src-tauri/src/
  lib.rs            Tauri builder, command registration
  commands.rs       IPC commands (thin wrappers over Manager)
  manager.rs        live connections, navigator connections, editor sessions, transactions, cancel
  drivers/          postgres.rs · mysql.rs · sqlite.rs (sqlx) · mssql.rs (tiberius) — values as text
  meta.rs           catalog queries per server: objects, table structure, DDL, ER model, sessions, explain
  sqlscan.rs        statement classification and row-limit wrapping
  export.rs         streaming export writers
  store.rs          connections.json; secrets.rs — system keychain
  updater.rs        installer download / launch (from Nox Code)
src/
  components/       design system (kit/ + tokens, from Trajectory) and the app's views:
                    navigator/, editor/, grid/, table/, erd/, panels/, dialogs/, connection/, settings/, layout/
  store/            zustand stores: connections, workspace (tabs), editors (sessions / results), ui, history, updates
  lib/              api.ts (IPC facade) · mockBackend.ts · sql/ (splitter, dialect, formatter) · copy, csv
```
