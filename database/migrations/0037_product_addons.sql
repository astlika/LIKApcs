-- 0.19.1: product extras with their own price (e.g. Toast + cheese). An extra adds its price to the
-- line and never moves stock. The chosen extras are snapshotted on the sale line (`sale_items.addons`),
-- so later edits or deletions of an extra do not change past receipts.

CREATE TABLE product_addons (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  price_cents bigint NOT NULL CHECK (price_cents BETWEEN 0 AND 100000000),
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_addons_product_idx ON product_addons (product_id, sort_order);

ALTER TABLE sale_items ADD COLUMN addons jsonb NOT NULL DEFAULT '[]'::jsonb;
