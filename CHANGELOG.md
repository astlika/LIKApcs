# Changelog

All notable changes to LIKApcs are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Admin, Client and Server share one version line.

## [Unreleased]

_Nothing yet._

## [0.3.0] - 2026-10-11

### Added

- **Barcode scans work anywhere on the POS.** Scans are recognised page-wide by their timing
  (`useBarcodeScanner`), whatever has the focus: after tapping a product tile (where Enter used to
  re-add _that_ tile), after a dialog closed (where the focus had dropped to nowhere), inside a
  quantity field (the digits are taken out again), during payment (the product is added and the
  total follows) and on the "sale completed" screen (the next sale starts with the scanned
  product). A stray key with nothing focused is routed into the search field. The Products page
  does the same: a scan on the list finds the product, a scan inside the product dialog adds the
  barcode no matter which field was active.
- **"Sale completed" screen.** The moment a sale is saved the POS shows the change due in large
  type, the receipt preview and _Print_ (P) / _Finish_ (Enter, Esc). It moves on to the next sale
  by itself after `pos.auto_finish_seconds` (default 5 s; 0 waits for the cashier); pressing
  _Print_ stops the countdown. The product grid, sales list and cash figures refresh when the
  screen closes, not while it opens, so it appears instantly.
- **Cash-only by default.** `pos.card_payments` (Settings → POS & Printing → _Accept card
  payments_, default off) removes card from every payment choice in the app — POS, session
  billing, refunds, purchases and expenses. The API and schema still accept `card`, so turning it
  on needs no migration.
- **Pairing that explains itself.** Gaming Stations has a _Connect a PC_ dialog: the three steps,
  the main PC's LAN addresses to type into a client (click to copy, from the new
  `GET /system/network`), the Windows Firewall state of the main PC with an _Allow now_ button, and
  the approval list that refreshes every 3 s while the dialog is open. A banner on Gaming Stations
  warns while the firewall rule for port 4700 is missing (`firewall_status`, rule looked up by name;
  the installer adds the rules itself when run as administrator — `windows/hooks.nsh`).
- **Smarter server discovery in the Client.** A discovery reply lists every address of the main PC,
  virtual adapters included; the client now probes `GET /system/health` on the address the reply
  came from first, then on the advertised ones, and pins the first that answers instead of blindly
  taking the first entry (the classic "found the server but never connects"). When a server answers
  discovery but no address accepts connections, the lock screen says so and points at the firewall
  fix. Staff can type an address right on the lock screen (`192.168.1.10` is enough); it is probed
  before saving and the message is specific: no answer, not a LIKApcs server, or a different
  installation than the one the PC is paired with. The health endpoint now reports
  `installationId` and the business `name`.
- **Client settings panel & tray icon.** The client sits in the notification area (status line,
  _Settings…_, _Check for updates_, _Quit_). The panel (Ctrl+Alt+S, or the tray) has Connection
  (status, address, _Forget pairing_), Updates, General (language) and About sections. Connection
  changes and _Quit_ are only possible before pairing or while a staff member has unlocked the PC —
  never under a customer.
- **Client self-update.** Besides the Admin-pushed `update.apply`, the client checks the signed
  release feed 2 minutes after start and every 6 hours and installs by itself while the PC is
  locked with no session (switchable in the panel); otherwise the new version is offered with
  _Install now_. Updates are never installed during a customer session.
- **Kiosk hardening while locked (Windows).** A low-level keyboard hook swallows the Windows keys
  (so Win+D, Win+Tab, Win+R, Win+L…), Alt+Tab, Alt+Esc, Alt+F4, Ctrl+Esc and Ctrl+Shift+Esc; Task
  Manager is disabled through the per-user policy for the duration of the lock and re-enabled on
  unlock, on exit and by the uninstaller; the window takes the foreground back the instant it
  loses it; secondary monitors are covered by black windows. All of it switches off the moment a
  session or a staff unlock starts.
