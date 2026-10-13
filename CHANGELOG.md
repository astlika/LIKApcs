# Changelog

All notable changes to LIKApcs are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Admin, Client and Server share one version line.

## [Unreleased]

### Added

- **End Task — close the games on a PC from the desk.** A new **End Task** button sits in the
  station action bar (one PC or every selected PC at once). It closes **only** the programs the
  owner lists in Settings › Stations › _End Task — the programs a PC closes_: bare `name.exe`
  entries, with one-click suggestions for the common games and launchers. LIKApcs-Client, its
  WebView2 and the Windows shell are refused by the Admin, by the server **and** by the PC's own
  Rust layer, so the list can never take a PC down or close the client itself; a protected name
  typed in the box is refused inline before it is even saved. The client runs
  `taskkill /IM <name> /F /T` per program and reports what it closed, what was not running and
  what it could not close — the station dialog shows that outcome as a small badge, and every run
  is audited (`station.command.tasks.end`, `station.tasks_ended`).
  The button **never disappears**: it is simply not pressed, or pressed (green, sunken) once the
  programs are closed, until the next session starts on that PC — and a PC that drops offline for
  a moment keeps its state, so the desk never sees "the games are open again" after a network
  blip. Optionally — Settings › Stations › _Close them automatically when a session ends_,
  **off by default** — the server sends the same command by itself whenever a session expires, is
  stopped or is cancelled. With an empty list the button answers "No programs are listed for End
  Task — add them in Settings › Stations" instead of doing nothing.
  New settings: `stations.end_tasks_exes` (max 60 names), `stations.end_tasks_auto`. New command
  `tasks.end`, new client event `tasks_ended`, new station field `device.tasksEnded`
  (see `docs/network-protocol.md`). Migration `0027_end_tasks.sql` seeds both settings.
- **The countdown widget survives Windows' fullscreen transition (Windows 10/11 fix).** Leaving the
  lock screen is asynchronous on Windows: the shell could restore the window's old rect after the
  widget geometry was applied, leaving the countdown off-screen or behind the desktop — the widget
  simply never appeared. The native shell now re-applies the widget geometry and the topmost flag
  once the transition settles, and the client watches its own window size: if it is not the size it
  asked for, it asks again until it is (self-heals within a second).
- **The PC locks the moment it is switched on.** Windows holds Run-key autostart apps back for up
  to 10 s after logon (`StartupDelayInMSec`), which showed the desktop — taskbar included — before
  the lock screen. The installer and the client now set that delay to 0, and the taskbar auto-hides
  for the whole time the PC is locked (back the moment it is unlocked). The installer refuses
  Windows 7 / 8 / 8.1 with a clear message: a WebView2 application cannot run there, so the client
  supports **Windows 10 and Windows 11**.
- **Station dialog opens Standard, with everything else one click away.** The dialog now starts
  on a few short facts — status, the session panel, the PC and its command buttons — and an
  **Advanced** button next to _Close_ reveals what the desk rarely needs: device facts, hardware,
  Wake-on-LAN, token actions and the connection log. The connection log is only fetched in the
  advanced view, so the dialog opens instantly.
- **Archive PC: a station can leave the floor without losing its money history.** _Archive PC_
  (with a mandatory written reason) takes the station off the map and revokes its PC, so the same
  machine can be paired again — as new, or under another name — while sessions, sales and the
  connection log stay on record. Archived PCs are hidden by default and return with the
  _Show archived_ toggle, greyed and dashed on the map; _Back to the floor_ restores one.
  _Delete_ now also asks for a reason (kept in the audit log), revokes an approved device first,
  and stays refused for stations with session history — those are archived instead. _Revoke_ is
  unchanged. New endpoints `POST /stations/:id/archive`, `POST /stations/:id/unarchive`,
  `GET /stations?includeArchived=true`; migration `0028_archive_station.sql`.

## [0.16.1] - 2026-10-13

Update both apps: **Update** in LIKApcs (Admin) first (server fix; no new migration), then the
gaming PCs (the Client is unchanged in behaviour and is rebuilt only so both installers carry the
same version). Covered by tests (shared 61, server 224 incl. the new concurrency test, admin 40,
client 48) and the browser smokes `multistart` (14 checks), `debts1click` (10), `orderbill` (12),
`display` (28).

### Fixed

- **Several PCs on one tab at once no longer fail.** Starting many PCs together with _Pay
  later_ or _Balance_ for the same customer (new in 0.16.0) started only one of them — the
  parallel starts deadlocked in the database on the receipt number, and the others came back
  with a server error. The same crossing could hit two sales on the same customer's tab at the
  same moment (a PC order and the POS, two cashiers). Every money movement of a customer now
  takes the customer row first, so such transactions queue behind each other; a new server test
  starts 4 PCs × 4 rounds in parallel and mixes concurrent sales, top-ups and repayments
  (`customer-concurrency.test.ts`).
- **Customer display: "Thank you" stays.** After the payment the display went back to the sale
  lines until the cashier pressed _Finish_ (or the 5 s auto-finish) and only then showed the
  thank-you screen for the rest of its 8 s. It now switches to "Thank you" the moment the payment
  is done and stays until a new cart starts or the 8 s pass.

## [0.16.0] - 2026-10-13

Update both apps: **Update** in LIKApcs (Admin) first (server: new endpoint
`POST /customers/:id/debts/reschedule`; no new migration), then the gaming PCs (the Client shows
the total to pay after an order is accepted on the bill). Covered by tests (shared 61, server 222,
admin 40, client 48) and the browser smokes `display` (35 checks), `bulkstart` (12), `custdebts`
(12) and `billtotal` (12). The customer display window placement (Rust) is compiled for the first
time by this release — see the release notes if it misbehaves on a given monitor setup.

### Added

- **Customer display (Ekrani i klientit).** A second window of LIKApcs for the monitor turned
  towards the customers (Settings › POS & Printing › _Customer display_, chosen per PC: on/off,
  monitor, _Open now_). It opens full screen on the chosen (or the first other) monitor and adapts
  to any screen from 480p to 1080p, horizontal or vertical — the layout follows the size and
  orientation live. While nothing is sold it plays the ads program (the same albums / slides /
  intervals as the PCs, grid pages re-flow 3×2 → 2×3 upright, boards use two columns only when
  there is room); during a sale it shows the lines (small square product photo, name, qty ×
  price, line total — the last change highlighted), subtotal / discount / total and the
  customer's debt and balance; during the payment it shows cash handed over, balance used, what
  goes on the tab and the **change** live as the cashier types; after the payment a "Thank you"
  screen with total, paid and change for 8 s, then back to the ads. The window is a dumb screen:
  the main window pushes everything over Tauri events / `BroadcastChannel`, so it holds no
  token and never talks to the server. New endpoint `GET /ads/feed` (any signed-in user) and
  admin event `ads.changed`; the slideshow page builder moved to the shared package
  (`planAlbums` / `buildProgram`) so PC and counter play the same program. _Note: the native
  window placement (Rust) is built only by the release pipeline — it is verified with the 0.16.0
  installers._
