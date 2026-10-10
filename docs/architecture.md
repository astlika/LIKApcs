# LIKApcs — Architecture

LIKApcs is a three-part system for gaming stations / internet cafés: a **Server** that owns the data,
an **Admin** desktop app used by staff, and a **Client** app that runs on every customer PC.
Every component talks to the server over the local network; nothing talks to the database except the
server.

```
┌───────────────────────────┐        HTTPS/WS (LAN)        ┌──────────────────────────────┐
│  LIKApcs Admin (Tauri)    │ ───────────────────────────▶ │  LIKApcs Server (Node 20)    │
│  React UI · POS · grid    │ ◀─────────────────────────── │  Fastify HTTP API v1         │
└───────────────────────────┘   /api/v1  +  /ws/admin      │  /ws/admin  /ws/client       │
                                                           │  billing · sessions · auth   │
┌───────────────────────────┐        HTTPS/WS (LAN)        │  backups · updates (later)   │
│  LIKApcs-Client (per PC)  │ ───────────────────────────▶ │                              │
│  lock screen · timer      │ ◀─────────────────────────── │   ┌──────────────────────┐   │
└───────────────────────────┘   /api/v1/client + /ws/client│   │ PostgreSQL 17        │   │
                                                           │   │ (only the server)    │   │
                                                           │   └──────────────────────┘   │
                                                           └──────────────────────────────┘
```

## 1. Components

| Component           | Technology                                                          | Role                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **likapcs-server**  | Node 20, TypeScript, Fastify 5, `ws` (via @fastify/websocket), `pg` | Single source of truth. Authentication, authorisation, all business rules, billing, session state, realtime hub, migrations, backups (Ph. 6) |
| **likapcs-admin**   | React 18, TypeScript, Vite 5, TanStack Query, Tauri 2 (Rust shell)  | Staff UI: dashboard, stations, POS, inventory, purchases, customers, employees, cash, reports, settings                                      |
| **likapcs-client**  | Tauri 2 / Rust (Phase 4)                                            | Customer PC agent: lock/welcome screen, session timer, safe remote commands, device registration                                             |
| **packages/shared** | TypeScript library                                                  | Money math, formatting rules, permission catalogue, settings schema, API DTOs (zod), WebSocket protocol, version compatibility               |
| **database**        | Plain SQL migrations                                                | Versioned, forward-only schema; checksummed; applied by the server                                                                           |

### Why these choices

- **PostgreSQL instead of SQLite.** Several Admin workstations and up to dozens of client PCs write
  concurrently (heartbeats, sessions, sales). SQLite over a network share is unsafe and is explicitly
  not supported. PostgreSQL also gives us transactional integrity, row locks for billing, `pg_dump`
  backups and advisory locks for migrations. SQLite remains a possible future option **only** for a
  single-machine installation and would still be accessed exclusively through the server.
- **One server process owns everything.** The Admin and the Client are thin; they never compute an
  authoritative price or write to the database. If a UI is wrong, money is still right.
- **Fastify + `ws`** keeps HTTP and WebSocket on one port (4700), which simplifies firewall rules on
  Windows LANs.
- **Tauri 2** gives small native Windows installers (NSIS), WebView2 rendering and a Rust side for
  things that need OS access on the client (lock screen, power actions, DPAPI secret storage).
- **Plain SQL migrations** instead of an ORM: the schema is reviewable, diffable and independent of
  any library's migration format. Each file runs in a transaction; the checksum of every applied file
  is stored, so an edited historical migration is detected and refused.

### Deployment shape: one main PC

The product is installed from two installers only (`LIKApcs-Setup.exe` for the main/counter PC and
any extra Admin PC, `LIKApcs-Client-Setup.exe` for gaming PCs). `LIKApcs-Setup.exe` places a
self-contained server runtime next to the Admin executable:

