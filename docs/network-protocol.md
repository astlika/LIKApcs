# LIKApcs — Local network protocol

Everything runs over one TCP port on the server (default **4700**, `LIKAPCS_PORT`):

| Channel     | Path                 | Used by | Auth                                 |
| ----------- | -------------------- | ------- | ------------------------------------ |
| HTTP API v1 | `/api/v1/...`        | Admin   | `Authorization: Bearer <token>`      |
| HTTP API v1 | `/api/v1/client/...` | Client  | registration secret (rate-limited)   |
| WebSocket   | `/ws/admin`          | Admin   | `admin.hello` with the user token    |
| WebSocket   | `/ws/client`         | Client  | `client.hello` with the device token |

Transport is plain HTTP/WS on the LAN by default; set `LIKAPCS_TLS_CERT_FILE/KEY_FILE` for HTTPS/WSS
on untrusted networks. Tokens are never logged. Message bodies are JSON; all times are ISO-8601 UTC;
all money is integer cents.

The authoritative definitions live in `packages/shared/src/dto.ts` (HTTP) and
`packages/shared/src/protocol.ts` (WebSocket). Both apps import them, so a protocol change is a
compile error in every component that has not been updated.

## 1. Conventions

- **Success**: JSON body; `201` on create; `204` on actions without a body.
- **Lists**: `{ "items": [...], "page": 1, "pageSize": 25, "total": 123 }`.
- **Errors**: `{ "error": { "code": "validation_error", "message": "…", "details": [...] } }`.
  Codes used: `validation_error` (400, `details` = `[ { path, message } ]`), `unauthorized` (401),
  `forbidden` (403), `not_found` (404), `conflict` (409), `account_locked` (423, `details.lockedUntil`),
  `rate_limited` (429), `internal_error` (500).
- **Versioning**: path prefix `/api/v1`. `GET /system/health` returns server, schema and protocol
  versions; a client checks `isCompatibleWithServer()` (same major, its minor ≤ server minor).

## 2. HTTP API v1 (Phase 1 surface)

### System

| Method | Path                                 | Auth / permission                       | Notes                                                                                                                                                                         |
| ------ | ------------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/system/health`                     | public                                  | `{status, version, schemaVersion, database, time, installationId, name}` — also the probe a client PC runs before it saves a server address                                   |
| GET    | `/system/network`                    | `devices.manage`                        | `{port, discoveryPort, discoveryEnabled, addresses[], installationId}` — what Admin shows in “Connect a PC” (addresses ranked: physical/private first, virtual adapters last) |
| GET    | `/system/setup-status`               | public                                  | `{needsSetup, businessName, defaultLanguage}`                                                                                                                                 |
| POST   | `/system/setup`                      | public, **only while zero users exist** | `{businessName, language, owner:{fullName, username, password}}` → `201 LoginResponse`                                                                                        |
| GET    | `/system/info`                       | authenticated                           | versions, uptime, DB latency, connection counts                                                                                                                               |
| GET    | `/dashboard/summary?date=YYYY-MM-DD` | `dashboard.view`                        | `DashboardSummary` (see architecture › financial definitions)                                                                                                                 |

### Auth

| Method | Path                    | Notes                                                                                                                                                                                                                                                          |
| ------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/auth/login`           | `{username, password, rememberMe?}` → `{token, expiresAt, user}`; rate-limited; lockout after N failures. `rememberMe: true` ("Stay signed in on this PC") → lifetime `LIKAPCS_REMEMBER_DAYS` (default 30 d) instead of `LIKAPCS_SESSION_HOURS` (default 12 h) |
| POST   | `/auth/logout`          | revokes the current token                                                                                                                                                                                                                                      |
| GET    | `/auth/me`              | current user + effective permissions                                                                                                                                                                                                                           |
| POST   | `/auth/change-password` | `{currentPassword, newPassword}`; clears `mustChangePassword`; revokes other sessions                                                                                                                                                                          |

### Users & roles (`users.view` / `users.manage`)

`GET /users?page&pageSize&search&includeInactive`, `GET /users/:id`, `POST /users`, `PATCH /users/:id`
(fullName, email, phone, roles, isActive), `POST /users/:id/reset-password`
(`{newPassword, mustChangePassword}`), `GET /roles` (code, name, rank, permissions[]),
`GET /permissions` (code, category, description), `PUT /roles/:id/permissions` (`{permissions: string[]}`,
`users.manage`) — full replacement of a role's permission set, audited as `role.permissions_update`.
Rank rule: an actor may only manage users with strictly lower privilege; owners may manage owners.
Role editing: the `owner` role is immutable (always every permission — it is the recovery path), an
actor may only edit roles of strictly lower power than their own and may only grant permissions they
hold themselves (no escalation). Permissions are resolved from the database on every request, so a
change applies to signed-in staff at once; Admin apps receive the `permissions.changed` event and
re-read `/auth/me`.

### Settings (`settings.view` / `settings.manage`)