- **Product pictures.** Products can carry a photo — uploaded from a file (scaled to at most 800 px in the
  Admin before upload) or fetched from a link by the server. Pictures show in the product list and on
  the POS tiles; `PUT|DELETE /products/:id/image`, `POST /products/:id/image/from-url` and the public
  `GET /files/products/:name` route (immutable file names, long caching). Files live in
  `<dataDir>/uploads/products` (`LIKAPCS_UPLOAD_DIR`) and are not part of database backups
  (`docs/backups.md`). Migration `0011` adds `products.image_path`.
- **Staff unlock on the gaming PC (Ctrl+Alt+A).** A staff member types their own LIKApcs username and
  password on the locked Client; the server verifies them (`stations.unlock` permission, same lockout
  and rate limits as login) and unlocks the PC for maintenance — no session, no billing. The grant
  ends after `stations.maintenance_minutes` (Settings → Stations, default 15), with the _Lock_ button
  on the widget, with an Admin lock, or when a session starts; the PC re-locks by itself even if the
  server is unreachable. The Admin map shows such PCs as _Maintenance_ (wrench, name, countdown), and
  _Unlock_ in the Admin is now the same time-limited grant. New device-token routes
  `POST /client/staff-unlock` / `/client/staff-lock`; audit `station.maintenance_*`.
- **Client countdown widget.** The always-on-top strip is now a 300 × 96 widget with the station
  code, a large HH:MM:SS, a progress bar for prepaid time, amber/red low-time states, the offline dot,
  staff messages, and the maintenance view with the _Lock_ button. It can be dragged anywhere.
- **Server startup diagnostics.** The embedded server writes `startup.json` (phase, timings, last
  error) next to `server.json`; the Admin start screen shows the live phase, how long it took, and the
  real error text with _Retry_ / _Show log_ actions instead of a generic "starting…" that could
  spin for minutes. A wrong embedded database password is repaired automatically.

### Changed

- **No more surprise printing.** `pos.auto_print_receipt` is off by default and migration 0012
  switches existing installations off too: the print dialog used to pop up after every sale and
  block the cashier for seconds. Turn it back on in Settings → POS & Printing if receipts must
  always print; the countdown then resumes after the print dialog closes.
- **Payment dialog.** The cash field is pre-filled with the exact total (typing replaces it) and
  Enter completes the sale, so an exact cash sale is F6 → Enter. An amount more than €100 000 above
  the total is rejected as a mistyped or mis-scanned code. The cart's quantity field commits on
  Enter / blur (fractional quantities such as 0.5 could not be typed before).
- `pos.scan_increments_quantity` is gone: the cart always merges repeated scans of a product into
  one line; the toggle never did anything (removed by migration 0012).
- **Faster, more robust main-PC start.** The embedded PostgreSQL is recognised as already running
  from its `postmaster.pid` (no `pg_ctl` round trip), a stale pid file after a crash is removed, the
  wait loop fails fast on authentication errors instead of retrying until the timeout (the cause of
  the "starts for a minute, then nothing" reports), and the cluster runs with a lighter
  configuration. The Admin launches the server without blocking and follows its phases live.
- **Password minimum is 4 characters** (short PINs for cashiers). `security.min_password_length` is
  enforced server-side (default 4; existing installations that still had the seeded 8 are moved to 4
  by migration 0011) and can be raised in Settings → Security.
- Dialog inputs no longer lose focus after each keystroke (New employee / product dialogs typed one
  character at a time).
- Admin tiles and lists tolerate external picture links (`img-src http: https:` in the CSP).

### Fixed

- The product dialog's VAT selector showed the literal `{rate}` placeholder instead of the default
  rate.
- Deleting a never-sold product now also removes its picture file.

## [0.2.1] - 2026-10-10

### Changed

- **Release page = two files.** A release now offers exactly `LIKApcs-Setup.exe` (main PC: Admin +
  server) and `LIKApcs-Client-Setup.exe` (gaming PCs), with a download table and SHA-256 checksums in
  the release notes. The versioned duplicates, `.sig` files, server zip and `SHA256SUMS.txt` are no
  longer attached; the server bundle remains a workflow artifact for manual deployments.
- **Update feed moved to the `release-feed` branch.** `latest.json`, `latest-client.json` and
  `SHA256SUMS.txt` are written by the release workflow to
  `https://raw.githubusercontent.com/astlika/LIKApcs/release-feed/` (signatures are embedded in the
  manifests, as before). Admin, Client and the server's Updates page read from there.
  _Installations of 0.1.1 / 0.2.0 still look at the old feed and will not see this or later versions
  by themselves — install 0.2.1 once by hand; from then on updates arrive automatically._