- **Start several PCs with a payment step.** Selecting more than one free PC and pressing _Start_
  now offers the same payment methods as a single PC — Cash (with change), **End Pay**, Balance,
  Pay later. Every PC is quoted by its own pricing rule first; the step lists the bills per PC
  and the sum; one amount handed over is split per session (non-cash tenders first, then cash),
  so each receipt carries exactly its own price and the only change is the cashier's (shown in
  the toast). Open time still starts right away.
- **Customers › one-click debt actions.** In the customers list (next to the amount owed) and in
  the customer dialog: **Pay all debt** (the collect dialog pre-filled with everything owed →
  Enter) and **Extend due date** for every open debt of the customer at once (date, +7 / +14 /
  +30 chips, optional note; logged per debt). The Debts page offers _Extend all (n)_ next to
  _Collect all (n)_. New endpoint `POST /customers/:id/debts/reschedule`
  (`customers.manage`).
- **Total to pay on the PC after an order is accepted.** When the desk accepts an order _on the
  bill_, the PC widget's money line switches to the whole amount now due at the desk — PC time
  (running / reserved; nothing for prepaid) **plus** the orders on the bill — and pulses for a
  moment as "Total to pay"; the order panel shows the breakdown (PC time, orders on the bill,
  total). The Admin accept dialog previews the same bill (PC time so far, orders already on the
  bill, this order, total) before the staff confirm.

### Changed

- **"Pagesë në fund"** is the Albanian label of End Pay everywhere in LIKApcs (English keeps
  _End Pay_); open time is "Kohë e hapur (paguan sipas orës në fund)".
- **English first.** LIKApcs opens in English on a PC that has not picked a language yet (EN / SQ
  in the top bar, remembered per PC); the business language in Settings › Locale is now called
  _Customer language_ and drives receipts, the PC lock screen and the customer display only.
- Customer display: the window re-introduces itself when the register window is reloaded, keeps
  a slow heartbeat, text-only slides are centred, and the sale summary carries the clock.

## [0.15.0] - 2026-10-13

Update both apps: **Update** in LIKApcs (Admin) first (server + migration 0026 `import_runs`,
`import_links`, backup kind `pre_import`), then the gaming PCs. The Client is unchanged in
behaviour; it is rebuilt only so both installers carry the same version. Covered by tests (shared
61, server 222 incl. 6 search + 6 import, admin 35, client 36) and the browser smokes `search`
(20 checks) and `import` (22 checks: unknown file refused, preview, test run writes nothing,
import, pre-import backup listed, second run adds nothing, imported customer found by search).

### Added

- **Global search (Ctrl+K).** The command palette now searches the whole database, not only
  pages and PCs: receipts (`R-`), refunds (`K-`), invoices (`F-`), purchases (`B-` and the
  supplier's invoice number), customers (name, phone, e-mail, code, PC username), products (name,
  SKU, barcode — a scanner works straight into the box) and stations. Results come grouped with
  the number, the amount / stock and the date; a document number typed in any spelling
  (`R-2026-000123`, `r123`, `R2026000123`) is recognised and placed first. Enter opens the
  record on its page (sale detail, refund → its sale, invoice document, purchase, customer,
  product editor, PC). Every kind is filtered server-side by the user's permissions. New endpoint
  `GET /search` (shared `SearchHit` / `SearchResponse`); pages accept `?open=<id>` deep links.
- **Import from another program (LIKApos Pro).** Backups → _Import from another program_: pick
  the LIKApos Pro backup (.json); the wizard recognises it, previews what it contains (products &
  categories, customers with their PC login, open debts, sales history, expenses — with counts,
  amounts, date ranges and notes about what cannot be mapped 1:1), lets you choose what to bring
  over, runs a **test run** that does the whole import and rolls it back, and only then imports —
  after an automatic `pre_import` backup, in one transaction. Mapping: float euros → cents, stock →
  opening-stock movements, product pictures downloaded from the links in the background, card
  barcodes → customer codes, PINs (≥ 4) → PC login, debts → open receivables (linked to the
  imported sale when present), sales → completed receipts with cash/credit payments and refund
  status (no R-numbers, no stock changes, TXN kept in notes), expenses → new categories named
  like the old ones. Every record is linked to its external id (`import_links`), so running the
  same file twice only adds what is new. Staff accounts, cash-drawer log, audit/portal logs,
  loyalty points, supplier orders and settings are never imported. Migration 0026
  (`import_runs`, `import_links`, backup kind `pre_import`); endpoints `POST /imports/analyze`,
  `POST /imports/run`, `GET /imports/status`.

## [0.14.0] - 2026-10-13

Update both apps: **Update** in LIKApcs (Admin) first (server + migrations 0024
`orders.locked_screen` and 0025 end-pay columns on `gaming_sessions`), then the gaming PCs. Older
0.13.0 clients keep working: they ignore the locked-screen menu flag and show an End Pay session as
a plain countdown without the money line. Covered by tests (shared 61, server 205, admin 35,
client 36) and the browser smokes `lockscreen` (34 checks) and `endpay` (41 checks: method order,
start without payment, add time on the bill, early end capped + "Collect later", strip on Stations
and home, tile badge, Collect with receipt, exactly once, expiry, Waive).

### Added

