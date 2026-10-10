# LIKApcs

[![CI](https://github.com/astlika/LIKApcs/actions/workflows/ci.yml/badge.svg)](https://github.com/astlika/LIKApcs/actions/workflows/ci.yml)
[![Release](https://github.com/astlika/LIKApcs/actions/workflows/release.yml/badge.svg)](https://github.com/astlika/LIKApcs/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/astlika/LIKApcs?label=download)](https://github.com/astlika/LIKApcs/releases/latest)

Professional **Gaming Station POS / ERP** ecosystem for internet cafés and gaming centres.

| App                | What it is                                                                                                | Status (Phase 1)                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **LIKApcs Server** | Local background service — PostgreSQL, HTTP API v1, realtime WebSocket, auth, billing (authoritative)     | ✅ core implemented, 48 integration tests                |
| **LIKApcs Admin**  | Windows desktop app (React + Tauri) — dashboard, stations, employees, settings, audit; POS/inventory next | ✅ 7 screens, EN/SQ, dark/light                          |
| **LIKApcs-Client** | Windows agent for every customer PC — lock screen, timers, secure device registration, staff commands     | ✅ agent + kiosk shell (installer pending first release) |

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
   owner account. Then open _Settings → System_ once and click **Allow through Windows Firewall** so
   the other PCs can reach this server, and leave **Start LIKApcs when Windows starts** on.
   Business data lives in `%LOCALAPPDATA%\LIKApcs-Data` (never inside the program folder).
2. **Other Admin PCs** (optional, e.g. the office) — run the same `LIKApcs-Setup.exe`; the app finds
   the main PC on the local network by itself (_Find server on the network_ on the login screen).
3. **Gaming PCs — `LIKApcs-Client-Setup.exe`**: installs the client that locks the screen between
   sessions, finds the server on the local network by itself and asks for a one-time approval in the
   Admin app (_Stations → Pending devices → assign to a station_). It starts with Windows, keeps the
   lock screen in front, shows the remaining time in a small overlay during a session and executes
   staff commands (lock, unlock, message, restart, shut down, update) only after the server has
   authenticated them. Keeps its own copy up to date from GitHub Releases (signature-verified).
4. **Updates** — one button. The Admin app checks GitHub Releases on start-up and in
   _Settings → About_; **Download and install** applies a signature-verified update of the Admin app
   _and_ the server on the main PC in one go, the database is upgraded automatically on the next start.

Advanced: the server can still be installed on its own (Linux, an existing PostgreSQL, a Windows
service) with `likapcs-server-<version>.zip` — see `apps/likapcs-server/deploy/README.md`.

## Quick start (developers)

```bash
pnpm install
./scripts/dev-db.sh                    # PostgreSQL role + databases (Windows: scripts\dev-db.ps1)
cp .env.example apps/likapcs-server/.env   # set LIKAPCS_DATABASE_URL
pnpm db:migrate
pnpm dev:server                        # http://0.0.0.0:4700
pnpm dev:admin                         # http://localhost:1420 → setup wizard
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