`GET /settings/public` (public keys only, no auth), `GET /settings` (full map),
`PATCH /settings` (partial map; every key validated by the shared schema; audited with old → new).

### Stations & devices (`stations.view` / `stations.manage` / `devices.manage`)

| Method | Path                            | Notes                                                                                |
| ------ | ------------------------------- | ------------------------------------------------------------------------------------ |
| GET    | `/stations`                     | all stations with live `status`, `device`, `activeSession`                           |
| GET    | `/stations/:id`                 |                                                                                      |
| GET    | `/stations/:id/connection-logs` | last 100 connect/disconnect events                                                   |
| POST   | `/stations`                     | `{number, name, zone?, notes?, isEnabled}`                                           |
| PATCH  | `/stations/:id`                 | partial                                                                              |
| DELETE | `/stations/:id`                 | `409` if the station has session history or an approved device — disable it instead  |
| GET    | `/devices?status=pending`       | registrations                                                                        |
| POST   | `/devices/:id/approve`          | `{stationId}` — one approved device per station                                      |
| POST   | `/devices/:id/reject`           |                                                                                      |
| POST   | `/devices/:id/revoke`           | token invalidated, live socket closed with `4005 DEVICE_REVOKED`                     |
| POST   | `/devices/:id/reissue-token`    | for a reinstalled client that lost its token; the client re-polls with its secret    |
| POST   | `/stations/:id/command`         | staff command to the connected client PC — see _Staff commands_ below                |
| POST   | `/devices/update-outdated`      | `devices.manage` — sends `update.apply` to every online client older than the server |

#### Staff commands (`POST /stations/:id/command`)

Body: `{command: 'lock' | 'unlock' | 'power.restart' | 'power.shutdown' | 'update.apply'}` or
`{command: 'message.show', text (1–300), durationSeconds? (3–600, default 20)}`. Permissions:
`stations.control` for all of them, additionally `stations.power` for `power.*` and
`devices.manage` for `update.apply`. The call waits for the client's acknowledgement (15 s) and
returns `{commandId, command, ok, error?}`; `409 STATION_OFFLINE` when no client is connected.
Every call is audited as `station.command.<command>` (a refused/unanswered command is a warning).
Session commands (`session.*`) are never issued through this route — they are mirrored by the
sessions service (below) so that the server state and the PC never disagree.

`unlock` (permission `stations.unlock`, also required for the Admin button) is a **maintenance
grant**, never a free session: the server records `maintenance_until/by` on the station, the station
status becomes `maintenance`, the PC receives `unlock {reason:'maintenance', until, byName}` and
locks again when the grant expires (`stations.maintenance_minutes`, default 15; a 5 s sweep sends
`lock {reason:'maintenance_expired'}`), when staff presses _Lock_ on the PC, when an Admin `lock` is
sent, or when a session starts. `StationSummary.maintenance` is `{until, byName} | null`. Audited as
`station.maintenance_unlock` / `station.maintenance_lock` / `station.maintenance_expired`.

### Pricing (`stations.view` to read, `pricing.manage` to write)

`GET/POST /pricing/rules`, `PATCH/DELETE /pricing/rules/:id`, `GET/POST /pricing/packages`,
`PATCH/DELETE /pricing/packages/:id`, `GET /pricing/packages?stationId=` (packages currently
available for that station). Deleting a rule/package that sessions already reference deactivates it.

### Gaming sessions (`stations.view` to read, `stations.control` to act)

| Route                          | Body                                                                                 | Result                                              |
| ------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `POST /sessions/quote`         | `{stationId, billingMode, packageId? \| minutes?}`                                   | `{minutes, priceCents, rule, package, terms}`       |
| `POST /sessions`               | quote fields + `customerName?, customerId?, paymentMethod, notes?, clientRequestId?` | `201 {session, client}` — prepaid is paid here      |
| `POST /sessions/:id/pause`     | —                                                                                    | `{session, client}`                                 |
| `POST /sessions/:id/resume`    | —                                                                                    | prepaid `endsAt` shifted by the paused time         |
| `POST /sessions/:id/extend`    | `{packageId? \| minutes?, paymentMethod, clientRequestId?}` (prepaid only)           | new sale + receipt                                  |
| `POST /sessions/:id/end`       | `{discountCents?, paymentMethod?}`                                                   | postpaid billed exactly once; `409` if already over |
| `POST /sessions/:id/cancel`    | `{reason}` (postpaid only)                                                           | no charge                                           |
| `GET /sessions`                | `?status&stationId&from&to&page&pageSize`                                            | `{items, total, page, pageSize}`                    |
| `GET /sessions/:id`, `/events` | —                                                                                    | summary / event timeline (incl. PC acks)            |

`client` in a mutation response is `{commandId, command, ok, error?}` for the command mirrored to
the PC, or `null` when no client is connected (the session still runs on the server and the PC
receives it in `server.welcome.session` when it reconnects). The server's 1-second ticker expires
prepaid sessions at `endsAt`, sends `message.show` warnings at `stations.expiry_warning_minutes`
and applies the grace pause after `stations.session_grace_seconds` offline.