- **End Pay — a third way to bill a PC.** After choosing the time, the payment step offers
  **Cash · End Pay · Balance · Pay later** (in that order): End Pay starts the session for the
  chosen time with nothing paid now. The tile and the session panel show _End Pay_ and _Due at the
  end_; **Add time** grows the bill without a payment dialog; Cancel is allowed (nothing was
  taken). When the time runs out the PC locks and the bill appears under **"To collect"** (strip
  on the Stations page and the home page, badge on the tile); stopping early charges the used time
  but **never more than the reservation**, either paid on the spot or parked with **"Collect
  later"**. **Collect** is the usual tender panel (cash with change, balance, pay later, discount /
  **Waive** for `pos.discount`), includes drinks ordered from the PC "on the bill", prints the
  receipt and is exactly once on the server (`POST /sessions/:id/collect`, 409 when already paid).
  The PC's widget reads _Pay at the end · amount_ instead of _Paid_. API:
  `billingMode: 'endpay'`, `GET /sessions?awaitingPayment=true`, `StationSummary.awaitingPayment`,
  client `billing.dueCents`, audit `session.collect`.
- **Menu on the locked screen.** With Settings › Client screen › _Orders on the locked screen_ on,
  a PC without a session shows the **Menu** button too: the customer logs in (username + PIN) and
  orders to pay at the desk; staff accept / prepare / pay them like session orders. Orders of an
  ended session stay visible on the PC for a short privacy window only.
- **Customer login with one click** on the lock screen (small _Client_ button), a quieter
  administrator word on the lock screen, and the **likaapps.com** link with the version in the
  Admin sidebar, login page, Settings › About and Updates (opens in the system browser).

## [0.13.0] - 2026-10-13

Update both apps: **Update** in LIKApcs (Admin) first (server + migration 0023 — `station_orders.prepared_at / prepared_by`,
`station_order_items.verified_milli / verification`, setting `orders.scan_check`), then the gaming
PCs. Older 0.12.x clients keep working: they ignore `preparedAt` and show the designs they do not
know as _Detailed_. Covered by tests (shared 61, server 199, admin 35, client 35) and the browser
smoke `prepare` (38 checks: scan per unit, wrong product / unknown code refused, manual confirm,
skip + prepare later, exactly once, setting off, PC flash, 1:1 tiles, live design switch, hover
tray).

### Added

- **Thirteen widget designs — "Dizajni".** Settings › Client screen shows a gallery of all designs
  with a description, drawn exactly as the PC draws them (one shared stylesheet, mirrored by
  `apps/likapcs-admin/scripts/sync-widget-css.mjs`, checked by `pnpm lint`): _Detailed_ (as
  before), _Minimal_, **Minutes only**, **Minutes + money**, _Compact_, _Pill_, _Ring_, _Dot_,
  _Strip_, _Digital_, _Glass_, _Neon_ and _Ticket_. Seven of them are see-through (the widget
  window itself is transparent — only the pill / ring / dot floats over the game), the small ones
  show just the whole minutes left ("23 min", seconds under a minute). The PC sizes its window to
  the design's footprint (×3 sizes, window `transparent`, no system border / shadow) and the
  desktop preview follows the picked design and corner.
  Shared: `widget-designs.ts` (traits + footprints) with tests.
- **Hover-revealed actions on the widget.** _More time_, _Pause_ and _Order_ are no longer pills
  permanently on the widget: they slide out on an opaque tray when the pointer enters the widget
  and hide 1.5 s after it leaves — nothing can be pressed by accident (the hidden tray does not
  take clicks), the widget stays as small as its design. Designs without text switch to _Detailed_
  for as long as something must be read (a notice, an order flash, offline).
- **Order panel with small 1:1 photos.** The PC's order menu is a grid of small square product
  tiles (photo, name, price, quantity stepper on the tile) that scrolls on its own; pictures load
  lazily.
- **Preparation check after Accept (barcode).** With `Settings › Stations › Scan check after accepting` on
  (default), accepting an order opens _Prepare order #n · PC_: every line is scanned with the
  barcode scanner **one scan per unit** — the right product and the exact quantity are enforced
  (a product outside the order, an unknown code or an extra scan of a complete line is refused
  on the spot) — and every line can be **confirmed without scanning** instead; the whole check
  can be skipped (`Esc`) and done later with **Prepare** on the Orders page. When it is finished
  the server stores what was verified and how (`POST /orders/:id/prepare`, exactly once, audit
  `order.prepare`), the Orders page shows _Prepared_ and the PC flashes _"Prepared — coming to
  you now"_.
- **Stations › PC detail, compact.** The client-device section is a small strip (status, version,
  IP, last seen) without empty space; the connection log shows the last 8 events with **Show
  more** (`GET /stations/:id/connection-logs?limit=`).

### Fixed

- **Settings switches moved the page (really fixed).** The 0.12.0 fix did not cover every path: a
  switch was still a hidden checkbox and the browser scrolled it into view when it took the focus,
  so the preview on _Client screen_ jumped up. `Switch` is now a real `<button role="switch">` —
  nothing hidden to scroll to; verified in the browser (13 switches, 0 jumps). Please confirm in
  the app on Windows.

## [0.12.0] - 2026-10-12

Update both apps: **Update** in LIKApcs (Admin) first (server + migration 0022 — table `ad_albums`,
`ads.album_id`), then the gaming PCs. Older 0.11.x clients keep working — they play the flat list
(album by album, with the single layout) until updated. Covered by tests (shared 56, server 198,
admin 35, client 29) and the browser smoke `albums` (35 checks: Admin chips / dialog / per-row box,
client playing album 1 as a 2×2 grid completely, then album 2 as big photos, then the loop; album
off; delete = ungroup).

### Added

- **Ad albums — "Albumet".** The lock-screen slideshow can now be split into albums (Album 1,
  Album 2, …), each with **its own look**: layout (one slide / big photo / grid / menu board), grid
  size, picture fit, caption position, slide style, seconds per page and shuffle — every option can
  stay "as in Settings", so an album overrides only what it needs. The PCs play the albums **one
  after another**: album 1 completely (every grid page / slide), then album 2, … and start over;
  slides in no album play first with the Settings look, so nothing changes until you create an
  album. In LIKApcs › Ads: an **Albums** bar above the list (chips numbered in playback order with
  the look summary and slide count — click to filter, the gear to edit), **New album** dialog
  (name, look, seconds, order, play earlier / later, on/off, delete), an **Album** box on every row
  (and in the slide dialog) to move a slide, drag a slide onto an album chip, and new products /
  slides added while an album is selected go straight into it. Switching an album **off** takes all
  of its slides off the PCs at once (state _Album off_); deleting an album only ungroups its slides.
  Server: `GET/POST /ads/albums`, `PATCH/DELETE /ads/albums/:id`, `PUT /ads/albums/order`,
  `PUT /ads/album` (move slides), `albumId` on ads and bulk adds; `GET /client/ads` adds `albums`
  (grouped, in playback order) next to the flat `items`; every album change pushes `server.display`.
  Client: the slideshow builds one programme from all albums — page-level look classes live on each
  layer, so a grid page and a big photo cross over cleanly; `data-album` / `data-albums` /
  `data-layout` on the frame for tests.

