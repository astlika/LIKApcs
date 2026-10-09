# Changelog

All notable changes to LIKApcs are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Admin, Client and Server share one version line.

## [Unreleased]

### Added

- **PanCafe-style station map.** _Gaming Stations_ is now a floor map of PC icons (number on the
  screen, colour = state: free, in use, expiring soon, paused, locked, offline/disabled) with the live
  timer, cost and a prepaid progress bar under each icon. One click selects a PC and enables a fixed
  action bar (Start / Stop, Pause / Resume, Add time, Lock / Unlock screen, Message, Restart,
  Shut down, Details); double-click or **Enter** runs the main action; right-click opens a context
  menu with every action; arrow keys move the selection; **Esc** deselects. Quick start dialog with
  _Open time_ (postpaid), prepaid packages, quick durations and custom minutes, cash/card tender and
  optional customer. Zone filter and grouping, icon-size slider (persisted), legend counts. Keyboard
  and mouse flows are covered by a Playwright script against a real client PC
  (message shown on the PC, unlock on start, lock on stop). Fully translated EN/SQ.
- **Login: "Stay signed in on this PC".** Checked → the server issues a 30-day session
  (`LIKAPCS_REMEMBER_DAYS`, default 30) kept in persistent storage; unchecked → a shift-length
  session (`LIKAPCS_SESSION_HOURS`, default 12) that is forgotten when the app is closed. Shared
  `loginRequestSchema.rememberMe`; integration test for both lifetimes.
