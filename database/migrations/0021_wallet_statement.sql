-- ============================================================================
-- LIKApcs migration 0021 — customer wallet ("balanca") and the account statement (0.11.0).
--
-- A regular customer may pay money in advance; it sits on *their* name and is spent on PC time,
-- drinks and snacks — at the POS, at the station dialog, for "pay now" orders and to settle
-- debts. The schema was prepared in 0004 (`customers.wallet_balance_cents` ≥ 0 and the
-- `customer_ledger`); this migration turns it on:
--
-- * `customer_ledger.balance_after_cents` — the running balance after every entry, so the
--   statement reads like a bank statement without re-summing history.
-- * `wallet_withdrawal` — paying a balance back out in cash (an owner correction path).
--   Entry types used from now on: `wallet_topup` (+ cash in), `wallet_payment` (− spent on a
--   sale / debt), `wallet_refund` (+ a refunded sale returned to the balance),
--   `wallet_withdrawal` (− cash paid back).
-- * `payments.kind` gains `wallet_refund` (the cash paid back out), `cash_movements` gains
--   `wallet_refund` so the drawer and the Z report show it on its own line. Top-ups already
--   had `wallet_topup` on both.
-- * Permissions: `wallet.topup` (take money in: owner, admin, manager, cashier) and
--   `wallet.refund` (pay a balance back out: owner, admin, manager).
-- * Setting `wallet.enabled` — the master switch for the balance tender and the wallet UI.
--
-- The statement itself (every receipt of a customer with how it was paid, debts and their
-- repayments, wallet entries) is a read model over existing tables — no new table.
-- ============================================================================

ALTER TABLE customer_ledger ADD COLUMN balance_after_cents bigint;

ALTER TABLE customer_ledger DROP CONSTRAINT customer_ledger_entry_type_check;
ALTER TABLE customer_ledger ADD CONSTRAINT customer_ledger_entry_type_check
  CHECK (entry_type IN ('wallet_topup', 'wallet_payment', 'wallet_refund', 'wallet_withdrawal',
                        'credit_sale', 'credit_payment', 'points_earned', 'points_redeemed', 'adjustment'));

ALTER TABLE payments DROP CONSTRAINT payments_kind_check;
ALTER TABLE payments ADD CONSTRAINT payments_kind_check
  CHECK (kind IN ('sale', 'refund', 'wallet_topup', 'wallet_refund', 'customer_payment', 'session_deposit'));

ALTER TABLE cash_movements DROP CONSTRAINT cash_movements_movement_type_check;
ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_movement_type_check
  CHECK (movement_type IN ('opening', 'sale', 'refund', 'deposit', 'withdrawal', 'expense', 'supplier_payment',
                           'wallet_topup', 'wallet_refund', 'customer_payment', 'correction'));

-- The statement reads payments by customer (top-ups, pay-outs, debt repayments).
CREATE INDEX payments_customer_idx ON payments (customer_id, received_at DESC) WHERE customer_id IS NOT NULL;

INSERT INTO permissions (code, category, description) VALUES
  ('wallet.topup',  'customers', 'Take money in advance onto a customer balance'),
  ('wallet.refund', 'customers', 'Pay a customer balance back out in cash');
INSERT INTO role_permissions (role_id, permission_code)
  SELECT r.id, 'wallet.topup' FROM roles r WHERE r.code IN ('owner', 'admin', 'manager', 'cashier');
INSERT INTO role_permissions (role_id, permission_code)
  SELECT r.id, 'wallet.refund' FROM roles r WHERE r.code IN ('owner', 'admin', 'manager');

INSERT INTO settings (key, value) VALUES
  ('wallet.enabled', 'true');