### Fixed

- **Settings › Client screen jumped to the top.** Clicking any switch on the _Client screen_ tab
  (and, less visibly, on every other settings tab) scrolled the whole Admin window so that the page
  header with **Save** disappeared and the changes could not be saved. The hidden checkbox behind a
  switch was absolutely positioned without a positioned parent, so it escaped the scrolling content
  area and stretched the document; focusing it on click made the browser scroll the window. The
  switch now anchors its own checkbox and the content area is positioned, so nothing can escape it
  again (`apps/likapcs-admin/src/styles/app.css`).

## [0.11.0] - 2026-10-12

Update both apps: **Update** in LIKApcs (Admin) first (server + migration 0021 — running balance on
`customer_ledger`, new payment / cash-movement kinds, permissions `wallet.topup` / `wallet.refund`,
setting `wallet.enabled`), then the gaming PCs. Older 0.10.x clients keep working — they just do not
show the balance until updated. Covered by unit / integration tests (shared 56, server 197, admin 35,
client 25) and the browser smokes (`wallet` 41, `debts` 28, `sessionpay` 24).

### Added

- **Customer balance — "Balanca".** A regular customer can pay money in advance; it sits on their
  name and is spent on anything: PC time (session start, extension, end bill), drinks and snacks at
  the POS, "pay now" orders and open debts. In LIKApcs: **Customers › customer › Top up** (amount +
  cash handed over → change; cash goes into the open shift) and **Pay out** (owner / manager
  correction path, needs `wallet.refund`); the list has a _Balance_ column and every customer chip
  (POS, station dialog, pickers) shows the balance. Every payment dialog gains a **Balance** chip
  that pre-fills what the balance can cover and asks for cash only for the rest; refunds of a sale on
  a customer's name can go back onto the balance; debt repayments can come from it. The cash shift
  shows top-ups and pay-outs on their own lines. Master switch: Settings › POS › _Customer balance_
  (`wallet.enabled`). The server locks the balance row per transaction, never lets it go negative
  (`409 wallet_insufficient` with the real figure), refuses the tender when the feature is off
  (`403 wallet_disabled`) and audits top-ups / pay-outs.
- **The customer sees their balance on the PC.** LIKApcs-Client shows **Your balance** first thing
  after the customer signs in (with the open debt, if any), a green balance pill in the countdown
  widget while the session's customer has money on the account, and the balance in the order panel.
  A top-up at the desk reaches the PC within a second (`server.customer` push); the PC also re-reads
  it on session start and reconnect (`GET /client/customer`).
- **Full account statement per customer.** Customers › customer › **Account**: every receipt (POS,
  session bills, orders) with date and time, what was bought, how it was paid (cash / balance / pay
  later), and — for receipts sold on credit — whether the debt is still open, partly paid, **paid
  later on which day**, or written off; plus refunds, debt repayments (with the receipts they
  settled), balance top-ups and pay-outs. Filters _All / Receipts / Unpaid / Repayments / Balance_,
  a totals strip (spent, paid in cash, from the balance, taken on credit, debts repaid, still owes,
  play time, customer since), paging, and a click on a receipt opens it. The **Balance** tab is the
  ledger with the running balance after every entry.

### Changed

- Escape in a dialog opened from inside another (a receipt from the statement, a payment from the
  station dialog) now closes only the top one.
- `sessions.methods.wallet` is labelled _Balance_ / _Balanca_ on receipts and in payment lists.

## [0.10.0] - 2026-10-12

Update both apps: **Update** in LIKApcs (Admin) first (server + migration 0020 — new tables
`station_orders`, `station_order_items`, new columns on `gaming_sessions`, `products` and `ads`),
then the gaming PCs (self-update or **Update clients**). Older 0.9.x clients keep working — they do
not show the paused cover, the **Order** pill or the new slide styles until they are updated.
Covered by unit / integration tests (shared 56, server 183, admin 35, client 25) and the browser
smokes (`pauseorders` 65, `ads` 55, `screen` 35, `clientscreen` 31, `requests` 58, `sessionpay` 24).

### Added

- **Pause really pauses the PC.** When the staff pause a session in LIKApcs (or the connection
  grace period pauses it), LIKApcs-Client now **covers the whole screen** with a _Session paused_
  cover: who paused, the frozen timer, and a big **Resume** button. The customer can also pause
  from the widget (**Pause** pill) and a customer pause ends by itself after
  `sessions.pause_max_minutes` (default 15, `0` = never) so time cannot be parked for free. Both
  switches live in Settings › Stations › _Pause_; the station dialog shows who paused and the
  automatic-resume countdown.
