-- ============================================================================
-- LIKApcs migration 0005 — sales, sale items, payments, refunds, invoices and
-- gap-free document numbering. Implemented by the application in Phase 2.
--
-- Accounting model:
--   sales.total_cents           = what the customer owes for the sale (gross, incl. tax)
--   payments (kind = 'sale')    = money collected against a sale, by method
--   refunds + payments('refund')= money returned; the original sale is never rewritten
--   sale_items.cost_cents       = COGS snapshot (average cost at the time of sale)
-- ============================================================================

CREATE TABLE document_sequences (
  kind        text NOT NULL,                        -- 'receipt' | 'invoice' | 'purchase' | 'refund'
  period      text NOT NULL,                        -- e.g. '2026' (yearly reset) or '' for continuous
  prefix      text NOT NULL DEFAULT '',
  next_value  bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (kind, period)
);

CREATE TABLE sales (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_no        text UNIQUE,                     -- assigned on completion (gap-free per period)
  status            text NOT NULL CHECK (status IN ('suspended', 'completed', 'partially_refunded', 'refunded', 'void')),
  source            text NOT NULL DEFAULT 'retail' CHECK (source IN ('retail', 'gaming', 'mixed')),
  customer_id       uuid REFERENCES customers(id) ON DELETE SET NULL,
  cashier_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  shift_id          uuid REFERENCES cash_shifts(id) ON DELETE SET NULL,
  register_id       uuid REFERENCES cash_registers(id) ON DELETE SET NULL,
  subtotal_cents    bigint NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),   -- sum of lines before sale-level discount
  discount_cents    bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),   -- sale-level discount
  tax_cents         bigint NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents       bigint NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  paid_cents        bigint NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  change_cents      bigint NOT NULL DEFAULT 0 CHECK (change_cents >= 0),
  refunded_cents    bigint NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  discount_authorized_by uuid REFERENCES users(id) ON DELETE SET NULL,
  notes             text,
  /** Idempotency key supplied by the POS so a retried submission never creates a second sale. */
  client_request_id text UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sales_completed_idx ON sales (completed_at DESC) WHERE completed_at IS NOT NULL;
CREATE INDEX sales_customer_idx ON sales (customer_id);
CREATE INDEX sales_cashier_idx ON sales (cashier_user_id, created_at DESC);
CREATE INDEX sales_status_idx ON sales (status);
CREATE TRIGGER sales_set_updated_at BEFORE UPDATE ON sales
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sale_items (
  id                 bigserial PRIMARY KEY,
  sale_id            uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  line_no            integer NOT NULL,
  product_id         uuid REFERENCES products(id) ON DELETE RESTRICT,   -- NULL for gaming time lines
  gaming_session_id  uuid,                                              -- FK added in 0007
  description        text NOT NULL,                                     -- snapshot of product name / session label
  quantity_milli     bigint NOT NULL CHECK (quantity_milli > 0),
  unit_price_cents   bigint NOT NULL CHECK (unit_price_cents >= 0),     -- gross unit price as displayed
  discount_cents     bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  tax_rate_bp        integer NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  tax_cents          bigint NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  line_total_cents   bigint NOT NULL CHECK (line_total_cents >= 0),     -- gross after line discount
  cost_cents         bigint NOT NULL DEFAULT 0 CHECK (cost_cents >= 0), -- COGS snapshot for the whole line
  refunded_milli     bigint NOT NULL DEFAULT 0 CHECK (refunded_milli >= 0),
  UNIQUE (sale_id, line_no)
);
CREATE INDEX sale_items_product_idx ON sale_items (product_id);

CREATE TABLE payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           text NOT NULL CHECK (kind IN ('sale', 'refund', 'wallet_topup', 'customer_payment', 'session_deposit')),
  method         text NOT NULL CHECK (method IN ('cash', 'card', 'bank_transfer', 'wallet', 'credit', 'other')),
  amount_cents   bigint NOT NULL CHECK (amount_cents > 0),   -- always positive; kind gives direction
  sale_id        uuid REFERENCES sales(id) ON DELETE RESTRICT,
  refund_id      uuid,                                       -- FK added below
  customer_id    uuid REFERENCES customers(id) ON DELETE SET NULL,
  shift_id       uuid REFERENCES cash_shifts(id) ON DELETE SET NULL,
  reference      text,                                       -- card slip / bank reference
  received_at    timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_sale_idx ON payments (sale_id);
CREATE INDEX payments_received_idx ON payments (received_at DESC);
CREATE INDEX payments_method_idx ON payments (method, received_at DESC);

CREATE TABLE refunds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_no      text UNIQUE,
  sale_id        uuid NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  total_cents    bigint NOT NULL CHECK (total_cents > 0),
  reason         text NOT NULL,
  restock        boolean NOT NULL DEFAULT true,
  created_by     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  authorized_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  shift_id       uuid REFERENCES cash_shifts(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refunds_sale_idx ON refunds (sale_id);
ALTER TABLE payments
  ADD CONSTRAINT payments_refund_fk FOREIGN KEY (refund_id) REFERENCES refunds(id) ON DELETE RESTRICT;

CREATE TABLE refund_items (
  id             bigserial PRIMARY KEY,
  refund_id      uuid NOT NULL REFERENCES refunds(id) ON DELETE CASCADE,
  sale_item_id   bigint NOT NULL REFERENCES sale_items(id) ON DELETE RESTRICT,
  quantity_milli bigint NOT NULL CHECK (quantity_milli > 0),
  amount_cents   bigint NOT NULL CHECK (amount_cents >= 0),
  UNIQUE (refund_id, sale_item_id)
);

CREATE TABLE invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no    text NOT NULL UNIQUE,
  kind          text NOT NULL CHECK (kind IN ('receipt', 'invoice')),
  sale_id       uuid NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  customer_id   uuid REFERENCES customers(id) ON DELETE SET NULL,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  issued_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  billing_name  text,
  billing_tax_id text,
  billing_address text,
  pdf_path      text,
  print_count   integer NOT NULL DEFAULT 0,
  last_printed_at timestamptz
);
CREATE INDEX invoices_sale_idx ON invoices (sale_id);

-- Every print / reprint is logged (audit requirement for reprints).
CREATE TABLE print_jobs (
  id            bigserial PRIMARY KEY,
  document_type text NOT NULL CHECK (document_type IN ('receipt', 'invoice', 'refund', 'purchase', 'report', 'shift_report')),
  document_id   text NOT NULL,
  is_reprint    boolean NOT NULL DEFAULT false,
  printer_name  text,
  printed_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  printed_at    timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'printed', 'failed')),
  error_message text
);
CREATE INDEX print_jobs_document_idx ON print_jobs (document_type, document_id);