#### Client updates

`POST /devices/update-outdated` returns `{outdated, sent, results: [{deviceId, stationId, ok, error?}]}`.
Independently of staff, the server pushes `update.apply` **5 seconds after a client connects** when
the client version is older than the server version and the `updates.client_policy` setting allows
it: `idle_only` (default — only while no session is running), `maintenance_window` (only inside
`updates.maintenance_window`, `HH:MM-HH:MM` server-local, may cross midnight) or `manual` (never).
The client answers with `client.event update_status {status: checking | none | installed | failed |
unavailable, version?, error?, trigger}` and relaunches itself after installing a signature-verified
update. The server turns these events into `update_history` rows (one row per attempt: `checking`
opens a `pending` run, later events update it; `none`/`unavailable` close it quietly) — see
"Updates" below.

### Catalogue & inventory (`products.view` to read, `products.manage` to write, `inventory.adjust` for stock)

| Route                                                                  | Notes                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET/POST /catalog/tax-categories`                                     | VAT classes (`rateBp`, `isDefault`). A product without a tax category uses the default class, or `tax.default_rate_bp` when none exists                                                                                                                           |
| `GET/POST /catalog/categories`, `PATCH/DELETE /catalog/categories/:id` | `productCount` included; deleting leaves products uncategorised                                                                                                                                                                                                   |
| `GET /products`                                                        | `?q` (name/SKU/brand/barcode), `categoryId`, `lowStock`, `active=active\|inactive\|all`, `page`, `pageSize≤500` → `{items, total, page, pageSize}`                                                                                                                |
| `GET /products/lookup?code=`                                           | Scanner path: barcode first, then SKU → `{product, quantityMilli, matchedBy}` (`quantityMilli` is the pack size of a case barcode); `404` when unknown                                                                                                            |
| `POST /products`                                                       | `sku` optional (generated `SKU-NNNNNN`), `barcodes[]`, `initialStockMilli` (recorded as an `initial` movement) → `201`                                                                                                                                            |
| `GET/PATCH/DELETE /products/:id`                                       | `DELETE` → `{archived: true}` when the product was ever sold or moved (it is deactivated instead of removed), `{archived: false}` when it was really deleted                                                                                                      |
| `POST /products/:id/barcodes`, `DELETE …/:barcodeId`                   | barcodes are unique across all products                                                                                                                                                                                                                           |
| `PUT /products/:id/image`                                              | `products.manage`; raw body with `content-type: image/png\|jpeg\|webp\|gif` (≤ 5 MB, format sniffed from the bytes). Replaces and deletes the previous file → `ProductSummary` with the new `imageUrl`                                                            |
| `POST /products/:id/image/from-url`                                    | `{url}` — the **server** downloads the picture (http/https only, ≤ 5 MB, 10 s, private/loopback addresses refused) so the Admin never embeds third-party URLs                                                                                                     |
| `DELETE /products/:id/image`                                           | removes the file → `imageUrl: null`. Deleting a never-sold product also deletes its picture file                                                                                                                                                                  |
| `GET /files/products/:name`                                            | **public, no token** (POS tiles, future kiosk screens): immutable file names (`<24 hex>.<ext>`), `Cache-Control: public, max-age=31536000, immutable`. Files live in `<dataDir>/uploads/products` (`LIKAPCS_UPLOAD_DIR`) and are **not** part of database backups |
| `POST /products/:id/stock`                                             | `{type: adjustment\|initial\|damaged\|expired\|missing\|stock_count, quantityMilliDelta \| newStockMilli, reason, unitCostCents?}`; `409 INSUFFICIENT_STOCK` if it would go negative and the product disallows that                                               |
| `GET /inventory/movements`                                             | `?productId&type&from&to&page&pageSize` → ledger with `stockAfterMilli`                                                                                                                                                                                           |

### Sales / POS (`pos.sell`; `pos.discount`, `pos.suspend`, `pos.refund`, `pos.reprint` for the matching actions)

| Route                            | Body / query                                                                                                                                              | Result                                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /sales`                    | `{items[{productId, quantityMilli, discountCents?}], discountCents?, payments[{method, amountCents, reference?}], customerId?, notes?, clientRequestId?}` | `201 SaleDetail` — prices and tax come from the database, never from the client; idempotent on `clientRequestId`                         |
| `POST /sales/suspend`            | same without payments                                                                                                                                     | `201` parked sale (no receipt number, no stock movement, no payment)                                                                     |
| `POST /sales/:id/complete`       | `POST /sales` body                                                                                                                                        | completes a parked sale                                                                                                                  |
| `POST /sales/:id/void`           | —                                                                                                                                                         | `204`; parked sales only                                                                                                                 |
| `POST /sales/:id/refund`         | `{items[{saleItemId, quantityMilli}], reason, restock=true, method=cash}`                                                                                 | `SaleDetail` with the new `K-<year>-NNNNNN` refund; `409` when more than the sold quantity is returned                                   |
| `GET /sales`                     | `?status&source&cashierId&q&from&to&page&pageSize`                                                                                                        | `{items, total, page, pageSize, summary{count, totalCents, refundedCents}}` (summary over the whole filter)                              |
| `GET /sales/:id`                 | —                                                                                                                                                         | items, payments, refunds                                                                                                                 |
| `GET /sales/:id/receipt?reprint` | —                                                                                                                                                         | `ReceiptData` (business header from settings, width 58/80 mm); `reprint=true` needs `pos.reprint`, is logged in `print_jobs` and audited |

