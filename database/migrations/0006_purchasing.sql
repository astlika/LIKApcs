-- ============================================================================
-- LIKApcs migration 0006 — purchasing: purchase orders, line items, receipts,
-- supplier payments and purchase returns. Implemented in Phase 2.
--
-- Ordering, receiving and paying are separate steps:
--   * A draft/ordered purchase changes NOTHING in stock or finance.
--   * Receiving (purchase_receipts) creates inventory_movements and updates average cost.
--   * Paying (purchase_payments) reduces the supplier balance and (if cash) the drawer.
-- ============================================================================

CREATE TABLE purchases (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_no           text NOT NULL UNIQUE,               -- internal number, e.g. PO-2026-00012
  supplier_id            uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  supplier_invoice_no    text,
  status                 text NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'ordered', 'partially_received', 'received', 'cancelled')),
  order_date             date NOT NULL DEFAULT CURRENT_DATE,
  expected_date          date,
  subtotal_cents         bigint NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  additional_costs_cents bigint NOT NULL DEFAULT 0 CHECK (additional_costs_cents >= 0),  -- freight, customs...
  tax_cents              bigint NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents            bigint NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  paid_cents             bigint NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  payment_status         text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'partial', 'paid')),
  notes                  text,
  created_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchases_supplier_idx ON purchases (supplier_id, order_date DESC);
CREATE INDEX purchases_status_idx ON purchases (status);
CREATE TRIGGER purchases_set_updated_at BEFORE UPDATE ON purchases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE purchase_items (
  id                      bigserial PRIMARY KEY,
  purchase_id             uuid NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  line_no                 integer NOT NULL,
  product_id              uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  description             text NOT NULL,
  quantity_ordered_milli  bigint NOT NULL CHECK (quantity_ordered_milli > 0),
  quantity_received_milli bigint NOT NULL DEFAULT 0 CHECK (quantity_received_milli >= 0),
  quantity_returned_milli bigint NOT NULL DEFAULT 0 CHECK (quantity_returned_milli >= 0),
  unit_cost_cents         bigint NOT NULL CHECK (unit_cost_cents >= 0),
  tax_rate_bp             integer NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  line_total_cents        bigint NOT NULL CHECK (line_total_cents >= 0),
  UNIQUE (purchase_id, line_no)
);
CREATE INDEX purchase_items_product_idx ON purchase_items (product_id);

-- A receipt = one delivery (supports partial deliveries).
CREATE TABLE purchase_receipts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id  uuid NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT,
  received_at  timestamptz NOT NULL DEFAULT now(),
  received_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  delivery_note_no text,
  notes        text
);

CREATE TABLE purchase_receipt_items (
  id                  bigserial PRIMARY KEY,
  receipt_id          uuid NOT NULL REFERENCES purchase_receipts(id) ON DELETE CASCADE,
  purchase_item_id    bigint NOT NULL REFERENCES purchase_items(id) ON DELETE RESTRICT,
  quantity_milli      bigint NOT NULL CHECK (quantity_milli > 0),
  unit_cost_cents     bigint NOT NULL CHECK (unit_cost_cents >= 0),
  inventory_movement_id bigint REFERENCES inventory_movements(id) ON DELETE SET NULL
);

CREATE TABLE purchase_payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id  uuid NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  method       text NOT NULL CHECK (method IN ('cash', 'card', 'bank_transfer', 'other')),
  paid_at      timestamptz NOT NULL DEFAULT now(),
  reference    text,
  shift_id     uuid REFERENCES cash_shifts(id) ON DELETE SET NULL,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_payments_purchase_idx ON purchase_payments (purchase_id);

CREATE TABLE purchase_returns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_no     text NOT NULL UNIQUE,
  purchase_id   uuid NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT,
  reason        text NOT NULL,
  total_cents   bigint NOT NULL CHECK (total_cents >= 0),
  status        text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'cancelled')),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE purchase_return_items (
  id                    bigserial PRIMARY KEY,
  return_id             uuid NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
  purchase_item_id      bigint NOT NULL REFERENCES purchase_items(id) ON DELETE RESTRICT,
  quantity_milli        bigint NOT NULL CHECK (quantity_milli > 0),
  unit_cost_cents       bigint NOT NULL CHECK (unit_cost_cents >= 0),
  inventory_movement_id bigint REFERENCES inventory_movements(id) ON DELETE SET NULL
);

-- Price history is derived from purchase_receipt_items; a dedicated view keeps reports simple.
CREATE VIEW product_purchase_price_history AS
  SELECT pi.product_id,
         pr.received_at,
         p.supplier_id,
         pri.unit_cost_cents,
         pri.quantity_milli,
         p.reference_no
    FROM purchase_receipt_items pri
    JOIN purchase_receipts pr ON pr.id = pri.receipt_id
    JOIN purchase_items pi    ON pi.id = pri.purchase_item_id
    JOIN purchases p          ON p.id = pr.purchase_id;
