# LIKApcs — Development setup & how to launch

This guide gets the **Phase 1 foundation** running on a developer machine: PostgreSQL, the server,
and the Admin UI (web build in a browser, or the native Tauri window if you have Rust installed).

## 1. Prerequisites

| Tool                       | Version        | Notes                                                                                                                                       |
| -------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                    | 20.11+ (LTS)   | https://nodejs.org                                                                                                                          |
| pnpm                       | 9.x            | `npm install -g pnpm@9` (the repo pins `pnpm@9.15.9` in `packageManager`)                                                                   |
| PostgreSQL                 | 17 (14+ works) | Windows: EDB installer; Debian/Ubuntu: `apt install postgresql`                                                                             |
| Git                        | any recent     |                                                                                                                                             |
| Rust + Tauri prerequisites | stable         | **Only** for the native desktop window / installers: https://tauri.app/start/prerequisites/ (Windows: Visual Studio Build Tools + WebView2) |

## 2. Clone and install

```bash
git clone git@github.com:<your-account>/LIKApcs.git
cd LIKApcs
pnpm install
```

## 3. Database

Create the role and the two databases (`likapcs` for development, `likapcs_test` for the test suite):

```bash
# Linux / macOS (uses sudo -u postgres when available)
./scripts/dev-db.sh                       # default password: likapcs_dev_password
./scripts/dev-db.sh 'a-stronger-password' # or your own

# Windows PowerShell (psql on PATH)
.\scripts\dev-db.ps1                      # -Password … -SuperUser postgres
```

The scripts are idempotent. They only create a **local development** role — production
installations get their own credentials in Phase 6's installer, never the defaults.

## 4. Server configuration

```bash
cp .env.example apps/likapcs-server/.env
```

Edit `apps/likapcs-server/.env` — at minimum `LIKAPCS_DATABASE_URL`:

```
LIKAPCS_DATABASE_URL=postgres://likapcs:likapcs_dev_password@127.0.0.1:5432/likapcs
LIKAPCS_HOST=0.0.0.0
LIKAPCS_PORT=4700
LIKAPCS_AUTO_MIGRATE=true
LIKAPCS_LOG_LEVEL=info
```

`.env` is git-ignored. The server refuses to start without a database URL — there are no built-in
credentials anywhere.

Session lifetimes: `LIKAPCS_SESSION_HOURS` (default 12) for normal sign-ins, `LIKAPCS_REMEMBER_DAYS`
(default 30) when the user ticks **Stay signed in on this PC** on the login page. Without the tick the
token is only kept until the Admin app is closed.

## 5. Apply migrations and start the server

```bash
pnpm db:migrate          # applies database/migrations/0001…0007 (also happens automatically on start)
pnpm db:status           # prints the applied versions

pnpm dev:server          # tsx watch → http://0.0.0.0:4700 (auto-restarts on code changes)
```

Check it: `curl http://127.0.0.1:4700/api/v1/system/health` →
`{"status":"ok","version":"0.1.0","schemaVersion":7,"database":"ok",...}`.

## 6. Start the Admin app

### Option A — in the browser (fastest, no Rust needed)

```bash
pnpm dev:admin           # Vite → http://localhost:1420  (proxies /api and /ws to 127.0.0.1:4700)
```

Open http://localhost:1420. On a fresh database you land on the **setup wizard**:
business name → owner account (username + password ≥ 8 chars with letters and digits). You are then
signed in as the owner.

If your server runs on another machine, either start Vite with
`LIKAPCS_SERVER_URL=http://192.168.1.10:4700 pnpm dev:admin`, or open the login screen →
**Server address** → enter the URL → **Test connection**.

### Option B — native desktop window (Tauri)

```bash
pnpm --filter @likapcs/admin tauri dev     # requires the Rust toolchain
pnpm --filter @likapcs/admin tauri build   # Windows: produces an NSIS installer under src-tauri/target/release/bundle/nsis/
```

> The native build has **not** been executed in the Phase 1 environment (no Rust/WebView there).
> The configuration is in place and the web bundle is verified; the first native build should be done
> on a Windows machine or via the `windows-smoke` CI job (Actions → CI → Run workflow).

## 6b. Start the Client (gaming-PC agent)

```bash
pnpm --filter @likapcs/client dev        # http://localhost:1421 (Vite proxies /api and /ws to :4700)
```

In the browser the agent runs in **development mode**: it pairs with the server that served the page
(same origin), stores its secrets in `localStorage`, uses a random machine id and the hostname
`browser-dev`. The PC appears under _Stations → Pending devices_ in the Admin app; approve it and
assign a station and the lock screen shows the station code. Then open the station in the Admin
app and use **Lock / Unlock / Show message** — each one is acknowledged by the agent within a second.
`Ctrl+Alt+S` opens the technician panel (server URL, language, status, errors).

