-- ============================================================================
-- LIKApcs migration 0004 — customers, cash registers, shifts, cash movements,
-- expenses. Implemented by the application in Phases 2 and 5.
-- ============================================================================

CREATE TABLE customers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 text NOT NULL,                  -- short customer code / card number
  name                 text NOT NULL,
  phone                text,
  email                text,
  membership           text,                            -- free-form tier name, e.g. 'VIP'
  membership_until     date,
  wallet_balance_cents bigint NOT NULL DEFAULT 0 CHECK (wallet_balance_cents >= 0),  -- prepaid wallet
  loyalty_points       integer NOT NULL DEFAULT 0 CHECK (loyalty_points >= 0),
  discount_bp          integer NOT NULL DEFAULT 0 CHECK (discount_bp BETWEEN 0 AND 10000),
  credit_enabled       boolean NOT NULL DEFAULT false,
  credit_limit_cents   bigint NOT NULL DEFAULT 0 CHECK (credit_limit_cents >= 0),
  balance_due_cents    bigint NOT NULL DEFAULT 0,       -- outstanding amount owed by the customer
  notes                text,
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked', 'archived')),
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX customers_code_idx ON customers (lower(code));
CREATE INDEX customers_name_idx ON customers (lower(name));
CREATE INDEX customers_phone_idx ON customers (phone);
CREATE TRIGGER customers_set_updated_at BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Wallet / loyalty ledger: every change to wallet or points is a row (auditable).
CREATE TABLE customer_ledger (
  id             bigserial PRIMARY KEY,
  customer_id    uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  entry_type     text NOT NULL CHECK (entry_type IN ('wallet_topup', 'wallet_payment', 'wallet_refund', 'credit_sale', 'credit_payment', 'points_earned', 'points_redeemed', 'adjustment')),
  amount_cents   bigint NOT NULL DEFAULT 0,
  points_delta   integer NOT NULL DEFAULT 0,
  reference_type text,
  reference_id   text,
  note           text,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_ledger_customer_idx ON customer_ledger (customer_id, created_at DESC);

CREATE TABLE cash_registers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO cash_registers (name) VALUES ('Main register');

CREATE TABLE cash_shifts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  register_id          uuid NOT NULL REFERENCES cash_registers(id) ON DELETE RESTRICT,
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_by            uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  opened_at            timestamptz NOT NULL DEFAULT now(),
  opening_cents        bigint NOT NULL DEFAULT 0 CHECK (opening_cents >= 0),
  closed_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  closed_at            timestamptz,
  expected_cash_cents  bigint,                          -- computed at close: opening + cash in − cash out
  counted_cash_cents   bigint,                          -- physically counted by the employee
  difference_cents     bigint,                          -- counted − expected
  notes                text
);
CREATE INDEX cash_shifts_register_idx ON cash_shifts (register_id, opened_at DESC);
-- Only one open shift per register.
CREATE UNIQUE INDEX cash_shifts_one_open_per_register_idx ON cash_shifts (register_id) WHERE status = 'open';

-- Every cash drawer change. Sales/refunds create rows automatically; deposits/withdrawals are manual.
CREATE TABLE cash_movements (
  id             bigserial PRIMARY KEY,
  shift_id       uuid NOT NULL REFERENCES cash_shifts(id) ON DELETE RESTRICT,
  movement_type  text NOT NULL CHECK (movement_type IN ('opening', 'sale', 'refund', 'deposit', 'withdrawal', 'expense', 'supplier_payment', 'wallet_topup', 'customer_payment', 'correction')),
  amount_cents   bigint NOT NULL CHECK (amount_cents <> 0),   -- positive = into drawer, negative = out
  reason         text,
  reference_type text,
  reference_id   text,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cash_movements_shift_idx ON cash_movements (shift_id, created_at);
CREATE INDEX cash_movements_reference_idx ON cash_movements (reference_type, reference_id);

CREATE TABLE expense_categories (
  code       text PRIMARY KEY,
  name_en    text NOT NULL,
  name_sq    text NOT NULL,
  is_system  boolean NOT NULL DEFAULT false,
  is_active  boolean NOT NULL DEFAULT true
);
INSERT INTO expense_categories (code, name_en, name_sq, is_system) VALUES
  ('electricity', 'Electricity',            'Energjia elektrike',     true),
  ('internet',    'Internet',               'Interneti',              true),
  ('rent',        'Rent',                   'Qiraja',                 true),
  ('salaries',    'Salaries',               'Pagat',                  true),
  ('repairs',     'Repairs',                'Riparimet',              true),
  ('hardware',    'Hardware purchases',     'Blerje pajisjesh',       true),
  ('cleaning',    'Cleaning',               'Pastrimi',               true),
  ('software',    'Software subscriptions', 'Abonime softuerike',     true),
  ('other',       'Other',                  'Tjetër',                 true);

CREATE TABLE expenses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_date   date NOT NULL,
  category_code  text NOT NULL REFERENCES expense_categories(code),
  amount_cents   bigint NOT NULL CHECK (amount_cents > 0),
  payment_method text NOT NULL CHECK (payment_method IN ('cash', 'card', 'bank_transfer', 'other')),
  description    text NOT NULL,
  receipt_path   text,                                   -- attached scan/photo (stored outside the DB)
  shift_id       uuid REFERENCES cash_shifts(id) ON DELETE SET NULL,  -- set when paid from the drawer
  supplier_id    uuid REFERENCES suppliers(id) ON DELETE SET NULL,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  voided_at      timestamptz,
  voided_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  void_reason    text
);
CREATE INDEX expenses_date_idx ON expenses (expense_date DESC);
CREATE INDEX expenses_category_idx ON expenses (category_code);
CREATE TRIGGER expenses_set_updated_at BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