- **Orders from the PC ("Porosit").** During a session the customer presses **Order** in the
  widget and picks drinks / snacks from the menu the owner curated (Products › _On the PC menu_
  switch, or **Orders › Menu** to pick and sort everything at once). Prices are frozen on the order
  (promo-aware, the POS price); an optional note can be added. In LIKApcs the order arrives
  instantly (bell + badge + the new **Orders** page): **Accept — pay now** records a normal POS
  sale, **Accept — on the bill** settles it together with the session (the lines join the
  session's sale when it ends; the end-session dialog shows _Time + Orders_), **Reject** sends a
  reason the PC shows. Stock is deducted only when sold / billed; money moves only through
  `sales` / `payments`. Settings › Stations › _Orders_: on/off, allow note, default settlement.
- **Ads v2.** Per-slide **style** (_poster_ edge-to-edge photo, _hero_ picture + text, _split_
  half/half, _banner_ strip — owner default in Settings › Client screen), **accent colour**,
  **call-to-action** line, **weekly schedule** (weekdays + a daily time window that may wrap
  midnight), **rotation weight** (1–3), **per-station targeting**, **video slides** (upload or
  link, ≤ 80 MB, served by the server), **"ends in …" countdown** on promos, **shuffle**, two new
  transitions (_flip_, _blur_), a new **menu / price-board layout**, a live style-aware preview in
  the ad dialog and **Duplicate** for product ads. The PC re-fetches the list exactly when a
  schedule or promo flips (`nextChangeAt`).

### Changed

- `GET /client/ads` now returns `{ items, nextChangeAt }`; `AdSummary.stationIds` is always an
  array; `session.pause` carries `pausedBy` / `autoResumeAt`; welcome carries open `orders`; new
  `server.order` push. New device routes: `/client/menu`, `/client/orders*`,
  `/client/session-pause`, `/client/session-resume`. New Admin routes: `/orders*`,
  `/catalog/menu`, `/ads/:id/video`, `/ads/:id/duplicate`. Details in
  `docs/network-protocol.md`.
- The _Big photo_ slideshow layout keeps its meaning: its slides default to the new _poster_ style
  (an ad's own style still wins). _One slide (card)_ follows the owner's default style.
- A session that ends by itself (prepaid time over) or is cancelled leaves its accepted "on the
  bill" orders open on the **Orders** page, so the desk can collect or void them — nothing is
  billed silently.

### Fixed

- Ads: the _banner_ style rendered its text off-screen on text-only slides and squeezed the title
  next to the picture; the category chip of every style floated out of place. Rewritten layout:
  picture tile on the strip's left edge, text in the middle, price / countdown on the right.

## [0.9.0] - 2026-10-12

Update both apps: **Update** in LIKApcs (Admin) first (server + migration 0019), then the gaming
PCs (self-update or **Update clients**). Older 0.8.x clients keep working — they simply do not show
the new _Client_ button until they are updated.

### Added

- **Customers sign in on the PC and ask for time** (Settings › Stations › _Customer requests_,
  on by default):
  - **Customers › PC login:** give any registered customer a username and a PIN of 4+ characters
    (e.g. `lika` / `1998`). The PIN is hashed and never shown again; the login can be switched off
    or removed; the list shows a small badge with the username. Usernames are unique
    (case-insensitive) and freed when a customer is archived.
  - **On the locked PC** a small, deliberately quiet **Client / Klient** button in the corner
    (a left click elsewhere still opens the staff login). The customer signs in, picks a quick
    duration (**30 min / 1 h / 2 h / 3 h** by default, with the price under the station's pricing
    rule) or one of the gaming packages, and sends the request. Wrong PINs lock the login after the
    same number of attempts as staff accounts; the PC shows the server's answer only.
  - **In LIKApcs** the request arrives instantly: a **bell** in the top bar (count, sound — can be
    muted, toast), a badge on the PC tile and a banner in the station dialog. **Approve** opens the
    usual _Start session_ form **pre-filled** with the duration/package and the customer — pick the
    payment, press Enter, the PC unlocks. **Reject** asks for a short reason (quick chips: _PC
    reserved_, _Closing soon_, _Unpaid debt_, _Come to the desk_) that the customer reads on the PC.
  - **More time during a prepaid session:** a **+ time** button in the countdown widget lets the
    signed-in customer ask for an extension; approving opens the _Extend_ dialog pre-filled.
  - Requests **never expire** — they wait until someone answers, the customer cancels, or the
    server cancels them with a reason the PC explains (staff started a session by hand, the session
    ended, the PC was taken out of service). One request per PC at a time; approval is bound to the
    session transaction, so a request can never be approved twice.
  - New permission use: approving/rejecting needs `stations.control`; viewing needs
    `stations.view`. Audit entries: `customer.login`, `request.create`, `request.approve`,
    `request.reject`, `request.cancel`.

### Changed

- Archiving a customer now also removes their PC login (the username becomes available again).
- Disabling a station cancels its waiting customer request (`station_disabled`).

### Server / protocol

- Migration **0019**: `customers.login_username / login_password_hash / login_enabled /
  login_failed_count / login_locked_until / last_login_at`; new table `session_requests`; settings
  `requests.enabled`, `requests.quick_minutes`.
- New routes `/client/customer-login`, `/client/customer-logout`, `/client/request-options`,
  `/client/session-request(/:id)`, `/session-requests…`; `POST /sessions` and
  `POST /sessions/:id/extend` take `requestId`; `StationSummary.pendingRequest`; admin event
  `request.changed`; client push `server.request`; `server.welcome` carries the pending `request`
  and `display.customerLogin`.

## [0.8.0] - 2026-10-12

Update both apps: **Update** in LIKApcs (Admin) first (server + migration 0018), then the gaming
PCs (self-update or **Update clients**). Older 0.7.x clients keep working — they simply ignore the
new screen options until they are updated.

### Added

- **The locked screen is now fully yours** (Settings › Client screen, everything previewed live
  and pushed to every PC the moment you save — no restart):
  - **Grid sizes** beyond the classic 4-box: 2×2, 3×2, 4×2, 3×3, 4×3 and 4×4 — 4, 6, 8, 9, 12 or
    16 products per page, chosen from a visual picker. Dense grids use smaller type; the rest of
    the ads follow on the next pages.
  - **Full-screen slideshow**: the pictures run edge to edge like a digital-signage display;
    the title, clock, PC code pill and the "This PC is locked" strip float over them as
    translucent overlays — and the pictures keep clear of whatever you leave on.
  - **Every overlay is switchable:** clock & date, title (business name or PC code), PC code
    pill, status strip, page dots & progress bar, category chip. Switch them all off and the
    screen is nothing but the ads; a left click still opens the staff login.
  - **Pictures:** whole picture (default) or **fill the frame**; **gentle motion** (slow zoom) on
    full-screen and filled photos; **name & price at the bottom, at the top or hidden** in the
    big-photo layout.
  - **Background behind the slides:** the seven colour presets (midnight, ocean, sunset, forest,
    ruby, gold, mono) now also colour the lock screen itself.
  - **Scrolling line** at the bottom (up to 200 characters — opening hours, a tournament, a
    promo), seamless loop whose speed follows the length.
  - A thin **progress bar** shows how long the current page stays; the page dots remain.
- Admin: the Settings preview mirrors all of it — full screen, grid size, overlays, caption,
  picture fit, backdrop, ticker — so what you see is what the PCs show.

### Changed

- The welcome / `server.display` payload gained `display.ads.{grid, fullscreen, showClock,
  showBrand, showStation, showStatus, showCategory, showProgress, imageFit, caption, motion,
  background, tickerText}`; defaults reproduce the 0.7.x look exactly.
- Migration `0018_client_screen_options` seeds the thirteen new `client.ads_*` settings
  (schema v18).
- Client: a new page size (layout or grid change) restarts the slideshow from the first page; the
  lock screen's layout can no longer be widened by long content (ticker).

## [0.7.1] - 2026-10-12

Update both apps again: **Update** in LIKApcs (Admin) first (server + migration 0017), then the
gaming PCs (self-update or **Update clients**). The picture fix below needs the 0.7.1 client on
the PC.

### Fixed

- **Ads did not show on the gaming PCs.** The client's content-security policy only allowed
  pictures from the app itself, so product photos coming from the server were blocked on real
  PCs — and because a slide waited for its picture, the slideshow stayed empty. Pictures from the
  server are now allowed, and a slide whose picture cannot be loaded is shown as a text slide
  (name, text, price) instead of being skipped: the screens never stay blank because of a photo.
- A product that is **out of stock no longer disappears** from the screens (most shops do not keep
  exact counts); the Ads page flags it with an "Out of stock" tag instead. Archived products still
  leave the screens by themselves.
- Creating the first ad while the slideshow was switched off now **switches it on** (with a toast)
  — the "OFF" strip is also shown as a warning.

### Added

- **Catalogue browser for ads** ("Add products"): every active product with search, category
  chips, tick boxes, "Select all shown"; one ticked product continues into the details dialog
  (promo price, look…), several are added at once (`POST /ads/products/bulk`). Products that
  already have an ad are marked. "Add all products" now adds every active product, with or
  without a photo.
- **More options per ad:** a short text line under a product's name ("2 for 1 until 20:00"),
  seven background **looks** (midnight, ocean, sunset, forest, ruby, gold, mono) and an own
  **time on screen** (3–120 s; empty = the general interval). The preview and the client render
  them; the client advances slide by slide using each slide's own time.
- **Staff login with the mouse:** a left click anywhere on the locked screen opens the staff login
  (Ctrl+Alt+A still works). Settings › Client screen › "Staff login on the locked PC" can pre-fill
  the username (`client.staff_login_username`) so staff only type the password; the password field
  is focused in that case.
- The client refreshes its ad list every 10 minutes (was hourly) as a safety net behind the push.

### Database

- Migration 0017: `ads.theme`, `ads.duration_seconds`; setting `client.staff_login_username`.

## [0.7.0] - 2026-10-12

Update both apps: run **Update** in LIKApcs (Admin) first — it updates the server and applies
migrations 0015–0016 — then the gaming PCs update themselves (or click **Update clients** in
Stations). Older clients keep working; Wake-on-LAN needs the 0.7.0 client on the PC.

### Added

- **Ads on the customer screens, managed from the Admin (Ads page).** Choose which products the
  locked gaming PCs advertise, give each one a **promo price** (must be below the regular price) and
  a badge ("-33 %" is suggested), schedule it (from / until), switch it on and off, and order the
  slides by drag or arrows. **Custom slides** carry a free title, text and picture (upload or link,
  same store as product photos) for anything that is not a product. The page shows every slide's
  state — live, off, scheduled, expired or unavailable (product archived / out of stock — comes back
  by itself) — with a live preview. The master switch and the look (card / full / grid, interval,
  transition) stay in Settings → Client screen, which now links to the Ads page.
- **A live promo price is charged automatically in the POS.** Tiles and cart lines show the promo
  price with the regular one crossed out; the server itself prices the sale from the live promo
  (`ACTIVE_PROMO_SQL` is the single definition), so no cashier step and no client can bypass it.
  `ProductSummary.promoPriceCents` tells the Admin what is in force.
- **Customer screens render the curated feed**: product slides with badge, promo and crossed-out
  regular price, custom text or picture slides, in all three layouts; any change in the Admin
  reaches every PC within a second (`server.display` push → `/client/ads` refetch).
- **Wake-on-LAN — power on PCs from LIKApcs.** Offline PCs get a **Power on** button (station bar,
  context menu and PC details) and the Stations toolbar a **Power on all (n)**; the **server** sends
  the magic packets from inside the LAN (limited + directed broadcasts + the PC's last IP, ports 9
  and 7, three bursts). The client now reports its physical network adapters (MAC, IPv4, link,
  Windows "wake on magic packet" flag) and the Fast-startup switch, from which the Admin shows a
  readiness badge (Ready / Not ready with the reason / Unknown) and the MAC it will address. **Enable
  Wake-on-LAN** (PC online) sends `wol.configure`: the client switches the adapter flag on and Fast
  startup off — it needs administrator rights, so a UAC prompt may appear on the PC and the outcome
  is reported back and audited. The BIOS/UEFI part cannot be automated; `docs/wake-on-lan.md` walks
  through it per vendor. Everything is permission-gated (`stations.power`) and audited
  (`station.wake`, `station.wake_all`, `station.wol_configured`).
- **Debts need a permission.** New permission **Give debt** (`debts.give`; migration 0015 grants it
  to owner, administrator, manager and cashier). Without it the "Pay later" tender is hidden in the
  POS and at session end, and the server answers `403 CREDIT_FORBIDDEN`.
- **Debts are registered by customer name — from the POS and from the stations alike.** The tender
  panel's customer picker searches by name/phone and creates a new customer inline from just a name
  when nobody matches; session end uses the very same panel as the POS.

### Changed

- The customer-screen slideshow no longer shows "every product with a photo": it shows the ads the
  owner configured. Migration 0016 turns the existing behaviour into product ads (one per active
  product with a photo), so screens look the same right after the update until you curate.
- `GET /client/ads` items now carry `kind`, `body`, `badge`, `oldPriceCents`, and `imageUrl` may be
  `null` (text slide). `hardware` in `client.hello` / `client.event hardware` gained `network[]` and
  `fastStartup`; `STATION_COMMANDS` gained `wol.configure`; new `client.event wol_configured`.
- Settings → Client screen: the ads card is reduced to the master switch, the look and a
  **Manage ads** link; wording updated from "products" to "slides/ads".

### Removed

- Setting `pos.credit_sales` (0.6.0, default off — in practice nobody found it). "Pay later" is
  now governed by the `debts.give` permission; `pos.credit_default_days` stays.

### Database

- `0015_debts_permission.sql` — permission `debts.give` seeded into owner / administrator /
  manager / cashier; setting row `pos.credit_sales` deleted.
- `0016_ads.sql` — table `ads` (product | custom, promo price, badge, schedule, enabled, sort
  order, image key) + carry-over of the 0.6.x slideshow as product ads.

## [0.6.1] - 2026-10-11

### Fixed

- **LIKApcs-Client did not start on Windows (0.6.0 regression).** The hardware sampler was built
  on the UI thread while the app started; on Windows its temperature probe (WMI) initialises that
  thread's COM apartment as multi-threaded, after which the window layer cannot create the lock
  screen (`OleInitialize` → `RPC_E_CHANGED_MODE`) and the process ended before anything was on
  screen. All hardware sampling now lives on two private worker threads that start on first use
  — CPU / RAM / disk on one, the temperature probe on another that only refreshes a cache — and
  the UI thread never touches `sysinfo`. Callers wait with a timeout and fall back to "unknown",
  so a slow sensor can never delay a heartbeat or the lock screen.
  **Gaming PCs that already run 0.6.0 cannot update themselves** (they never get as far as the
  updater): run `LIKApcs-Client-Setup.exe` 0.6.1 on each of them once — pairing, settings and
  autostart are kept and the PC reconnects by itself. PCs still on 0.5.1 update on their own.

### Added

- **Client start-up safety net.** Anything fatal is appended to
  `%LOCALAPPDATA%\LIKApcs-Client\crash.log`, the kiosk policies (Task Manager) are undone so
  the machine is left usable, and a message box tells the staff where the log is. A missing
  Microsoft Edge WebView2 Runtime (Windows 10 images that never got the Edge updates, or an
  offline install) is reported in plain words with the two ways to fix it instead of a silent exit.
- Hardware specs reach the Admin even when the PC finishes reading them after its first hello
  (`client.event` `hardware`; the Admin's specs strip updates live).

### Changed

- Client: drag-and-drop on the lock-screen window is disabled (nothing ever used it; one OLE
  dependency less on the UI thread).
- Temperatures are read between heartbeats; the first heartbeat after start reports none and the
  next one carries the reading (when the machine exposes any — most consumer Windows PCs do not).

## [0.6.0] - 2026-10-11

### Added

- **"Pay later" — customer debts (borxh).** Off by default (Settings › Point of sale › _Allow
  "pay later"_). When on, every payment offers a **Pay later** tender for a selected customer:
  the part not paid now becomes a debt with a due date (pre-filled from _Default due date_,
  editable), the sale completes normally (stock, receipt, revenue) and the drawer is untouched.
  Customers can carry a debt limit (0 = none); blocked customers get no credit; the server is the
  authority for both. New **Debts** page (Finance): open / overdue / due today totals, filters,
  search by customer, phone or receipt; **Collect** takes a full or partial repayment (cash with
  change, or card when enabled), **Collect all** settles a customer's debts oldest-first from one
  amount; detail shows what was bought and every repayment; new due date (`customers.manage`);
  write-off with a reason (new `debts.write_off` permission — owner, admin, manager). Overdue
  count shows as a badge on the nav item. Customers show _Owes_ in the list and detail; the
  receipt and the "sale completed" screen print the debt and its due date. Cash shift totals break
  repayments out as _debt payments_. Migration `0013` (`customer_debts`, `debt_payments`).

- **Sessions pay like the POS.** Starting a prepaid session, extending it and ending a postpaid
  one use the same tender panel as a sale: cash with change suggestions (only the net cash reaches
  the drawer), card when enabled, **Pay later** on the session's customer when enabled (a walk-in
  can be attached to a customer right at checkout). The quick start from the map picks the time
  first and takes the money second; "open time" starts at once. After each payment the same
  "Payment recorded" screen as the POS shows the change or the debt and its due date, with
  Print / Finish and the auto-finish countdown. Ending a postpaid session **stops the clock the
  moment the checkout opens** — the amount quoted to the customer is the amount billed while the
  money is counted (server-bounded: at most 10 minutes back, never while paused). New
  `GET /sessions/:id/receipt` (stations.control). API: `payments[]` on start / extend / end,
  `stoppedSecondsAgo` and `customerId` on end, `payment` in every session mutation response; the
  single `paymentMethod` field keeps working.

- **PC hardware at a glance.** Clicking a PC on the Stations map shows a compact specs strip
  under its name — _i5-12400F · RTX 3060 · 7.9/16 GB · 45 °C · 12 % CPU_ — and the station detail
  dialog gets a full _Hardware_ block (processor with cores/threads, graphics card(s), memory in
  use, disk free, CPU load, CPU/GPU temperature, Windows version) with small load bars. The client
  reports the facts once at connect (`client.hello.hardware`, stored in `station_devices.hardware`)
  and the live load with every heartbeat; whatever the PC does not expose shows as "—" — nothing is
  guessed (temperatures in particular are rarely available on consumer Windows). Migration `0014`.

- **Client screen settings** (Settings › _Client screen_, with a live preview of both the lock
  screen and the session widget):
  - **Countdown widget:** _Minimal_ (one calm line — `PC 01 · 23 min · 1.50 €`) or _Detailed_
    (timer, label, progress bar); _Small / Normal / Large_; any of the four screen corners; optional
    money line — the amount **paid** for a prepaid session or the running amount **to pay** on
    open time (derived on the PC from the server's own terms and a billable-seconds snapshot,
    frozen while paused; the server still bills).
  - **Lock-screen title:** the business name or the PC code (e.g. _PC 01_) top-left.
  - **Product slideshow on the locked PC:** in-stock products that have a photo, _one product
    (card)_, _full-screen photo_ or _classic box (4 products)_; slide left / right, fade or zoom;
    3–120 s per slide; prices on or off. Pictures are decoded before a slide may show and two
    layers cross over with GPU transforms only, so there is never an empty frame or a half-loaded
    photo. Off by default. New device endpoint `GET /client/ads`.
  - Every change reaches all connected PCs the moment it is saved (`server.display` push) — no
    reconnect, no restart; the widget even moves to its new corner during a session.

### Changed

- **POS — Enter pays.** Enter anywhere on the POS page (nothing focused, a tapped product tile,
  the empty search field) opens the payment; Enter in the payment completes it; Enter on the
  completed screen starts the next sale. F6 / F8 keep working as silent aliases. Enter in a field
  that has text keeps its own meaning (search / quantity), and a scanner burst is never mistaken
  for the pay key.
- **POS — smarter cash suggestions.** The fixed 5 / 10 / 20 / 50 row is replaced by the
  denominations a customer plausibly hands over for _this_ total, from 0.50 € to 50 € (0.20 → 0.50,
  1, 2, 5…; 2.50 → 3, 4, 5, 10…; 7.30 → 7.50, 8, 10, 20, 50), plus _Exact_.
- The payment UI is now one shared tender panel (POS and session bills), so cash, card, split and
  pay-later behave the same everywhere.
- Cash shift summary lists _Debt repayments (pay later)_ as its own drawer line.

## [0.5.1] - 2026-10-11

### Changed

- **Client — clean lock screen.** The footer line (`LIKApcs Client <version> · <PC name> ·
  Ctrl+Alt+S settings · Ctrl+Alt+A staff unlock`) and the connection dot are gone; the lock screen
  shows only the business name, the clock, the station and the status card. The shortcuts are
  staff knowledge (Admin → Settings explains Ctrl+Alt+A; the client's own settings panel still
  opens with Ctrl+Alt+S). The only element that can appear at the bottom is a small amber pill
  _"No connection to the server — reconnecting…"_ while the server is unreachable, so staff see
  the problem at a glance.
- **Client — never a "program".** The window is a tool window in every mode (`skipTaskbar` from
  the first frame, kept across lock screen / countdown widget / settings panel): no taskbar
  button, nothing in Alt+Tab — the tray icon is the client's only presence. The window still
  cannot be closed or minimised while locked.
- **Client — settings flyout from the tray.** The settings panel opens as an always-on-top flyout
  next to the tray icon (anchored to the click, kept inside the work area of that monitor, DPI
  aware; falls back to the centre of the screen when no monitor is known) instead of a centred
  window. Ctrl+Alt+S opens the same flyout in the tray's usual corner. The flyout keeps its 1px
  edge so it stays readable over any desktop.

### Fixed

- **Client — left click on the tray icon did nothing during a session.** The tray listener was
  registered once with the state of the first render (locked), so during a customer session or a
  staff unlock it never asked the native side to grow the 300×96 countdown widget into the panel;
  the panel was marked open but nothing was visible. The handler now reads the live agent
  snapshot, and a left click **toggles** the panel (open → close); a Windows double click is
  coalesced into one toggle.

## [0.5.0] - 2026-10-11

### Added

- **Editable role permissions — hide the Dashboard (revenue, profit, investments) from workers.**
  _Employees → Roles & permissions_ is now a live matrix: tick or untick a box to change what a
  role may do; each change is saved at once (`PUT /roles/:id/permissions`, audited as
  `role.permissions_update`) and applies to signed-in staff immediately — the server resolves
  permissions per request and pushes a `permissions.changed` event so every open Admin re-reads
  `/auth/me`, hides the menu entries it lost and leaves the page it may no longer see. Guard rails:
  the Owner role is immutable (always every permission — the recovery path), a user may only edit
  roles below their own, and may only grant permissions they hold themselves. Every permission
  shows a plain-language name next to its code (EN/SQ). Staff without `dashboard.view` land on the
  first page they are allowed to use (Stations, POS, …) instead of the Dashboard.
- **Full screen for the whole Admin app.** **F11** or **F12** (and a new top-bar button) switch the
  desktop app to true full screen — no taskbar, no title bar — and back; the choice is remembered
  and restored at the next start. In a browser the same keys use the browser's full-screen mode.
- **Stations map help popover.** The mouse/keyboard instructions left the action bar; a small
  **?** button opens a compact cheat-sheet (double-click/Enter, right-click, box/Ctrl/Shift
  selection, Ctrl+A, arrows, Esc, F9). The empty action bar now just says _Select a PC_.

### Fixed

- **Pricing rules and packages that "would not save".** The _Save_ button was silently disabled
  whenever the form was incomplete (a time window with only _From_ filled in, a rate such as
  `1.500`, a cleared numeric field, no weekday) and server-side validation errors for fields
  without a message slot were swallowed, so nothing happened and nothing explained why. _Save_ is
  now always active: pressing it (or Enter in any field) runs the same validation as the server and
  marks every offending field with a message in the user's language, scrolls to the first one, and
  any server error — field-level or general — is shown in the dialog. Dialog bodies scroll on small
  screens so the footer with _Save_ can no longer be pushed off-screen.

## [0.4.0] - 2026-10-11

### Added

- **Select several PCs on the map.** Drag a box on the floor map (rubber-band), Ctrl+click to add
  or remove, Shift+click (or Shift+arrows) for a range in display order, Ctrl+A for every visible
  PC, Esc or a click on the background to clear. The action bar turns into a group view
  (_N PCs selected_ with their codes) and _Start_, _Lock/Unlock_, _Message_, _Restart_ and
  _Shut down_ go to every selected PC in parallel — the button labels count the PCs that will
  actually receive the command (online ones). One toast sums the outcome and names the PCs that
  failed. _Start_ opens one quick-start dialog for the whole group (each PC is billed by its own
  pricing rule and gets its own idempotency key); the right-click menu on a selected PC keeps the
  group. Actions that need a bill — _Stop_, _Add time_, pause/resume, cancel, details — stay
  single-PC and say so in their tooltip.
- **One click between Gaming Stations and the POS.** A _Stations | POS_ switch sits in the top bar
  of every page (for users allowed on both) and **F9** flips between the two from anywhere. The open
  sale now lives outside the POS page (`PosCartProvider`), so the cart, the customer and a resumed
  parked sale survive the trip — and any other navigation — until the sale is paid, parked or
  cleared; it is dropped on sign-out.
- **Setup wizard suggests `admin` / `admin`.** The owner step comes pre-filled with _Administrator_
  / `admin` / `admin` (editable, with a note that says the default login out loud and turns green
  once custom credentials are typed). Nothing is created until the form is submitted and there is
  no hidden built-in account; existing installations are untouched (`Employees` page or
  `create-admin` remain the recovery paths).

### Changed

- **Product photos on POS tiles are small squares** (48 px, 40 px on narrow windows) beside the
  name instead of a 16:9 banner across the tile; long names wrap up to three lines next to the
  photo and never distort it. Tiles without a photo are unchanged.

### Tests

- `apps/likapcs-admin/src/lib/map-selection.test.ts` covers zone ordering, Shift ranges, Ctrl
  toggles, marquee geometry and bulk summaries (admin: 27 unit tests). New browser smoke
  `LIKApcs-smoke/phase8d.mjs` (32 checks) drives three simulated online client PCs through
  marquee / Ctrl / Shift / Ctrl+A selection, bulk message + lock (each PC acknowledges exactly
  one command), a two-PC quick start, the F9 round trip with a full cart, the square tile
  geometry and the wizard defaults on a fresh database (`admin` / `admin` then signs in).

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
