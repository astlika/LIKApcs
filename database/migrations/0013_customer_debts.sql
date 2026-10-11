-- ============================================================================
-- LIKApcs migration 0013 — customer debts ("pay later").
--
-- * `pos.credit_sales` (default OFF): when on, the payment dialogs (POS, session bills) offer
--   "Pay later" for a selected customer; the sale completes with a `credit` tender and one row
--   in `customer_debts` with a due date. `pos.credit_default_days` pre-fills that date.
-- * `customer_debts` is the receivable ledger; `debt_payments` links every (partial) repayment
--   to a `payments` row of kind `customer_payment` (cash goes into the open shift as a
--   `customer_payment` movement). `customers.balance_due_cents` is kept equal to the sum of the
--   open remainders so lists and the POS can show it without a join.
-- * `customers.credit_limit_cents` (existing column) now means: 0 = no limit, otherwise the
--   maximum outstanding balance a new debt may reach. Blocked/archived customers get no credit.
-- ============================================================================

INSERT INTO settings (key, value) VALUES
  ('pos.credit_sales',        'false'),
  ('pos.credit_default_days', '7');

-- Forgiving a debt is a management decision: owner, admin and manager get it; cashiers collect
-- (pos.sell), view (customers.view) and may agree a new due date (customers.manage).
INSERT INTO permissions (code, category, description) VALUES
  ('debts.write_off', 'customers', 'Write off customer debts that will not be paid');
INSERT INTO role_permissions (role_id, permission_code)
  SELECT r.id, 'debts.write_off' FROM roles r WHERE r.code IN ('owner', 'admin', 'manager');

CREATE TABLE customer_debts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  sale_id            uuid REFERENCES sales(id) ON DELETE RESTRICT,          -- sale / session bill that opened it
  amount_cents       bigint NOT NULL CHECK (amount_cents > 0),
  paid_cents         bigint NOT NULL DEFAULT 0 CHECK (paid_cents >= 0 AND paid_cents <= amount_cents),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partial', 'paid', 'written_off')),
  due_date           date NOT NULL,
  notes              text,
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  settled_at         timestamptz,
  written_off_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  written_off_reason text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_debts_customer_idx ON customer_debts (customer_id, status);
CREATE INDEX customer_debts_open_due_idx ON customer_debts (due_date) WHERE status IN ('open', 'partial');
CREATE INDEX customer_debts_sale_idx ON customer_debts (sale_id);
CREATE TRIGGER customer_debts_set_updated_at BEFORE UPDATE ON customer_debts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE debt_payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  debt_id      uuid NOT NULL REFERENCES customer_debts(id) ON DELETE RESTRICT,
  payment_id   uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,   -- kind = 'customer_payment'
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX debt_payments_debt_idx ON debt_payments (debt_id);
CREATE INDEX debt_payments_payment_idx ON debt_payments (payment_id);