## [0.2.0] - 2026-10-10

First complete release of the ecosystem: one installer for the main PC (Admin + embedded server +
PostgreSQL), one for the gaming PCs, and all business modules of Phases 2–7 — live station map and
session billing, POS with receipts and A4 invoices, products and inventory, purchasing and suppliers,
customers, cash register and expenses, reports, backups/restore, and the updates dashboard with
signed auto-updates. Everything below was verified by the automated test suites (shared 44, server
113, Admin 15, Client 10) and by browser end-to-end runs against a real PostgreSQL database.

### Added

- **Invoices & printing (Phase 7d).** A4 invoices (`F-<year>-NNNNNN`, gap-free) can be issued for
  any completed sale from _Sales › sale › Issue invoice_: buyer picked from the customer list or typed
  in (name, tax/VAT number, address, e-mail), notes and payment term. The document is rendered by the
  Admin app in the operator's language (seller/buyer blocks, lines with VAT, VAT breakdown, payments
  net of change, balance due, bank details and footer from settings) and printed through an isolated
  print document, so the layout never depends on the application stylesheet. Reprints are marked
  _COPY_ and audited (`print_jobs`, `invoice.reprinted`); voiding needs a reason, keeps the number and
  frees the sale for a new invoice (`invoices_one_live_per_sale`). New Admin page _Invoices_
  (`invoices.view`/`invoices.manage`; search, status/period filters, totals, print, void), invoice
  number shown in the sales list, `GET/POST /invoices`, `GET /invoices/:id`,
  `GET /invoices/:id/document`, `POST /invoices/:id/void`, migration `0010_invoices_printing.sql`.
- **Settings › POS & Printing.** Receipt paper width (80/58 mm), _print receipt automatically_
  (the POS now prints the receipt right after a completed sale when enabled), _scanner increments
  quantity_, receipt footer, default invoice payment term, bank details and invoice footer
  (`printing.*` settings).

- **Updates dashboard (Phase 7c).** New Admin page _Updates_ (`updates.manage`): version of the
  main PC (server + Admin + schema), newest release published on GitHub (read from the signed
  update manifests `latest.json` / `latest-client.json`, cached in `application_versions` so the
  page works offline), every approved client PC with its version, online state and
  current / outdated / newer badge, one-click _Update all clients_ (`update.apply` to online
  outdated clients) and the history of update attempts. Clients' `update_status` WebSocket events
  now become `update_history` rows (one per attempt, with the error message); the server records
  its own version change at start-up and the Admin app reports its completed self-update once
  (`POST /system/updates/events`). Optional start-up feed check (`updates.check_on_startup`) and
  `LIKAPCS_UPDATE_FEED_URL` for a local release mirror. Routes: `GET /system/updates`,
  `POST /system/updates/check|push|events`. EN/SQ.
- **Backups & restore (Phase 7b).** Node-native backup engine (works with the embedded Windows
  PostgreSQL that has no `pg_dump`): every table is copied inside one repeatable-read snapshot into a
  `*.likapcs-backup.tar.gz` archive (`manifest.json` + `tables/*.csv`), written to the backup folder
  outside the install directory (`LIKAPCS_BACKUP_DIR`, default `<data dir>/backups`), recorded in
  `backup_history` with SHA-256 and duration. Daily scheduler (`backup.enabled` / `backup.time` in the
  business time zone / `backup.keep_count` retention of scheduled archives). Restore — behind
  `backups.manage`, the administrator's re-typed password and an explicit acknowledgement — takes a
  `pre_restore` safety copy, then truncates and reloads all tables in foreign-key order in one
  transaction, resets sequences, keeps the backup history and the acting session, refuses archives
  of another schema version, notifies Admin apps (`system.restored`) and makes client PCs reconnect.
  Routes `/backups` (list, create, upload, download, delete, restore). Admin: **Backups** page
  (schedule and folder overview, back up now, upload, download, delete, restore dialog with result).
  `docs/backups.md` documents the format, retention, restore and moving to a new PC.