Money rules enforced by the server: `subtotal = Σ line totals after line discounts`, `total = subtotal − sale
discount`, the sale discount is spread over lines by largest remainder for tax purposes, VAT is derived
from tax-inclusive prices (`price_includes_tax=false` adds it instead), only **cash** may be over-tendered
(change is returned), card/bank payments may not exceed the total, and stock is reserved inside the
same transaction with `SELECT … FOR UPDATE` in product-id order (`409 INSUFFICIENT_STOCK` carries
`productId`, `availableMilli`, `requestedMilli`). Error responses are `{error: {code, message, details?}}`.

### Cash register (`cash.view` to read, `cash.open_close` for shifts, `cash.move` for pay-in/pay-out)

| Route                         | Body / query                                             | Result                                                                                                                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /cash/status`            | —                                                        | `{registers, current: CashShiftDetail \| null, requireOpenShift, differenceWarningCents}` — polled by the Admin top-bar pill; `current` is the open shift of the default register                                                      |
| `GET /cash/registers`         | —                                                        | active registers (`0009` seeds _Main register_)                                                                                                                                                                                        |
| `POST /cash/shifts/open`      | `{registerId?, openingCents, notes?}`                    | `201 CashShiftDetail`; `409 CONFLICT` when the register already has an open shift                                                                                                                                                      |
| `POST /cash/shifts/:id/close` | `{countedCashCents, notes?}`                             | closes the shift: `expected_cash_cents` is computed from the ledger inside the same transaction, `difference_cents = counted − expected`; audited                                                                                      |
| `GET /cash/shifts`            | `?registerId&status&from&to&page&pageSize`               | paginated summaries (`from`/`to` are calendar days in the business time zone)                                                                                                                                                          |
| `GET /cash/shifts/:id`        | —                                                        | `CashShiftDetail`: `totals{openingCents, cashSalesCents, salesCount, cashRefundsCents, refundsCount, depositsCents, withdrawalsCents, expensesCents, otherCents, expectedCashCents, salesByMethod[], salesBySource[]}` + `movements[]` |
| `POST /cash/movements`        | `{type: 'deposit' \| 'withdrawal', amountCents, reason}` | `201`; a withdrawal larger than the expected drawer content is `400 INSUFFICIENT_CASH`                                                                                                                                                 |

The drawer ledger (`cash_movements`, signed cents) is written **by the server only**, inside the
transaction that creates the money event: `opening` on open, `sale` for the **net cash** of a sale
(tender − change) or a cash-paid gaming session (reason = receipt number), `refund` for cash refunds,
`expense` for expenses paid from the drawer (`correction` when such an expense is voided),
`deposit` / `withdrawal` for manual moves. Non-cash
tenders are linked to the shift (`payments.shift_id`) for the shift report but never touch the ledger.
With the setting `cash.require_open_shift = true` (default) a cash sale or a cash-paid prepaid session
without an open shift is refused with `409 SHIFT_REQUIRED`; the Admin reacts by opening the
_Open shift_ dialog and retrying the original request once the shift exists.

### Expenses (`expenses.view` / `expenses.manage`)

| Route                       | Body / query                                                                                    | Result                                                                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /expenses/categories`  | `?includeInactive`                                                                              | seeded codes (`electricity`, `internet`, `rent`, `salaries`, `repairs`, `hardware`, `cleaning`, `software`, `other`) with `nameEn` / `nameSq`                                                               |
| `POST /expenses/categories` | `{code, nameEn, nameSq}`                                                                        | `201`                                                                                                                                                                                                       |
| `GET /expenses`             | `?from&to&categoryCode&paymentMethod&includeVoided&q&page&pageSize`                             | `{items, total, page, pageSize, totalCents}` (total over the whole filter, voided excluded)                                                                                                                 |
| `POST /expenses`            | `{expenseDate, categoryCode, amountCents, paymentMethod, description, supplierId?, fromDrawer}` | `201`; `fromDrawer=true` requires an open shift and writes an `expense` ledger movement                                                                                                                     |
| `POST /expenses/:id/void`   | `{reason}`                                                                                      | marks the expense void; a drawer expense is reversed with a `correction` movement in **its own** shift, so it can only be voided while that shift is still open (`409` afterwards — book a deposit instead) |