Native window (needs Rust; Windows is the target platform, Linux works for development):

```bash
pnpm --filter @likapcs/client tauri dev
```

The native build adds: the real machine id (`MachineGuid`), secrets in the Windows Credential
Manager, UDP discovery of the server, the fullscreen kiosk window with focus guard, the top-right
timer overlay during sessions, `shutdown /r|/s` for staff power commands and the signed auto-updater
(`latest-client.json`). Nothing in the agent depends on being inside Tauri — the same code is driven
end-to-end by `apps/likapcs-server/test/integration/client-agent.test.ts`.

### Kiosk hardening of the gaming PCs (outside the application)

The client keeps its window fullscreen, always on top and refocused, blocks the browser-level
shortcuts and context menu, and cannot be closed from its own window. It does **not** replace the
Windows shell. For a real venue, additionally:

1. Create a dedicated standard (non-administrator) Windows user for customers; install
   `LIKApcs-Client-Setup.exe` **while logged in as that user** (per-user install, autostart entry).
2. Enable automatic logon for that user (`netplwiz`) so the lock screen appears right after boot.
3. Restrict Task Manager / Ctrl+Alt+Del options with local Group Policy
   (`User Configuration → Administrative Templates → System → Ctrl+Alt+Del Options`) or use Windows
   Assigned Access / Shell Launcher for a true single-app shell.
4. Keep the Admin/main PC on a staff-only network segment or VLAN if customers plug in their own
   devices; the client only needs TCP 4700 and UDP 4701 to the main PC.

## 7. Phase 1 walkthrough (what to try)

1. **Dashboard** — live figures from the database (all zero until Phase 2 adds sales).
2. **Gaming Stations → Add station** — create PC 01…PC 10. The page is a PanCafe-style map: click a
   PC icon to select it, double-click / **Enter** for the main action (Start or Stop), right-click for
   every action (Pause, Add time, Lock screen, Message, Restart, Shut down, Cancel, Details), arrow
   keys to move, **Esc** to deselect. Icon colours: green free, blue in use, amber expiring/paused,
   purple locked, grey offline/disabled.
3. Simulate a client PC registering (what LIKApcs-Client will do in Phase 4):

   ```bash
   SECRET=$(openssl rand -base64 32 | tr -d '=+/')
   curl -s -X POST http://127.0.0.1:4700/api/v1/client/register \
     -H 'content-type: application/json' \
     -d "{\"machineId\":\"WIN-TEST-0001-ABCDEF\",\"hostname\":\"GAMING-PC-01\",\"osInfo\":\"Windows 11\",\"appVersion\":\"0.1.0\",\"registrationSecret\":\"$SECRET\"}"
   # → {"registrationId":"…","status":"pending"}
   ```

   The **Devices awaiting approval** panel appears instantly (WebSocket). Assign it to a station and
   approve. Then poll as the client would:

   ```bash
   curl -s "http://127.0.0.1:4700/api/v1/client/registration/<registrationId>?secret=$SECRET"
   # first call → {"status":"approved","deviceToken":"…","station":{…}}   second call → no token
   ```

4. **Employees** — add a cashier; sign out and sign in as that user to see permission-based
   navigation; try to edit the owner (refused by the server).
5. **Settings** — change the business name/currency; the top bar and money formatting update
   immediately. Switch **EN/SQ** at any time.
6. **Audit log** — every action above is recorded with actor and IP.

## 7b. Phase 6 walkthrough — cash register, expenses, customers, reports

1. **Top bar** shows a shift pill (_No open shift_ / _Shift open · €…_). It polls `GET /cash/status`.
2. **Point of Sale → cash sale** while no shift is open → the server answers `409 SHIFT_REQUIRED`
   and the Admin opens the _Open shift_ dialog (opening float, optional note). Confirm → the sale is
   retried automatically and completes. Card sales are never blocked. To allow cash sales without a
   shift, set `cash.require_open_shift = false` in **Settings** (not recommended for real use).
3. **Finance → Cash Register** — live drawer summary (opening float, cash sales, refunds, pay-in /
   pay-out, drawer expenses, expected cash), _Pay in_ / _Pay out_ (a pay-out above the expected
   drawer content is refused), the ledger of the current shift, and _Close shift_ with the counted
   amount; a difference above `cash.difference_warning_cents` (default €5.00) is highlighted and the
   closing report can be printed (`Print report`). Past shifts are listed with their difference.
4. **Finance → Expenses** — record an expense (date, category, amount, payment method, description,
   _paid from the cash drawer_). Drawer expenses need an open shift and appear in the ledger; voiding
   restores the cash. Bank/card expenses only affect the reports.
5. **Finance → Customers** — create a customer (code `C-000001`), set membership / default discount,
   open the detail page for lifetime stats, recent receipts and sessions; _Archive_ hides without
   deleting. Pick the customer in POS or when starting a session to link the sale.
