# LIKApcs

[![CI](https://github.com/astlika/LIKApcs/actions/workflows/ci.yml/badge.svg)](https://github.com/astlika/LIKApcs/actions/workflows/ci.yml)
[![Release](https://github.com/astlika/LIKApcs/actions/workflows/release.yml/badge.svg)](https://github.com/astlika/LIKApcs/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/astlika/LIKApcs?label=download)](https://github.com/astlika/LIKApcs/releases/latest)

Professional **Gaming Station POS / ERP** ecosystem for internet cafés and gaming centres.

| App                | What it is                                                                                                | Status (Phase 1)                          |
| ------------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **LIKApcs Server** | Local background service — PostgreSQL, HTTP API v1, realtime WebSocket, auth, billing (authoritative)     | ✅ core implemented, 48 integration tests |
| **LIKApcs Admin**  | Windows desktop app (React + Tauri) — dashboard, stations, employees, settings, audit; POS/inventory next | ✅ 7 screens, EN/SQ, dark/light           |
| **LIKApcs-Client** | Windows agent for every customer PC — lock screen, timers, secure device registration                     | ⏳ Phase 4 (server contract ready)        |

Monorepo (pnpm workspaces): `apps/likapcs-server`, `apps/likapcs-admin`, `apps/likapcs-client`,
`packages/shared`, `database/migrations`, `docs`, `.github/workflows`.

## Install (end users)

1. **Server PC** — download `likapcs-server-<version>.zip` from
   [Releases](https://github.com/astlika/LIKApcs/releases/latest), unzip, follow
   `README.md` inside (Node 20 + PostgreSQL, `npm run migrate`, `npm run create-admin`, optional
   Windows service via `deploy\install-windows.ps1`).
2. **Admin PCs** — download and run
   [`LIKApcs-Setup.exe`](https://github.com/astlika/LIKApcs/releases/latest/download/LIKApcs-Setup.exe)
   from the same release (the installer is not Authenticode-signed yet, so Windows SmartScreen shows
   _More info → Run anyway_ the first time). On the login screen enter the server address
   (`http://<server-ip>:4700`).
3. **Updates** — the Admin app checks GitHub Releases on start-up and in _Settings → About_;
   _Download and install_ applies a signature-verified update in one click. The server is updated by
   unzipping the new bundle over the old one and running `npm run migrate` (details in
   `docs/github-setup.md`).

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
- [Database schema](docs/database-schema.md) — migrations 0001–0007, all tables and key columns
- [Network protocol](docs/network-protocol.md) — HTTP API v1, `/ws/admin`, `/ws/client`, device registration flow
- [Development setup](docs/development-setup.md) — prerequisites, launch, tests, troubleshooting
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
