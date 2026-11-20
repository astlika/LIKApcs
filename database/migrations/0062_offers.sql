-- 0.36.0 — offers: products and PC minutes sold together at one price ("Coca-Cola + 60 min").
--
-- An offer is a recipe. Selling one writes each of its products and its PC time as ordinary sale
-- lines (stock, cost, tax, time credit, refunds and reports work as for any line); the lines of
-- one offer together cost the offer's price. Each such line remembers the offer it was sold in:
-- the name as it was at the sale (the offer may be renamed or deleted later) and a group number,
-- 1, 2, … within the sale, so a receipt shows the lines of one offer as one row.

CREATE TABLE offers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  price_cents bigint NOT NULL CHECK (price_cents BETWEEN 0 AND 100000000),  -- for all of it, tax included
  minutes     integer NOT NULL DEFAULT 0 CHECK (minutes BETWEEN 0 AND 1440), -- PC minutes; 0 = products only
  is_active   boolean NOT NULL DEFAULT true,                                 -- false = not on the till
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER offers_set_updated_at BEFORE UPDATE ON offers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE offer_items (
  offer_id       uuid NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  product_id     uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity_milli bigint NOT NULL CHECK (quantity_milli > 0),
  sort_order     integer NOT NULL DEFAULT 0,
  PRIMARY KEY (offer_id, product_id)
);
CREATE INDEX offer_items_product_idx ON offer_items (product_id);

ALTER TABLE sale_items
  ADD COLUMN offer_id    uuid REFERENCES offers(id) ON DELETE SET NULL,
  ADD COLUMN offer_name  text,
  ADD COLUMN offer_group integer,
  ADD CONSTRAINT sale_items_offer_whole CHECK ((offer_name IS NULL) = (offer_group IS NULL));