```
LIKApcs\                      (per-user install, %LOCALAPPDATA%\Programs\LIKApcs or similar)
  LIKApcs.exe                  Admin app (Tauri)
  runtime\
    likapcs-server.exe         Node.js 22 runtime (renamed node.exe)
    server\dist\index.js       the server, fully bundled (no node_modules)
    server\dist\cli.js         server CLI: start | stop | status | discover | migrate | create-admin
    server\database\migrations\*.sql
    pgsql\                     portable PostgreSQL 17 (initdb, pg_ctl, postgres + libs)
%LOCALAPPDATA%\LIKApcs-Data\   business data — OUTSIDE the install dir, survives updates/uninstall
  pgdata\                      PostgreSQL cluster (listens on 127.0.0.1:54700 only, scram-sha-256)
  config.json                  generated once: installation id, DB password, control token (0600)
  server.json                  state file of the running server (pid, port, version)
  logs\server.log, logs\postgres.log
  backups\
```

- The server runs as a **detached background process of the logged-in user** (no console window,
  no Windows service, no admin rights). The Admin app starts it when it is not reachable
  (`embedded_server_start`), the installer stops/starts it around every install or update
  (`src-tauri/windows/hooks.nsh`), and "Start LIKApcs when Windows starts" (`--background`) makes it
  available right after sign-in. Closing the Admin window only hides it to the tray.
- With no `LIKAPCS_DATABASE_URL` the server runs in **embedded mode**: it initialises the cluster on
  first start, generates a random database password, starts PostgreSQL on the loopback interface,
  creates the database and applies pending migrations before listening. Nothing is ever prompted.
- **Control endpoint**: `POST /api/v1/system/control/stop` is accepted only from 127.0.0.1 with the
  `x-likapcs-control` token from `config.json`; it is what `cli.js stop`, the installer and the Admin
  app use for a graceful shutdown (server → PostgreSQL fast shutdown → state file removed).
- **LAN discovery**: the server answers UDP datagrams `LIKAPCS_DISCOVER_V1` on port 4701 with
  `{service:"likapcs", installationId, name, port, urls, version}`. Secondary Admin PCs and the
  clients use it to find the main PC; it never grants access — authentication is unchanged. Clients
  probe the reply's source address before any advertised one (see network-protocol §4.7).
- **Windows Firewall**: inbound TCP 4700 / UDP 4701 must be allowed on the main PC. The installer
  adds the rules when it runs elevated (`src-tauri/windows/hooks.nsh`); otherwise the Admin app
  checks the rule by name (`netsh … show rule`, exit code only), shows a banner on Gaming Stations
  and in “Connect a PC”, and adds the rules after one UAC prompt (`allow_firewall`).
- Everything above also works on Linux/macOS with system PostgreSQL binaries (used by the test
  suite: `apps/likapcs-server/test/embedded.test.ts`).

## 2. Repository layout

```
LIKApcs/
├─ apps/
│  ├─ likapcs-admin/        React + Tauri desktop app (src/, src-tauri/)
│  ├─ likapcs-client/       Customer-PC agent (Phase 4; contract documented in README)
│  └─ likapcs-server/       Fastify server (src/, test/, dist/ after build)
├─ packages/shared/         @likapcs/shared — code shared by all apps (money, DTOs, protocol…)
├─ database/migrations/     0001_core.sql … 0007_gaming.sql (forward-only)
├─ docs/                    architecture, database-schema, network-protocol, setup guides
├─ scripts/                 dev-db.sh / dev-db.ps1 (local PostgreSQL bootstrap)
├─ .github/workflows/       ci.yml (lint, typecheck, tests, migration validation, builds), release.yml
├─ package.json             pnpm workspace scripts (lint/typecheck/test/build/db:migrate/dev:*)
└─ .env.example             documented server configuration — the only place secrets are described
```

### Server internals (`apps/likapcs-server/src`)

