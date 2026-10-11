# LIKApcs

[![CI](https://github.com/astlika/LIKApcs/actions/workflows/ci.yml/badge.svg)](https://github.com/astlika/LIKApcs/actions/workflows/ci.yml)
[![Release](https://github.com/astlika/LIKApcs/actions/workflows/release.yml/badge.svg)](https://github.com/astlika/LIKApcs/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/astlika/LIKApcs?label=download)](https://github.com/astlika/LIKApcs/releases/latest)

Professional **Gaming Station POS / ERP** ecosystem for internet cafés and gaming centres.

| App                | What it is                                                                                                                                                                                                             | Status (0.4.0)                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **LIKApcs Server** | Local background service — PostgreSQL, HTTP API v1, realtime WebSocket, auth, session billing, POS, inventory, purchasing, cash register, reports, backups, updates (authoritative)                                    | ✅ schema v12, 126 integration/unit tests                   |
| **LIKApcs Admin**  | Windows desktop app (React + Tauri) — dashboard, live station map, POS, sales & invoices, products, purchases, suppliers, cash register, expenses, customers, reports, backups, updates, employees, audit, settings    | ✅ 19 screens, EN/SQ, dark/light, keyboard-first POS        |
| **LIKApcs-Client** | Windows agent for every customer PC — hardened lock screen, tray icon + settings panel, countdown widget, staff unlock (Ctrl+Alt+A), guided pairing, secure device registration, staff commands, automatic self-update | ✅ agent + kiosk shell, `LIKApcs-Client-Setup.exe` released |

Monorepo (pnpm workspaces): `apps/likapcs-server`, `apps/likapcs-admin`, `apps/likapcs-client`,
`packages/shared`, `database/migrations`, `docs`, `.github/workflows`.

## Install (end users)

LIKApcs has exactly two installers. No separate database or server setup is needed.

1. **Main PC (the counter / cashier PC) — `LIKApcs-Setup.exe`**
   Download [`LIKApcs-Setup.exe`](https://github.com/astlika/LIKApcs/releases/latest/download/LIKApcs-Setup.exe)
   and run it (the installer is not Authenticode-signed yet, so Windows SmartScreen shows
   _More info → Run anyway_ the first time). It installs the Admin app **and the LIKApcs Server with
   its own PostgreSQL database**; the server starts automatically, runs in the background and keeps
   running when the window is closed (tray icon). On first start the app asks you to create the
   owner account. If the installer was run as administrator it already allowed the server through
   Windows Firewall; otherwise _Gaming Stations_ shows a yellow banner with **Allow now** (one
   Windows prompt) — do this once, or the gaming PCs cannot reach the server. Leave **Start LIKApcs
   when Windows starts** on. Business data lives in `%LOCALAPPDATA%\LIKApcs-Data` (never inside the
   program folder).
2. **Other Admin PCs** (optional, e.g. the office) — run the same `LIKApcs-Setup.exe`; the app finds
   the main PC on the local network by itself (_Find server on the network_ on the login screen).
3. **Gaming PCs — `LIKApcs-Client-Setup.exe`**: installs the client that locks the screen between
   sessions and finds the server on the local network by itself. In the Admin app open _Gaming
   Stations → **Connect a PC**_: it shows the address to type on the lock screen if a PC does not
   find the server on its own, the firewall state, and the new PC waiting for approval — assign it
   to a station and it is online. The client starts with Windows, lives in the notification area
   (settings, update check), keeps the lock screen in front (Windows keys, Alt+Tab, Alt+F4 and Task
   Manager are blocked while locked; staff unlock with Ctrl+Alt+A), shows the remaining time in a
   small widget during a session and executes staff commands (lock, unlock, message, restart, shut
   down, update) only after the server has authenticated them. Keeps itself up to date from GitHub
   Releases (signature-verified) — automatically while locked and idle, never during a session.
4. **Updates** — one button. The Admin app checks GitHub Releases on start-up and in
   _Settings → About_; **Download and install** applies a signature-verified update of the Admin app
   _and_ the server on the main PC in one go, the database is upgraded automatically on the next start.

Every release page shows exactly these two files; both are built from the same version and belong
together. Advanced: the server can still be installed on its own (Linux, an existing PostgreSQL, a
Windows service) with `likapcs-server-<version>.zip`, kept as an artifact of the release workflow
run (_Actions → Release → Artifacts_) — see `apps/likapcs-server/deploy/README.md`.

## Quick start (developers)

```bash
pnpm install
./scripts/dev-db.sh                    # PostgreSQL role + databases (Windows: scripts\dev-db.ps1)
cp .env.example apps/likapcs-server/.env   # set LIKAPCS_DATABASE_URL
pnpm db:migrate
pnpm dev:server                        # http://0.0.0.0:4700
pnpm dev:admin                         # http://localhost:1420 → setup wizard (owner pre-filled: admin / admin, editable)
```

Full instructions: [docs/development-setup.md](docs/development-setup.md).

## Documentation

- [Architecture](docs/architecture.md) — components, security model, data conventions, **financial definitions**, phase plan
- [Database schema](docs/database-schema.md) — migrations 0001–0009, all tables and key columns
- [Network protocol](docs/network-protocol.md) — HTTP API v1, `/ws/admin`, `/ws/client`, device registration flow
- [Development setup](docs/development-setup.md) — prerequisites, launch, tests, troubleshooting
- [Backups & restore](docs/backups.md) — archive format, daily schedule, restore procedure, moving to a new PC
- [GitHub setup](docs/github-setup.md) — private repo, branch protection, CI/release workflows, secrets
- [CHANGELOG](CHANGELOG.md)

## Principles

- The server is the only component that touches the database and the only one that computes money.
- Money is integer cents (`BIGINT`), quantities are milli-units, percentages are basis points. No floats.
- Every schema change is a migration; every financial rule has a test; every sensitive action is audited.
- No hard-coded credentials, business names or secrets — configuration via `.env`/settings, secrets via CI secrets.
- Client PCs must be approved by an administrator before they receive any command; commands are sequenced, expiring and acknowledged exactly once.
- Nothing is claimed as "released" until the release workflow has produced and verified the artefact.

## Commands

| Command                                    | Description                                        |
| ------------------------------------------ | -------------------------------------------------- |
| `pnpm dev:server` / `dev:admin`            | development servers                                |
| `pnpm test`                                | all test suites (server tests need PostgreSQL)     |
| `pnpm lint` / `typecheck` / `format`       | quality gates used by CI                           |
| `pnpm build`                               | shared lib, server bundle, admin web bundle        |
| `pnpm db:migrate` / `db:status`            | database migrations                                |
| `pnpm server:create-admin`                 | recovery: create an owner account from the console |
| `pnpm --filter @likapcs/admin tauri build` | native Windows installer (needs Rust)              |

License: proprietary — all rights reserved.
