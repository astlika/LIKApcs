# LIKApcs — Database schema

PostgreSQL 17 (≥ 14 works). The schema is created exclusively by the SQL files in
`database/migrations/`, applied in order by the server (`LIKAPCS_AUTO_MIGRATE=true`) or manually with
`node dist/cli.js migrate`. Migrations are **forward-only**: to undo something, write a new migration.

| Rule                                                                  | Why                                                                                                   |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| One file = one transaction                                            | A failed migration leaves the database exactly as it was                                              |
| `schema_migrations(version, name, checksum, applied_at, duration_ms)` | Every applied file's SHA-256 is recorded; an edited historical file aborts startup with a clear error |
| `pg_advisory_lock` during migration                                   | Two server processes starting together cannot both migrate                                            |
| `text` + `CHECK` instead of `ENUM`                                    | New values are a plain `ALTER TABLE … DROP/ADD CONSTRAINT`, visible in dumps                          |
| `set_updated_at()` trigger                                            | `updated_at` is maintained by the database, not by application code                                   |

Conventions: `uuid` primary keys (`bigserial` for append-only logs), `*_cents BIGINT` money,
`*_milli BIGINT` quantities, `*_bp INTEGER` percentages (basis points), `timestamptz` everywhere.

## Migration map

| File                         | Domain                    | Tables                                                                                                                                             |
| ---------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001_core.sql`              | Identity & system         | roles, permissions, role_permissions, users, user_roles, user_sessions, audit_logs, settings, application_versions, update_history, backup_history |
| `0002_stations.sql`          | Gaming PCs                | stations, station_devices, station_heartbeats, station_connection_logs                                                                             |
| `0003_catalog_inventory.sql` | Catalogue & stock         | tax_categories, categories, suppliers, units_of_measure, products, product_barcodes, inventory_movements, stock_counts, stock_count_items          |
| `0004_customers_cash.sql`    | Customers, cash, expenses | customers, customer_ledger, cash_registers, cash_shifts, cash_movements, expense_categories, expenses                                              |
| `0005_sales.sql`             | Sales                     | document_sequences, sales, sale_items, payments, refunds, refund_items, invoices, print_jobs                                                       |
| `0006_purchasing.sql`        | Purchasing                | purchases, purchase_items, purchase_receipts, purchase_receipt_items, purchase_payments, purchase_returns, purchase_return_items                   |
| `0007_gaming.sql`            | Gaming sessions           | pricing_rules, gaming_packages, gaming_sessions, session_events (+ FK `sale_items.gaming_session_id`)                                              |

All 33 tables required by the specification exist (plus supporting tables such as `user_sessions`,
`station_connection_logs`, `document_sequences`, `customer_ledger`, `print_jobs`). Phase 1 code
_uses_ the 0001/0002 tables and reads aggregate zeros from the others; later phases add the services.

## Entity overview

```
roles ──< role_permissions >── permissions          settings (key → jsonb value)
  │                                                   audit_logs (append-only)
  └──< user_roles >── users ──< user_sessions

stations ──< station_devices ──< station_heartbeats
    │             └──< station_connection_logs
    └──< gaming_sessions ──< session_events
              │   └── pricing_rules / gaming_packages (snapshotted into the session)
              └── sale (sale_items.gaming_session_id)

categories / suppliers / tax_categories / units_of_measure ── products ──< product_barcodes
products ──< inventory_movements (every stock change, with stock_after)
products ──< stock_count_items >── stock_counts

customers ──< customer_ledger
cash_registers ──< cash_shifts ──< cash_movements
                        └──< sales / payments / refunds / expenses (shift_id)