### Customers (`customers.view` / `customers.manage`)

| Route                   | Body / query                                                                 | Result                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `GET /customers`        | `?q&status&page&pageSize`                                                    | paginated summaries (archived customers hidden unless `status=archived`)                                              |
| `POST /customers`       | `{name, phone?, email?, membership?, membershipUntil?, discountBp?, notes?}` | `201`; code `C-000001`, `C-000002`, … from the shared document sequence                                               |
| `GET /customers/:id`    | —                                                                            | detail + `stats{salesCount, salesTotalCents, sessionsCount, sessionsMinutes, lastVisitAt}`, recent sales and sessions |
| `PATCH /customers/:id`  | any subset of the create body + `status: active \| blocked`                  | updated detail                                                                                                        |
| `DELETE /customers/:id` | —                                                                            | archives (never deletes — sales keep their customer link)                                                             |

`GET /sales?customerId=` and `GET /sessions?customerId=` filter history by customer.

### Suppliers & purchases (`purchases.view` to read; `suppliers.manage`, `purchases.manage`, `purchases.pay` to write)

| Route                          | Body / query                                                                                                                                                                   | Result                                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /suppliers`               | `?q&includeInactive`                                                                                                                                                           | suppliers with `purchasesCount`, `purchasedCents`, `balanceDueCents`, `lastPurchaseAt` (non-cancelled purchases)                                                                                                      |
| `POST /suppliers`              | `{name, businessName?, taxId?, phone?, email?, address?, contactPerson?, notes?}`                                                                                              | `201`; `409` when the name already exists (case-insensitive)                                                                                                                                                          |
| `GET /suppliers/:id`           | —                                                                                                                                                                              | one supplier                                                                                                                                                                                                          |
| `PATCH /suppliers/:id`         | any subset + `isActive`                                                                                                                                                        | updated supplier                                                                                                                                                                                                      |
| `DELETE /suppliers/:id`        | —                                                                                                                                                                              | deactivates (purchases keep their link; inactive suppliers are refused on new purchases with `409`)                                                                                                                   |
| `GET /purchases`               | `?supplierId&status&paymentStatus&from&to&q&page&pageSize`                                                                                                                     | paginated summaries + `summary{count, totalCents, paidCents, dueCents}` over the whole filter (cancelled excluded)                                                                                                    |
| `POST /purchases`              | `{supplierId, supplierInvoiceNo?, orderDate?, expectedDate?, items[{productId, quantityMilli, unitCostCents, taxRateBp}], additionalCostsCents, notes?, receiveNow, payment?}` | `201` detail; reference `B-<year>-NNNNNN`; `total = Σ lines + Σ VAT + additional costs`; `receiveNow` books every line at once, `payment` records a first payment in the same transaction                             |
| `GET /purchases/:id`           | —                                                                                                                                                                              | detail with `items` (ordered / received / returned quantities), `receipts` (deliveries) and `payments`                                                                                                                |
| `POST /purchases/:id/receive`  | `{items?[{purchaseItemId, quantityMilli}], deliveryNoteNo?, notes?}` — no `items` = everything outstanding                                                                     | one `purchase_receipt`; per line a `purchase_receipt` inventory movement, `products.purchase_cost_cents` = this cost and `average_cost_cents` = weighted average of old stock and the delivery; `409` on over-receipt |
| `POST /purchases/:id/payments` | `{method, amountCents, reference?}`                                                                                                                                            | `201` detail; `400` above the open balance; `cash` goes through the drawer as a negative `supplier_payment` movement (needs an open shift when `cash.require_open_shift`)                                             |
| `POST /purchases/:id/cancel`   | `{}`                                                                                                                                                                           | only `draft` / `ordered` purchases with nothing paid; `409` otherwise                                                                                                                                                 |

### Reports (`reports.view`; `reports.export` for CSV)

| Route                 | Query                                                                 | Result                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /reports/sales`  | `?from=YYYY-MM-DD&to=YYYY-MM-DD` (`400` when `from > to`)             | `SalesReport`: `sales{count, grossCents, discountCents, taxCents, netCents, refundedCents, refundsCount, averageCents}`, `byMethod`, `bySource`, `byDay[]`, `byHour[]`, `topProducts[]`, `byCategory`, `gaming{sessionsCount, billedMinutes, amountCents, byStation[]}`, `expenses{count, totalCents, byCategory}`, `cash{shiftsCount, differenceCents, shifts[]}`, `byEmployee`, `generatedAt` |
| `GET /reports/export` | `?kind=sales \| sale_items \| expenses \| sessions \| shifts&from&to` | `text/csv; charset=utf-8` with BOM, `;` separator, `Content-Disposition: attachment` — opens directly in Excel/LibreOffice                                                                                                                                                                                                                                                                      |

