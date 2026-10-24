-- 0045: unit prices and unit costs keep three decimals (0.125 €).
--
-- They are stored in MILLS (thousandths of a euro): 0.125 € = 125 mills, 1 cent = 10 mills.
-- The existing *_cents columns stay and are kept equal to the mills rounded to the cent, so every
-- screen and total that works in whole cents keeps working. Sales still charge whole cents.
--
-- Existing values are exact cents, so mills = cents × 10 and nothing changes numerically.

ALTER TABLE products
  ADD COLUMN selling_price_mills bigint NOT NULL DEFAULT 0 CHECK (selling_price_mills >= 0),
  ADD COLUMN purchase_cost_mills bigint NOT NULL DEFAULT 0 CHECK (purchase_cost_mills >= 0),
  ADD COLUMN average_cost_mills  bigint NOT NULL DEFAULT 0 CHECK (average_cost_mills >= 0);

UPDATE products
   SET selling_price_mills = selling_price_cents * 10,
       purchase_cost_mills = purchase_cost_cents * 10,
       average_cost_mills  = average_cost_cents * 10;

ALTER TABLE purchase_items
  ADD COLUMN unit_cost_mills bigint CHECK (unit_cost_mills >= 0);
UPDATE purchase_items SET unit_cost_mills = unit_cost_cents * 10;
ALTER TABLE purchase_items ALTER COLUMN unit_cost_mills SET NOT NULL;

ALTER TABLE purchase_receipt_items
  ADD COLUMN unit_cost_mills bigint CHECK (unit_cost_mills >= 0);
UPDATE purchase_receipt_items SET unit_cost_mills = unit_cost_cents * 10;
ALTER TABLE purchase_receipt_items ALTER COLUMN unit_cost_mills SET NOT NULL;

ALTER TABLE inventory_movements
  ADD COLUMN unit_cost_mills bigint CHECK (unit_cost_mills >= 0);
UPDATE inventory_movements SET unit_cost_mills = unit_cost_cents * 10 WHERE unit_cost_cents IS NOT NULL;