- **Main PC server controls.** When the bundled server is not running, the login page shows a
  prominent _Start server_ button (instead of a bare connection error). _Settings → Server on this
  PC_ gains Start / Stop (with confirmation) next to Restart, and a live tail of the server log
  (`embedded_server_log` Tauri command — reads only the server's own log file).

### Fixed

- Station map: a focused PC tile and the page-level keyboard handler no longer both react to
  **Enter**; double-click on a not-yet-selected PC runs the action for that PC (the previous
  implementation read a stale selection).

- **Point of sale, catalogue & inventory (Phase 5).** Server: `CatalogService` (tax categories,
  categories, products with multiple/pack barcodes, generated SKUs, opening stock, archive-instead-of-
  delete for products with history) and `SalesService` (cart pricing from the database only, line and
  sale discounts with largest-remainder tax allocation, tax-inclusive/exclusive prices, cash change,
  mixed tenders, parked sales, completion, void, partial/full refunds with restock, receipt data,
  audited reprints). Stock is reserved in the same transaction as the sale with row locks;
  `409 INSUFFICIENT_STOCK` is atomic. Shared `@likapcs/shared/sale-math` is the integer-cents formula
  used by server and Admin.
- API: `/api/v1/catalog/{tax-categories,categories}`, `/api/v1/products` (+ `/lookup?code=`,
  `/:id/barcodes`, `/:id/stock`), `/api/v1/inventory/movements`, `/api/v1/sales` (+ `/suspend`,
  `/:id/complete`, `/:id/void`, `/:id/refund`, `/:id/receipt`).
- Admin: _Point of Sale_ (scanner/keyboard-wedge detection, category chips and product tiles, cart
  with quantities and permission-gated discounts, F2/F4/F6/F8/Esc shortcuts, cash quick-tender with
  change, card and split payments, park/resume, on-screen receipt and 58/80 mm print layout),
  _Products_ (search, category and low-stock filters, product editor with barcodes and opening stock,
  stock adjustments and counts, movement ledger, categories), _Sales_ (filters, totals, sale detail,
  refund dialog, receipt reprint, resume parked sales). Fully translated EN/SQ.
- Tests: 10 sale-math unit tests, 9 POS integration tests (catalogue, lookup, totals/tax, idempotency,
  permissions, over/under-payment rules, atomic stock, discounts and mixed tenders, park/complete/void,
  refunds, stock counts and ledger, receipts/reprint, archive vs delete), 5 Admin cart tests.

- **Gaming sessions & billing (Phase 3).** Server: `PricingService` (rules + prepaid packages,
  station/weekday/time-window resolution, happy hours, validity dates) and `SessionsService`
  (quote, start, pause, resume, extend, end, cancel, server-side expiry with warnings, grace pause
  for offline PCs, idempotent starts via `clientRequestId`, event timeline with PC acknowledgements).
  Prepaid sessions are paid at start, postpaid sessions are billed **exactly once** at the end; every
  bill is a `sales` row with `sale_items`/`payments` and a `R-<year>-NNNNNN` receipt number from
  `document_sequences`. Pricing terms are frozen per session (`0008_session_billing_terms.sql`).
  Shared `@likapcs/shared/billing` implements the integer-cents formula used by server and Admin.
- API: `GET/POST/PATCH/DELETE /api/v1/pricing/{rules,packages}`, `GET /pricing/packages?stationId`,
  `POST /sessions/quote`, `POST /sessions`, `POST /sessions/:id/{pause,resume,extend,end,cancel}`,
  `GET /sessions`, `GET /sessions/:id`, `GET /sessions/:id/events`. Station summaries now carry the
  live session (`occupied` / `paused` statuses, countdown, current amount); `server.welcome` sends
  the live session to a reconnecting PC; `client.event session_expired_locally` is reconciled.
- Admin: _Pricing_ page (rules and packages CRUD, EN/SQ) and session controls in the station dialog
  (prepaid with packages or custom minutes and a live quote, postpaid, pause/resume, extend, end with
  payment method and permission-gated discount, cancel), live timers and amounts on the station grid.
- Tests: 11 billing unit tests, 7 session integration tests (prepaid/extension/expiry, postpaid
  exactly-once, cancel rules, grace pause, history, permissions), API-driven session test against the
  real client agent, Admin timer projection tests.

- **LIKApcs-Client** (`apps/likapcs-client`): the gaming-PC agent. Lock screen with station code and
  welcome message, prepaid session countdown overlay, automatic server discovery and pairing (server
  pinned by installation id), one-time device approval flow, authenticated WebSocket with heartbeats,
  replay-/expiry-safe command execution with exactly-once acknowledgements, local expiry lock,
  Windows kiosk window with focus guard, Credential-Manager secret storage, autostart, single
  instance, signed auto-update from `latest-client.json`, EN/SQ, technician panel (`Ctrl+Alt+S`).
- Server: `POST /api/v1/stations/:id/command` (lock, unlock, message.show, power.restart,
  power.shutdown, update.apply — permission-checked, acknowledged, audited) and
  `POST /api/v1/devices/update-outdated`; automatic `update.apply` push to outdated clients
  according to the `updates.client_policy` / `updates.maintenance_window` settings.
- Admin: station dialog buttons _Lock / Unlock / Show message / Restart PC / Shut down PC / Update
  client_ and an _Update clients_ action on the Stations page.
- Release pipeline builds and signs `LIKApcs-Client-Setup.exe` and publishes `latest-client.json`;
  `pnpm release:bump` and the version check cover the client package.
- Integration test driving the real client agent against the real server
  (`client-agent.test.ts`).

### Changed

- An approved device may re-register (reinstall) only until its token has been collected; after
  that staff must re-issue the token in the Admin app.

## [0.2.0] - 2026-10-09

One installer for the main PC: `LIKApcs-Setup.exe` now contains the Admin app **and** the LIKApcs
Server with its own PostgreSQL. No Node.js, PostgreSQL, `.env` or command line is needed any more.

### Added
- **Server, embedded mode** — with no `LIKAPCS_DATABASE_URL` the server initialises and runs a
  private PostgreSQL cluster in the per-user data directory (`%LOCALAPPDATA%\LIKApcs-Data`),
  generates its credentials once (`config.json`, mode 0600), applies migrations and listens; all
  without prompts (`src/embedded/*`). Loopback-only `POST /system/control/stop` (token protected)
  for graceful shutdown; `server.json` state file; file logging with size rotation.
- **Server CLI**: `start` (detached background process), `stop`, `status`, `discover`, `data-dir`.
- **LAN discovery**: UDP responder on port 4701 (`LIKAPCS_DISCOVER_V1`), used by secondary Admin PCs
  (login screen → _Find server on the network_, automatic when exactly one server answers) and by the
  upcoming client.
- **Admin desktop shell**: supervises the bundled server ("Starting LIKApcs server…" gate on launch),
  tray icon (Open / Restart server / Close / Stop server and close), close-to-tray, single instance,
  start-at-login with `--background`, `Settings → System → Server on this PC` (status, version,
  data folder, log file, _Restart server_, _Allow through Windows Firewall_, autostart switch).
- `scripts/stage-runtime.ps1`: stages Node.js 22 + portable PostgreSQL 17 (SHA-256 verified
  downloads, trimmed to what `initdb`/`pg_ctl`/`postgres` need) + the bundled server into
  `src-tauri/runtime/`; NSIS hooks stop the server before and start it after every install/update.
- Tests: embedded PostgreSQL lifecycle (initdb → start → auth → stop) and discovery round-trip.

### Changed
- Server bundle is fully self-contained (`tsup` `noExternal`), version embedded at build time.
- Admin updater copy: one update installs Admin + server together on the main PC.
- CI: GitHub Actions bumped to current majors (checkout v7, setup-node v6, upload-artifact v6,
  download-artifact v7, pnpm/action-setup v6) — removes the Node 20 runner deprecation warnings.

## [0.1.1] - 2026-10-09

First update delivered through the in-app updater.

### Security
- Dependency updates closing all open Dependabot alerts: `react-router-dom` 6 → 7.18 (open-redirect
  and SSR hydration advisories), `vite` 5 → 6.4, `vitest` 2 → 4.1 (+ `tinypool`, `esbuild`).
  Navigation, setup wizard, settings deep links and command palette re-verified end-to-end.

### Added
- `.github/dependabot.yml`: weekly grouped dependency PRs (npm, Cargo, GitHub Actions).

### Changed
- README: CI/Release badges and direct download links; docs record the verified `v0.1.0` release.

## [0.1.0] - 2026-10-09

First public release: Phase 1 foundation plus the release/update pipeline.

### Added — Release & updates
- Public GitHub repository with CI (`ci.yml`) and a release pipeline (`release.yml`) that builds the
  signed Windows installer (`LIKApcs-Setup.exe`), the server bundle (`likapcs-server-<version>.zip`),
  `latest.json` and `SHA256SUMS.txt`, and publishes them as a GitHub release.
- **In-app updates for the Admin application**: Settings → About → *Check for updates* →
  *Download and install* (progress, release notes, restart). Updates come from GitHub Releases and are
  verified with the LIKApcs minisign key before installation; an "Update available" badge appears in
  the topbar after the automatic start-up check. Browser builds link to GitHub Releases instead.
- Desktop build defaults the server address to `http://127.0.0.1:4700`; the login screen opens the
  server-address panel automatically when the server cannot be reached.
- Server deployment helpers: `deploy/README.md` and `deploy/install-windows.ps1` (WinSW service +
  firewall rule).
- Scripts: `pnpm release:bump <version>` (sets the version everywhere the release checks) and
  `pnpm secret:scan` (blocks keys/tokens/real `.env` files from being committed).
- Application icon set (`src-tauri/icons`, incl. `icon.ico`).

### Phase 1 — Foundation

#### Added
- Monorepo (pnpm workspaces): `apps/likapcs-server`, `apps/likapcs-admin`, `apps/likapcs-client` (placeholder), `packages/shared`, `database/migrations`, `docs`, `scripts`, `.github/workflows`.
- **Shared library** `@likapcs/shared`: integer-cents money arithmetic with explicit rounding, DD.MM.YYYY / 24h formatting, 36 permissions and 6 system roles, typed settings schema with defaults, zod request schemas and response DTOs, WebSocket protocol v1, SemVer compatibility rules. Unit tests for money, formatting, versions and settings.
- **Database**: migrations `0001_core` … `0007_gaming` creating all 33 required tables (plus supporting tables) with CHECK constraints, partial unique indexes (one approved device per station, one live session per station, one open shift per register), `updated_at` triggers and seeded roles/permissions/settings. Checksummed, transactional, advisory-locked migration runner.
- **Server** (Node 20 / Fastify 5 / PostgreSQL): configuration from environment only; scrypt password hashing; hashed bearer sessions with expiry and lockout after failed logins; permission-checked HTTP API v1 (system/setup, auth, users, roles, settings, stations, devices, audit, dashboard); audit logging; realtime hub with `/ws/admin` (events) and `/ws/client` (hello/heartbeat/sequenced commands with exactly-once acks); device registration with admin approval and one-time token hand-out; heartbeat sweep and connection logs; `cli.js migrate | migrate:status | create-admin`. 48 integration tests + unit tests.
- **Admin** (React 18 / Vite 5 / Tauri 2 scaffold): design system with dark and light themes; English/Albanian with instant switching and a parity test; setup wizard; login with configurable server address; dashboard with real database aggregates; stations grid with live status, add/edit/disable/delete, pending-device approval, revoke/re-issue token, connection log; employees with role matrix, create/edit/deactivate/reset password; settings with dirty tracking and validation; audit log with filters; command palette (Ctrl+K); forced password change; session-expiry handling.
- **CI**: `ci.yml` (lint, typecheck, format check, migration validation against PostgreSQL 17, all tests, server + admin web builds, manual Windows native build) and `release.yml` (tag/version/changelog verification, server bundle, Windows NSIS installer with optional code signing, checksums, draft release).
- **Docs**: architecture (incl. financial definitions), database schema, network protocol, development setup, GitHub setup.

#### Not yet implemented (explicitly)
- POS, inventory, purchases, customers, cash register, expenses, reports, printing (Phase 2 & 5).
- Gaming sessions, pricing, billing and session commands (Phase 3) — schema and protocol are ready.
- LIKApcs-Client application (Phase 4).
- Backups/restore (Phase 6) and signed auto-updates / update dashboard (Phase 7).
- Server and (future) Client updates are not yet orchestrated from the Admin app (Phase 7); the
  server is updated by unzipping the new bundle and running `npm run migrate`.