Days are bucketed in the **business time zone** (`locale.timezone` setting, default
`Europe/Belgrade`), so a sale at 00:30 local time belongs to the new day even though it is still the
previous day in UTC. CSV timestamps are rendered in the same zone (`YYYY-MM-DD HH:MM:SS`).

### Backups (`backups.manage`)

| Route                       | Body / query                                       | Result                                                                                                                                                                                                                     |
| --------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /backups`              | `?includeDeleted&limit`                            | `{directory, schemaVersion, schedule{enabled, time, keepCount, nextRunAt}, items[BackupSummary]}`                                                                                                                          |
| `POST /backups`             | `{}`                                               | `201` — writes a `manual` archive (consistent snapshot of every table) and records it                                                                                                                                      |
| `POST /backups/upload`      | `?fileName=` + raw `application/octet-stream` body | `201` — stores a copied archive in the backup folder after validating its manifest; `400` for anything that is not a LIKApcs archive, `409` if the name exists                                                             |
| `GET /backups/:id`          | —                                                  | one summary                                                                                                                                                                                                                |
| `GET /backups/:id/download` | —                                                  | the archive (`application/gzip`, `content-disposition: attachment`)                                                                                                                                                        |
| `DELETE /backups/:id`       | —                                                  | removes the file, marks the history row `deleted`                                                                                                                                                                          |
| `POST /backups/:id/restore` | `{password, confirm: true}`                        | `403 PASSWORD_MISMATCH` unless the caller's own password matches; `409 SCHEMA_MISMATCH` for another schema version; `409 BACKUP_BUSY` while another backup/restore runs; otherwise `RestoreResult` (see `docs/backups.md`) |

Admin WebSocket event `system.restored` follows a successful restore; Admin apps reload every view.

### Updates (`updates.manage`; the events route only needs a signed-in user)

| Route                         | Body                                                                        | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /system/updates`         | —                                                                           | `UpdatesOverview`: `server{version, schemaVersion, startedAt}`, `targetVersion` (= the server version — clients follow the server), `latest{admin, client, serverUpdateAvailable}` from the cached manifests, `check{checkedAt, ok, error, feedUrl}`, `policy` (the `updates.*` settings), `clients[]` (approved devices with `state: current / outdated / newer / unknown`, online flag and last update run), `counts`, `history[]` (last 50 `update_history` rows) |
| `POST /system/updates/check`  | `{}`                                                                        | Fetches `latest.json` and `latest-client.json` from the release feed (10 s timeout each, independent of each other), upserts `application_versions` (`is_latest` moves to the newest row) and returns the refreshed overview. Never fails the request — a feed problem is reported in `check.error`                                                                                                                                                                  |
| `POST /system/updates/push`   | `{}`                                                                        | Same as `POST /devices/update-outdated`: `update.apply` to every online client older than the server                                                                                                                                                                                                                                                                                                                                                                 |
| `POST /system/updates/events` | `{component: 'admin' \| 'server', fromVersion?, toVersion, status, error?}` | `201 UpdateHistoryEntry` — the Admin app reports its own completed self-update at the first start after it; `client` runs come only from WebSocket events and are rejected here (`400`)                                                                                                                                                                                                                                                                              |

The release feed defaults to `https://raw.githubusercontent.com/astlika/LIKApcs/release-feed` (the
`release-feed` branch, written by the Release workflow — the release page itself only carries the two
installers) and can be
pointed at a local mirror with `LIKAPCS_UPDATE_FEED_URL` (offline venues). When
`updates.check_on_startup` is on, the server checks once at start-up; it also records its own
version change in `update_history` (`component = 'server'`) whenever it starts with a version
different from the last recorded one. Installing is never done by the server: the signed Tauri
updater inside the Admin and Client apps verifies and applies the installers.

### Invoices (`invoices.view` to read/print, `invoices.manage` to issue/void)

An invoice is an A4 document (`F-<year>-NNNNNN`, gap-free from `document_sequences`) issued for one
**completed** sale. The buyer details are snapshotted at issue time; the lines, taxes and payments
always come from the immutable sale. Only one live invoice can exist per sale (a voided invoice keeps
its number and the sale can be invoiced again with the next number).

