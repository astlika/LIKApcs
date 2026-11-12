-- 0.28.0: a staff purchase is its own document, not a sale.
-- The items leave the stock (movement `staff_out`) and an expense of category `staff_purchase`
-- is booked automatically. No money goes through the drawer, and the purchase is not revenue.
-- Only owner and admin get `pos.staff_purchase` by default; the role can be changed in
-- Roles & permissions.

ALTER TABLE inventory_movements DROP CONSTRAINT inventory_movements_movement_type_check;
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_movement_type_check
  CHECK (movement_type IN (
    'purchase_receipt', 'purchase_return', 'sale', 'sale_return',
    'adjustment', 'stock_count', 'damaged', 'expired', 'missing', 'transfer', 'initial',
    'staff_out'));

CREATE TABLE staff_purchases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  total_cost_cents bigint NOT NULL CHECK (total_cost_cents >= 0),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Set for purchases converted from the old staff sales (0.20.7 - 0.27.4); the receipt number
  -- is kept so the old document can still be found.
  source_sale_id   uuid REFERENCES sales(id) ON DELETE SET NULL,
  source_receipt_no text
);
CREATE INDEX staff_purchases_created_idx ON staff_purchases (created_at DESC);

CREATE TABLE staff_purchase_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_purchase_id uuid NOT NULL REFERENCES staff_purchases(id) ON DELETE CASCADE,
  product_id        uuid REFERENCES products(id) ON DELETE RESTRICT,
  description       text NOT NULL,
  quantity_milli    bigint NOT NULL CHECK (quantity_milli > 0),
  unit_cost_cents   bigint NOT NULL CHECK (unit_cost_cents >= 0),
  line_cost_cents   bigint NOT NULL CHECK (line_cost_cents >= 0)
);
CREATE INDEX staff_purchase_items_purchase_idx ON staff_purchase_items (staff_purchase_id);

ALTER TABLE expenses
  ADD COLUMN staff_purchase_id uuid REFERENCES staff_purchases(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX expenses_staff_purchase_uidx
  ON expenses (staff_purchase_id) WHERE staff_purchase_id IS NOT NULL;

INSERT INTO expense_categories (code, name_en, name_sq, is_system) VALUES
  ('staff_purchase', 'Staff purchase', 'Blerja e stafit', true);

INSERT INTO permissions (code, category, description) VALUES
  ('pos.staff_purchase', 'pos', 'Record a staff purchase (at cost, no money through the drawer)');

INSERT INTO role_permissions (role_id, permission_code)
  SELECT r.id, 'pos.staff_purchase' FROM roles r WHERE r.code IN ('owner', 'admin');

-- Existing staff purchases: each sale settled with the `staff` tender becomes a staff purchase
-- with an expense. The sale rows stay (receipt numbers stay gap-free) but are marked `void`, so
-- they no longer count as revenue in the reports and the dashboard.
CREATE TEMP TABLE _staff_sales AS
  SELECT s.id, s.receipt_no, s.total_cents, s.cashier_user_id,
         COALESCE(s.completed_at, s.created_at) AS at
    FROM sales s
   WHERE s.status <> 'void'
     AND EXISTS (SELECT 1 FROM payments p WHERE p.sale_id = s.id AND p.method = 'staff');

INSERT INTO staff_purchases (total_cost_cents, created_by, created_at, source_sale_id, source_receipt_no)
  SELECT t.total_cents, t.cashier_user_id, t.at, t.id, t.receipt_no FROM _staff_sales t;

INSERT INTO staff_purchase_items (staff_purchase_id, product_id, description, quantity_milli, unit_cost_cents, line_cost_cents)
  SELECT sp.id, si.product_id, si.description, si.quantity_milli, si.unit_price_cents, si.line_total_cents
    FROM sale_items si
    JOIN staff_purchases sp ON sp.source_sale_id = si.sale_id;

INSERT INTO expenses (expense_date, category_code, amount_cents, payment_method, description,
                      created_by, created_at, staff_purchase_id)
  SELECT (t.at AT TIME ZONE 'Europe/Belgrade')::date, 'staff_purchase', t.total_cents, 'other',
         'Staff purchase ' || COALESCE(t.receipt_no, ''), t.cashier_user_id, t.at, sp.id
    FROM _staff_sales t
    JOIN staff_purchases sp ON sp.source_sale_id = t.id
   WHERE t.total_cents > 0;

UPDATE sales SET status = 'void' WHERE id IN (SELECT id FROM _staff_sales);

DROP TABLE _staff_sales;
