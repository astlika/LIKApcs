# LIKApcs

Professional **Gaming Station POS / ERP** ecosystem for internet cafés and gaming centres.

| App                | What it is                                                                                                | Status (Phase 1)                          |
| ------------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **LIKApcs Server** | Local background service — PostgreSQL, HTTP API v1, realtime WebSocket, auth, billing (authoritative)     | ✅ core implemented, 48 integration tests |
| **LIKApcs Admin**  | Windows desktop app (React + Tauri) — dashboard, stations, employees, settings, audit; POS/inventory next | ✅ 7 screens, EN/SQ, dark/light           |
| **LIKApcs-Client** | Windows agent for every customer PC — lock screen, timers, secure device registration                     | ⏳ Phase 4 (server contract ready)        |

Monorepo (pnpm workspaces): `apps/likapcs-server`, `apps/likapcs-admin`, `apps/likapcs-client`,
`packages/shared`, `database/migrations`, `docs`, `.github/workflows`.

## Quick start

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