| Route                        | Body / query                                                                                          | Result                                                                                                                                                                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /invoices`              | `?status=issued\|void&customerId&q&from&to&page&pageSize` (`from`/`to` are ISO datetimes)             | `{items[InvoiceSummary], total, page, pageSize, summary{count, totalCents}}` — the summary counts only `issued` invoices of the filtered period; `q` matches number, buyer name, buyer tax id and receipt number                                 |
| `GET /invoices/:id`          | —                                                                                                     | `InvoiceDetail` = summary + the full `SaleDetail` (lines, payments, refunds)                                                                                                                                                                     |
| `GET /invoices/:id/document` | —                                                                                                     | `InvoiceData` for rendering: `{invoice, sale, business{…}, bankDetails, footer, isReprint}`. Every call increments `print_count`, writes a `print_jobs` row (`document_type='invoice'`) and, from the second time on, audits `invoice.reprinted` |
| `POST /invoices`             | `{saleId, customerId?, billingName, billingTaxId?, billingAddress?, billingEmail?, notes?, dueDays?}` | `201 InvoiceSummary`. `409` unless the sale is `completed`/`partially_refunded`; `409 INVOICE_EXISTS` (`details{invoiceId, invoiceNo}`) when the sale already has a live invoice. `dueDays` defaults to the `printing.invoice_due_days` setting  |
| `POST /invoices/:id/void`    | `{reason}` (≥ 3 characters)                                                                           | `InvoiceSummary` with `status='void'`, `voidedAt/By`, `voidReason`; `409` when already void                                                                                                                                                      |

Issuing, voiding and reprinting are audit-logged (`invoice.created`, `invoice.voided`,
`invoice.reprinted`). `SaleSummary`/`SaleDetail` carry `invoiceId`/`invoiceNo` of the live invoice so
the Sales screen can show the link. The document itself is rendered by the Admin app
(`components/invoices/invoice-document.ts`) in the operator's language and printed through an
isolated iframe, so the A4 layout never depends on the application stylesheet.

### Client registration (no bearer token; rate-limited per IP)

| Method | Path                                | Notes                                                                                                                                                                                                                                                                                                         |
| ------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/client/register`                  | `{machineId, hostname, osInfo?, appVersion, registrationSecret}` → `202 {registrationId, status:'pending'}` (`200` if already approved). An approved device may re-register (reinstall) **only until its token has been collected**; afterwards the stored secret is kept and staff must _re-issue the token_ |
| GET    | `/client/registration/:id?secret=…` | `{status}`; when approved, **the first successful poll** also returns `deviceToken` and `station`. Subsequent polls never return the token again                                                                                                                                                              |

### Client PC → server, with the device token (`Authorization: Bearer <device token>`)

| Method | Path                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/client/staff-unlock` | `{username, password, minutes?}` typed by a staff member on the locked PC (Ctrl+Alt+A). The **server** verifies the account (same lockout rules as `/auth/login`, 10 attempts/min per IP) and requires `stations.unlock`; `409 session_active` while a customer session runs, `409 conflict` when the PC's socket is not connected. Success → `{until, byName, minutes}` and the `unlock` command is sent to the PC |
| POST   | `/client/staff-lock`   | ends the grant early (the _Lock_ button on the PC widget) → `StationSummary`                                                                                                                                                                                                                                                                                                                                        |

The PC never evaluates credentials or permissions itself; it only relays them over the pinned,
device-authenticated connection and shows the server's answer.

### Audit (`audit.view`)

`GET /audit-logs?page&pageSize&action&actorUserId&entityType&from&to&search`,
`GET /audit-logs/actions` (distinct action names for the filter).

## 3. WebSocket — Admin (`/ws/admin`)

```
Admin → Server   { "type": "admin.hello", "token": "<bearer token>", "protocolVersion": 1 }
Server → Admin   { "type": "server.welcome", "protocolVersion": 1, "serverVersion": "0.1.0", "serverTime": "…" }
Server → Admin   { "type": "server.event", "event": "station.changed" | "device.registered" | "device.changed"
                   | "session.changed" | "notification" | "system.restored" | "permissions.changed",
                   "payload": {...}, "ts": "…" }
                   // session.changed carries the full SessionSummary; station.changed follows it
Admin → Server   { "type": "admin.ping" }      →   { "type": "server.pong", "serverTime": "…" }
```

The first frame must be `admin.hello` within 10 s. Invalid token → `4001`. The Admin app treats
events as _cache invalidation_: it refetches the affected lists rather than trusting the payload
blindly, so a missed event can never leave the UI permanently wrong.

## 4. WebSocket — Client (`/ws/client`)

### Handshake

```
Client → Server  { "type": "client.hello", "token": "<device token>", "appVersion": "0.1.0",
                   "protocolVersion": 1, "machineId": "<same id used at registration>" }
Server → Client  { "type": "server.welcome", "protocolVersion": 1, "serverVersion": "…", "serverTime": "…",
                   "station": { "id", "number", "code", "name" },
                   "heartbeatIntervalSeconds": 10, "offlineAfterSeconds": 30,
                   "language": "sq", "welcomeMessage": "…", "businessName": "…",
                   "session": null | { "id", "status", "startedAt", "endsAt", "pausedAt", "remainingSeconds" },
                   "maintenance": null | { "until": "…", "byName": "…" } }