```
config.ts            env parsing (zod) — no defaults for secrets
db/pool.ts           pg pool; int8 → number with overflow guard; transaction helper
db/migrate.ts        migration runner (advisory lock, checksums, one transaction per file)
security/password.ts scrypt hashing (N=2^16, r=8, p=1), timing-safe verify
security/tokens.ts   random tokens + SHA-256 storage helpers
services/            business logic: audit, settings, users, auth, stations, devices, dashboard…
realtime/hub.ts      in-memory presence (no business state), command dispatch with seq + acks
realtime/*-socket.ts /ws/client and /ws/admin handshakes and message handling
plugins/auth.ts      bearer-token auth, requirePermission()
plugins/error-handler.ts   uniform {error:{code,message,details}} responses, zod → 400
routes/              thin HTTP handlers (validate → service → reply)
app.ts               composition root; index.ts = process entry; cli.ts = migrate/create-admin
```

## 3. Security model

| Concern         | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Passwords       | `crypto.scrypt`, per-user random salt, constant-time compare, configurable minimum length; failed-login counter and temporary lockout (`security.*` settings), all audited                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Staff sessions  | 256-bit random bearer token; only its SHA-256 is stored (`user_sessions`); expiry from `security.session_hours`; logout/reset-password revoke all sessions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Authorisation   | 36 fine-grained permissions grouped into 6 system roles. Checked server-side per route (`requirePermission`). The UI only hides what the server would refuse anyway. Staff can manage only users with strictly lower privileges (owners may manage owners)                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Client devices  | Explicit approval: a PC registers → `pending` → an admin assigns it to a station → the device token is handed out **once** over the registration poll. Token stored hashed; machine-id must match on every handshake. Revoke closes the live socket                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Remote commands | Only to approved, connected devices; each command has a UUID, a per-connection sequence number, an expiry, and must be acknowledged exactly once (duplicates ignored). No shell/arbitrary command exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Secrets         | Nothing is hardcoded. Server config comes from env/.env (gitignored). Update-signing keys and code-signing certificates live only in GitHub Actions secrets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Audit           | Every security-relevant action (login, failed login, user changes, settings, device approval/revocation, station changes) is in `audit_logs` with actor, IP, entity and severity                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Transport       | HTTP + WS on the LAN; optional TLS via `LIKAPCS_TLS_*`. CORS is restricted to the Admin origins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Recovery path   | `node dist/cli.js create-admin` creates/repairs an owner account from the server console; setup endpoint only works while there are zero users                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Client kiosk    | While locked the client is fullscreen, always-on-top, refocuses itself the moment it loses the foreground, swallows Win/Alt+Tab/Alt+Esc/Alt+F4/Ctrl+Esc/Ctrl+Shift+Esc with a low-level keyboard hook (`src-tauri/src/kiosk.rs`), disables Task Manager via the per-user `DisableTaskMgr` policy (restored on unlock, exit and uninstall) and blacks out secondary monitors. Nothing of this is active during a session. Ctrl+Alt+Del and the secure desktop cannot be intercepted by any application — the staff unlock (server-verified) is the intended way out; “Quit” works only during a staff unlock or on a PC that is not paired yet (never under a customer session) |

## 4. Data conventions

- **IDs**: UUID v4 (`gen_random_uuid()`); append-only logs use `bigserial`.
- **Money**: `BIGINT` minor units (cents) everywhere — DB, API, UI. No floats, ever. Arithmetic is done in
  `BigInt` with explicit _half-away-from-zero_ (commercial) rounding — see `packages/shared/src/money.ts`
  (`multiplyByQuantity`, `percentOf`, `splitInclusiveTax`, `roundToIncrement`), all unit-tested.
- **Quantities**: `BIGINT` milli-units (1.000 = `1000`) so weights/volumes work without floats.
- **Percentages**: integer basis points (18 % = `1800`).
- **Time**: `TIMESTAMPTZ` in UTC; the business time zone (`locale.timezone`) is applied only when
  formatting and when computing "today" for reports.
- **Enumerations**: `text` + `CHECK` constraints (easy to extend by migration, readable in dumps).
- **Snapshots**: sale lines store the product name, unit price, tax rate and **cost** at the time of
  sale; sessions snapshot the hourly rate. Reports never depend on current catalogue values.
- **Idempotency**: `sales.client_request_id`, `session_events.command_id`, exactly-once token
  hand-out and single-ack commands protect against double submission over flaky Wi-Fi.