- **Suppliers & purchases (Phase 7a).** Server: `PurchasingService` — suppliers (unique names,
  deactivate instead of delete, purchase totals and open balance per supplier) and purchases with
  references `B-<year>-NNNNNN`: lines in milli-quantities with unit cost and VAT, additional costs,
  immediate or later (partial) receiving that books `purchase_receipt` inventory movements and keeps
  `products.purchase_cost_cents` (last) and `average_cost_cents` (weighted average) current, supplier
  payments by any method where cash leaves the open drawer as a `supplier_payment` movement, and
  cancellation only for untouched orders. Routes under `/suppliers` and `/purchases` guarded by
  `purchases.view` / `suppliers.manage` / `purchases.manage` / `purchases.pay`; audit entries for
  every write. Admin: **Suppliers** page (search, contacts, balances, edit / deactivate) and
  **Purchases** page (filters with period summary, new-purchase form built from a scanner-friendly
  product picker with live subtotal / VAT / total, receive-now and pay-now options, detail dialog to
  receive outstanding lines, record payments through the shift guard and cancel). Navigation,
  command palette and EN/SQ dictionaries extended; integration tests for weighted average cost,
  partial receipts, drawer payments and permissions.
- **Cash register, expenses, customers & reports (Phase 6).** Server: `CashService` (registers,
  one open shift per register, opening float, pay-in / pay-out with an insufficient-cash guard, close
  with counted amount → expected / difference frozen on the shift, drawer ledger written only inside
  the transactions that move money: net cash of sales and cash-paid sessions, cash refunds, drawer
  expenses and their voids), `ExpensesService` (seeded categories EN/SQ, expenses by date / category /
  payment method, _paid from the drawer_ needs an open shift, void with reason), `CustomersService`
  (generated codes `C-000001`, search by name / phone / code, membership, default discount,
  blocked / archived status, detail with lifetime stats and recent receipts / sessions) and
  `ReportsService` (sales, refunds, VAT, by day / hour / payment method / source / category / product /
  station / employee, gaming minutes, expenses and closed shifts for any date range; CSV export of
  sales, receipt lines, expenses, sessions and shifts — UTF-8 BOM, `;` separator). Report days and
  CSV timestamps follow the business time zone (`locale.timezone`), not UTC. New setting
  `cash.require_open_shift` (default on): a cash sale or cash-paid prepaid session without an open
  shift is refused with `409 SHIFT_REQUIRED`; `cash.difference_warning_cents` highlights large
  closing differences. Migration `0009` seeds the main register and lookup indexes. Admin: _Finance_
  section with **Cash Register** (live drawer summary, pay-in / pay-out, ledger, close-shift dialog
  with difference preview, printable shift report, shift history), **Expenses**, **Customers** and
  **Reports** (quick ranges, stat tiles, bar charts, tables, CSV download); top-bar shift pill; a
  shift guard that opens the _Open shift_ dialog on `SHIFT_REQUIRED` and retries the original
  action; command-palette entries. All translated EN/SQ. 12 new server integration tests cover the
  whole money trail of a shift against the ledger and the report.
- **Customer on sales and sessions.** Type-ahead customer picker in the POS cart and in both session
  start dialogs (free text still allowed for walk-ins). A customer's default discount
  (`customers.discount_bp`) is applied **by the server** to retail sales when the cashier enters no
  explicit sale discount — no `pos.discount` permission needed, never stacked with a manual
  discount, shown as _Member discount_ in the cart and on the receipt; blocked or archived customers
  are refused (`409 CUSTOMER_NOT_ACTIVE`). Resuming a parked sale restores the linked customer.
  Shared `customerDiscountCents()` is the single implementation used by the POS preview and the
  server (unit-tested).
- Drawer ledger rows carry the receipt / refund number as their reason, so the shift report reads
  like a bank statement.
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

**Main-PC installer (embedded server).** One installer for the main PC: `LIKApcs-Setup.exe` now
contains the Admin app **and** the LIKApcs Server with its own PostgreSQL. No Node.js, PostgreSQL,
`.env` or command line is needed any more.

### Added (installer & embedded server)
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

### Changed (installer & embedded server)
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