6. **Finance → Reports** — Today / Yesterday / This week / This month / Last month / custom range:
   net sales, gaming, refunds, expenses, VAT, sales by day/hour, by payment method, retail vs gaming,
   top products, categories, per station, per employee and the closed shifts of the range.
   **Export CSV** downloads `likapcs-<kind>-<from>_<to>.csv` (UTF-8 BOM, `;` separator).
7. Roles: cashiers can open/close shifts and move cash; expenses and reports need the Manager,
   Administrator or Owner role; the Accountant role sees everything read-only.

## 8. Tests, lint, build

```bash
pnpm test              # shared (41) + server integration (91, needs likapcs_test DB) + admin (15) + client (10)
pnpm lint
pnpm typecheck
pnpm build             # shared, server (dist/), admin web bundle (dist/)
pnpm format            # prettier
```

Server tests use `LIKAPCS_TEST_DATABASE_URL` (default
`postgres://likapcs:likapcs_dev_password@127.0.0.1:5432/likapcs_test`). Each test file re-creates the
schema from the migrations, so the migration set is validated on every run.

## 9. Running the server as a Windows service

Use the server bundle (`likapcs-server-<version>.zip`, artifact of the Release workflow run — not a
release download) and `deploy\install-windows.ps1`; the
procedure is documented in `apps/likapcs-server/deploy/README.md`. For a development checkout, run
`pnpm dev:server` in a terminal instead.

## 9a. Embedded mode (what the installer does)

Without `LIKAPCS_DATABASE_URL` the server creates and runs its own PostgreSQL cluster. To try it on a
developer machine (PostgreSQL binaries must be installed; set `LIKAPCS_PG_BIN` if they are not found):

```bash
pnpm --filter @likapcs/server build
LIKAPCS_DATA_DIR=/tmp/likapcs-demo LIKAPCS_PORT=4710 node apps/likapcs-server/dist/cli.js start
LIKAPCS_DATA_DIR=/tmp/likapcs-demo LIKAPCS_PORT=4710 node apps/likapcs-server/dist/cli.js status
node apps/likapcs-server/dist/cli.js discover          # UDP broadcast, lists running servers
LIKAPCS_DATA_DIR=/tmp/likapcs-demo LIKAPCS_PORT=4710 node apps/likapcs-server/dist/cli.js stop
```

In the packaged Admin app the bundled server is started automatically at launch (`ServerGate`); if it
is down, the login page shows **Start server**, and _Settings → Server on this PC_ offers Start / Stop /
Restart, the Windows Firewall rule, start-at-login and a live tail of
`%LOCALAPPDATA%\LIKApcs-Data\logs\server.log`.

The Windows runtime that ships inside `LIKApcs-Setup.exe` is produced by `scripts/stage-runtime.ps1`
(Node.js and the portable PostgreSQL are downloaded from nodejs.org / Maven Central and verified
against pinned SHA-256 values); `pnpm --filter @likapcs/admin tauri build` then bundles
`src-tauri/runtime/`. Both steps run in CI (`release.yml`, and `ci.yml` on manual dispatch).

## 9b. Testing the in-app updater

The updater only exists in the packaged desktop app (`pnpm --filter @likapcs/admin tauri build`),
never in the Vite/browser build. To try it end-to-end:

1. Install `LIKApcs-Setup.exe` from release `vA` on a Windows PC.
2. Publish release `vB` (> `vA`) — `pnpm release:bump B`, changelog entry, tag, push.
3. Start the installed app: after ~8 s the topbar shows **Update available · vB**; Settings → About →
   **Download and install** shows progress, verifies the signature, runs the installer and restarts.

The manifest the app reads is `https://raw.githubusercontent.com/<owner>/LIKApcs/release-feed/latest.json`
(branch `release-feed`, written by the Release workflow after the release is published). If the app
says it is up to date although a newer release exists, check that the _Publish updater feed_ step of
the release run succeeded and that `latest.json` on that branch carries the new version
(raw.githubusercontent.com caches for up to 5 minutes).

## 10. Troubleshooting

| Symptom                                              | Fix                                                                                           |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `Invalid server configuration: LIKAPCS_DATABASE_URL` | `.env` missing in `apps/likapcs-server/` or you started from another directory                |
| `password authentication failed for user "likapcs"`  | password in `.env` ≠ the one given to `dev-db.sh/ps1`                                         |
| Admin shows "Server unreachable"                     | server not running, wrong **Server address**, or firewall blocking 4700                       |
| "Live updates off" badge                             | WebSocket blocked (proxy/antivirus) — HTTP still works, lists refresh by polling              |
| Migration checksum mismatch on startup               | a historical migration file was edited; restore it and add a new migration instead            |
| Forgot every admin password                          | on the server machine: `node dist/cli.js create-admin` (or `pnpm server:create-admin` in dev) |