- **Concurrency**: financial operations run in one DB transaction with `SELECT … FOR UPDATE` on the
  affected rows; `gaming_sessions.version` provides optimistic concurrency for UI edits.

## 5. Financial definitions (used by dashboard and reports)

| Term                      | Definition                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Revenue**               | Sum of `sales.total_cents` for sales **completed** in the period (product sales + gaming time)                                                                                  |
| **Refunds**               | Sum of `refunds.total_cents` in the period (reduces revenue)                                                                                                                    |
| **COGS**                  | Sum of `sale_items.cost_cents` (per-line cost snapshot taken at sale time from the product's average cost)                                                                      |
| **Gross profit**          | Revenue − Refunds − COGS                                                                                                                                                        |
| **Operating expenses**    | Sum of `expenses.amount_cents` in the period (rent, utilities, wages…). **Stock purchases are not expenses** — they become inventory and hit profit only through COGS when sold |
| **Operating profit**      | Gross profit − Operating expenses (labelled "estimated" in the UI because it ignores depreciation/taxes)                                                                        |
| **Purchases received**    | Sum of received purchase values (cash-flow figure, shown separately, never subtracted from profit)                                                                              |
| **Cash register balance** | Opening float of the open shift + cash sales − cash refunds ± manual cash movements                                                                                             |

## 6. Realtime design

- `RealtimeHub` keeps only _who is connected_ and _which commands await an ack_. Restarting the
  server loses nothing: clients reconnect, sessions are recomputed from the database.
- Station status is derived on read: `disabled` → `offline` (no connected device) → `available` →
  `occupied/paused/locked` (Phase 3 sessions). Admin screens receive `station.changed` /
  `device.changed` events and refetch; they also poll every 20 s as a safety net.
- Heartbeats are recorded in `station_heartbeats` (pruned after 7 days) so "last seen" survives a
  restart.
- Grace periods: when a client disconnects during a session, the session keeps running on the
  server for `stations.session_grace_seconds`; staff are alerted and billing is never computed by the
  client (Phase 3).

## 7. Version & compatibility policy

- SemVer across all packages; a release tag `vX.Y.Z` must match the `version` of root, admin and
  server `package.json` (enforced by `release.yml`).
- Protocol version is an integer (`PROTOCOL_VERSION = 1`) negotiated in every hello.
- An Admin or Client may connect to a server with the **same major** and a **minor ≥ its own**; older
  servers are refused with a clear error so you always update the server first.
- Database schema version = highest applied migration; `GET /system/health` reports it.

## 8. Phase plan (what exists today)

| Phase | Scope                                                                                                                                  | Status                                                                                                                                     |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | Foundation: monorepo, schema, server core, auth/roles, stations & devices, Admin shell, CI, signed releases                            | **Implemented & verified**                                                                                                                 |
| 2     | Embedded main-PC server (bundled PostgreSQL + Node runtime, Windows service-less supervisor, ServerGate), discovery, remember-me login | **Implemented** (desk-checked Rust; Windows build in CI)                                                                                   |
| 3     | Pricing rules, packages, gaming sessions, live timers, exactly-once session billing, PanCafe-style station map                         | **Implemented & verified**                                                                                                                 |
| 4     | LIKApcs-Client agent: registration, lock/welcome screen, timer overlay, safe staff commands, reconnection                              | **Implemented** (web shell verified; Tauri shell desk-checked)                                                                             |
| 5     | Catalogue, inventory, POS (barcode scanner, discounts, mixed tenders, parked sales, refunds, receipts)                                 | **Implemented & verified**                                                                                                                 |
| 6     | Cash register shifts & drawer ledger, expenses, customers, reports & CSV export                                                        | **Implemented & verified**                                                                                                                 |
| 7     | Purchases & suppliers UI, backups/restore dashboard, update dashboard, invoices/printing templates                                     | **Implemented & verified** — purchases, backups/restore, updates dashboard, A4 invoices (issue/print/void) and the POS & Printing settings |
| 8     | Hardening, acceptance-test pass, installer polish, employee permission matrix UI                                                       | Not started                                                                                                                                |
