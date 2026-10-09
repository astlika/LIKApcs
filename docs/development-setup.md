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

## 7. Phase 1 walkthrough (what to try)

1. **Dashboard** — live figures from the database (all zero until Phase 2 adds sales).
2. **Gaming Stations → Add station** — create PC 01…PC 10.
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

## 8. Tests, lint, build

```bash
pnpm test              # shared (20) + server integration (48, needs likapcs_test DB) + admin (6)
pnpm lint
pnpm typecheck
pnpm build             # shared, server (dist/), admin web bundle (dist/)
pnpm format            # prettier
```

Server tests use `LIKAPCS_TEST_DATABASE_URL` (default
`postgres://likapcs:likapcs_dev_password@127.0.0.1:5432/likapcs_test`). Each test file re-creates the
schema from the migrations, so the migration set is validated on every run.

## 9. Running the server as a Windows service

Use the release bundle (`likapcs-server-<version>.zip`) and `deploy\install-windows.ps1`; the
procedure is documented in `apps/likapcs-server/deploy/README.md`. For a development checkout, run
`pnpm dev:server` in a terminal instead.

## 9b. Testing the in-app updater

The updater only exists in the packaged desktop app (`pnpm --filter @likapcs/admin tauri build`),
never in the Vite/browser build. To try it end-to-end:

1. Install `LIKApcs-Setup.exe` from release `vA` on a Windows PC.
2. Publish release `vB` (> `vA`) — `pnpm release:bump B`, changelog entry, tag, push.
3. Start the installed app: after ~8 s the topbar shows **Update available · vB**; Settings → About →
   **Download and install** shows progress, verifies the signature, runs the installer and restarts.

The manifest the app reads is `https://github.com/<owner>/LIKApcs/releases/latest/download/latest.json`.
If the app says it is up to date although a newer release exists, check that the release is
published (not draft / pre-release) and that `latest.json` is attached to it.

## 10. Troubleshooting

| Symptom                                              | Fix                                                                                           |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `Invalid server configuration: LIKAPCS_DATABASE_URL` | `.env` missing in `apps/likapcs-server/` or you started from another directory                |
| `password authentication failed for user "likapcs"`  | password in `.env` ≠ the one given to `dev-db.sh/ps1`                                         |
| Admin shows "Server unreachable"                     | server not running, wrong **Server address**, or firewall blocking 4700                       |
| "Live updates off" badge                             | WebSocket blocked (proxy/antivirus) — HTTP still works, lists refresh by polling              |
| Migration checksum mismatch on startup               | a historical migration file was edited; restore it and add a new migration instead            |
| Forgot every admin password                          | on the server machine: `node dist/cli.js create-admin` (or `pnpm server:create-admin` in dev) |