```

Failure codes (`server.error` is sent first, then the socket closes):

| Close code | Meaning                                                          |
| ---------- | ---------------------------------------------------------------- |
| 4001       | unauthorized (bad token / machine-id mismatch / revoked)         |
| 4002       | protocol error (malformed frame, hello timeout, duplicate hello) |
| 4003       | incompatible protocol or app version                             |
| 4004       | replaced by a new connection from the same device                |
| 4005       | device revoked by an administrator                               |
| 4010       | server shutting down                                             |

`session: null` means the PC **must be locked** — unless a live staff `maintenance` grant is present
(`until` in the future, compared with `serverTime`), in which case the PC stays open and re-locks
itself at `until`. The client never decides on its own that time is up for billing purposes — it
only displays the authoritative `endsAt` and locks when told (or when it has lost the server beyond
the grace period, as a safety measure).

### Steady state

```
Client → Server  { "type": "client.heartbeat", "ts": "…", "sessionId": null, "locked": true,
                   "metrics": { "cpuPercent": 12, "memoryUsedMb": 2048, "uptimeSeconds": 120 } }
Server → Client  { "type": "server.heartbeat_ack", "serverTime": "…" }

Server → Client  { "type": "server.command", "commandId": "<uuid>", "seq": 7,
                   "command": "session.start" | "session.pause" | "session.resume" | "session.extend"
                            | "session.end" | "lock" | "unlock" | "message.show"
                            | "power.restart" | "power.shutdown" | "update.apply",
                   "payload": {...}, "issuedAt": "…", "expiresAt": "…" }
Client → Server  { "type": "client.ack", "commandId": "<uuid>", "ok": true }
                 { "type": "client.ack", "commandId": "<uuid>", "ok": false, "error": "…" }

Client → Server  { "type": "client.event", "event": "locked" | "unlocked" | "session_expired_locally"
                            | "maintenance_ended" | "update_status" | "error", "payload": {...} }
```

`maintenance_ended {reason: 'expired' | 'staff'}` is informational: the PC reports that it locked
itself at the end of a staff grant (or that staff pressed _Lock_); the server's own sweep and the
`/client/staff-lock` call remain authoritative for the station status.

Command rules (enforced by the server and mirrored by the client agent,
`apps/likapcs-client/src/lib/protocol.ts`):

1. Commands are only sent to **approved, currently connected** devices.
2. `seq` increases monotonically per connection; a client must ignore a command whose `seq` is not
   greater than the last one it processed, and any command past `expiresAt`.
3. Every command is acknowledged **exactly once**; the server ignores duplicate or unknown acks and
   times out un-acked commands (the issuing API call then fails loudly instead of pretending).
4. There is no generic "run this program" command. Power actions require the `stations.power`
   permission and are audited.
5. The client additionally rejects commands issued more than 120 s in the future (clock skew or a
   replayed capture), remembers the last 500 `commandId`s per connection and only unlocks the screen
   for a `session.*` command whose `sessionId` matches, or for an explicit `unlock`. A `session.end`
   or an expiry it detects locally (`session_expired_locally`) always locks immediately; the server
   remains the billing authority.
6. **Server pinning.** After the first successful registration the client stores the server URL and
   the server's `installationId` (from UDP discovery or a staff-entered address). It reconnects only
   to that server; rediscovery (after 6 failed connection attempts) accepts a new address only if it
   announces the same `installationId`. A client that must move to another installation is revoked in
   the Admin app (or “Forget pairing” in the client settings while staff-unlocked) and re-paired.
7. **Address selection.** A discovery reply carries every IPv4 address of the main PC (`urls`),
   including virtual adapters (VirtualBox, Hyper-V, VPN). The client never trusts the order: it
   probes `GET /system/health` on the address the UDP reply _came from_ first, then on the advertised
   ones (in parallel, 2.5 s), and pins the first that answers. When a server is found by discovery but
   no address answers, the lock screen says so and points at the Windows Firewall fix in Admin
   (Gaming Stations → Connect a PC → Allow now). Staff can also type an address on the lock screen;
   it is normalised (`192.168.1.10` → `http://192.168.1.10:4700`), probed, and the error is specific
   (no answer / not a LIKApcs server / a different installation than the one this PC is paired with).

### Presence

A device is _online_ while its socket is open. Missing heartbeats for `offlineAfterSeconds` → the
server closes the socket (`timeout` in the connection log) and the station turns _offline_. A new
connection from the same device replaces the old one (`4004`), so a flapping Wi-Fi link never leaves
two live sockets.

## 5. Registration flow (end-to-end)

```
Client PC                         Server                              Admin
   │ POST /client/register ───────▶│ create station_devices (pending)    │
   │ ◀── 202 {registrationId} ─────│ broadcast device.registered ───────▶│ "Devices awaiting approval"
   │ GET /registration/:id?secret ▶│ {status:'pending'}                  │
   │        … every 5 s …          │                                     │ approve → station PC 02
   │ GET /registration/:id?secret ▶│ {status:'approved', deviceToken, station}   (token_collected_at set)
   │ store token with DPAPI        │                                     │
   │ WS client.hello(token) ──────▶│ welcome; station.changed ──────────▶│ card turns "Available"
```

Verified in Phase 1 with the server integration tests (`stations-devices.test.ts`) and an end-to-end
browser run against the Admin UI (register → live pending panel → approve → token once → WS online →
disconnect → offline).