sales ──< sale_items          purchases ──< purchase_items
sales ──< payments            purchases ──< purchase_receipts ──< purchase_receipt_items
sales ──< refunds ──< refund_items        purchases ──< purchase_payments
sales ──  invoices            purchases ──< purchase_returns ──< purchase_return_items
```

## Key tables in detail

### Identity (0001)

- **users** — `username` (unique, case-insensitive), `password_hash` (`scrypt$N$r$p$salt$hash`),
  `is_active`, `must_change_password`, `failed_login_attempts`, `locked_until`, `last_login_at`.
- **roles / permissions / role_permissions** — the six system roles are seeded by the migration with
  their permission sets; `roles.rank` (owner 0 … cashier/inventory/accountant 30) drives "who may
  manage whom".
- **user_sessions** — `token_hash` (SHA-256 of the bearer token), `expires_at`, `revoked_at`,
  `client_app`, `ip_address`.
- **audit_logs** — `actor_user_id` / `actor_device_id` / `actor_label`, `action` (dotted, e.g.
  `auth.login_failed`), `entity_type` + `entity_id`, `details jsonb`, `severity` (info/warning/critical).
- **settings** — key/value (`jsonb`); the schema of every key is defined once in
  `packages/shared/src/settings.ts` and validated on write. Only `PUBLIC_SETTING_KEYS` are readable
  without authentication (business name, language, currency, time zone).
- **application_versions / update_history / backup_history** — reserved for Phases 6–7
  (`signature` column exists so updates can be verified, not just downloaded over HTTPS).

### Stations (0002)

- **stations** — `number` (unique, 1–999) → `code` (`PC 03`), `name`, `zone`, `is_enabled`, `notes`.
- **station_devices** — one physical PC. `machine_id` (unique, from the client), `status`
  pending/approved/revoked/rejected, `token_hash`, `registration_secret_hash` (proves the poller is
  the PC that registered), `token_collected_at` (token delivered exactly once), `approved_by`,
  `revoked_by`, `last_seen_at`, `last_ip`. A partial unique index guarantees **at most one approved
  device per station**.
- **station_heartbeats** — append-only telemetry (`metrics jsonb`, `locked`, `session_id`), pruned
  after 7 days.
- **station_connection_logs** — connected / disconnected / replaced / rejected / timeout / error
  events shown in the station detail dialog.

### Catalogue & inventory (0003)

- **products** — `selling_price_cents`, `purchase_cost_cents` (last), `average_cost_cents` (moving
  average, used for COGS snapshots), `stock_milli`, `min_stock_milli`, `allow_negative_stock`,
  `track_stock`, `tax_category_id`, `unit_code`.
- **product_barcodes** — many barcodes per product (unique globally), `quantity_milli` for pack/case
  barcodes (a 6-pack barcode sells 6.000 units).
- **inventory_movements** — every change with `movement_type` (purchase_receipt, purchase_return,
  sale, sale_return, adjustment, stock_count, damaged, expired, missing, transfer, initial), signed `quantity_milli_delta`, `stock_after_milli`,
  `unit_cost_cents`, and a `reference_type/id` back to the document.
- **stock_counts / stock_count_items** — physical counts with expected vs counted and the
  adjustment movement they produced.

### Customers, cash & expenses (0004)

- **customers** — membership, `wallet_balance_cents`, `loyalty_points`, `discount_bp`, credit
  (`credit_enabled`, `credit_limit_cents`, `balance_due_cents`); **customer_ledger** is the
  append-only money trail behind wallet/credit.
- **cash_registers / cash_shifts / cash_movements** — one open shift per register (partial unique
  index); shift stores `opening_cents`, `expected_cash_cents`, `counted_cash_cents`,
  `difference_cents`.
- **expenses** — `category_code`, `amount_cents`, `payment_method`, optional `shift_id` (cash paid
  from the drawer), void with reason.

### Sales (0005)

- **document_sequences** — gap-free numbering per document type/period (`receipt_no`, `refund_no`,
  `invoice_no`), incremented inside the completing transaction.
- **sales** — `status` suspended/completed/partially_refunded/refunded/void, `subtotal_cents`,
  `discount_cents`, `tax_cents`, `total_cents`, `paid_cents`, `change_cents`, `refunded_cents`,
  `client_request_id` (idempotency), `shift_id`, `cashier_user_id`.
- **sale_items** — snapshots: `description`, `unit_price_cents`, `tax_rate_bp`, `cost_cents`
  (COGS for the whole line, from the product's average cost at sale time), `quantity_milli`,
  optional `gaming_session_id`.
- **payments** — `kind` sale/refund/wallet_topup/customer_payment/session_deposit, `method`
  cash/card/bank_transfer/wallet/credit/other, `amount_cents`, `shift_id`.
- **refunds / refund_items** — partial or full, `restock` flag, `authorized_by`.
- **invoices**, **print_jobs** — invoice numbering/data and a queue for receipt printing.

### Purchasing (0006)

- **purchases** (`status` draft/ordered/partially_received/received/cancelled, `payment_status`,
  `total_cents`, `paid_cents`) → **purchase_items** (ordered vs received quantity, unit cost) →
  **purchase_receipts / purchase_receipt_items** (each goods receipt creates inventory movements and
  updates average cost) → **purchase_payments** (supplier payments) → **purchase_returns**.

### Gaming (0007)

- **pricing_rules** — hourly `rate_cents_per_hour` with `days_of_week`, `start_time/end_time`,
  `billing_increment_minutes`, `minimum_charge_cents`, `minimum_minutes`, `rounding_mode/increment`,
  `priority`, happy-hour flag, validity dates, optional `station_id` (NULL = all).
- **gaming_packages** — fixed-duration prepaid bundles (`duration_minutes`, `price_cents`), per
  station list / day / time window.
- **gaming_sessions** — `billing_mode` prepaid/postpaid, `status` active/paused/completed/cancelled/
  expired, `rate_cents_per_hour` snapshot, `planned_seconds`, `started_at`, `ends_at` (authoritative
  expiry for prepaid), `paused_at`, `total_paused_seconds`, `billable_seconds`, `final_price_cents`,
  `sale_id` + `billed_at` (**exactly-once billing**: the Phase 3 billing transaction locks the session
  row and refuses to bill when `billed_at` is already set), `transferred_from_id`, `version`.
  A partial unique index allows **one live (active/paused) session per station**.
- **session_events** — start/pause/resume/extend/transfer/stop/expire/lock/unlock… with
  `command_id UNIQUE` as the idempotency key for remote commands.

## Operations

```bash
# apply pending migrations / show status
pnpm db:migrate
pnpm db:status

# in a deployed server
node dist/cli.js migrate
node dist/cli.js migrate:status
node dist/cli.js create-admin        # recovery: create or repair an owner account
```

Backups (Phase 6) use `pg_dump` custom format written to `LIKAPCS_BACKUP_DIR` (outside the install
directory). Restore requires an administrator login and an explicit confirmation in the Admin app.
