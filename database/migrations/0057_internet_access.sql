-- 0.34.0 (internet access): Wi-Fi access codes sold at the till as products.
--
-- A package ("Internet 1h", "Internet 2h" …) is a product of the kind `internet_access`. Its codes
-- are loaded in bulk (pasted, one per line); each unit sold hands out the oldest unused code, which
-- stays on the sale line for good. The stock of such a product is the number of its unused codes:
-- it moves through `inventory_movements` like any other stock, and the database itself refuses a
-- transaction that would leave the two apart.
ALTER TABLE products
  ADD COLUMN kind text NOT NULL DEFAULT 'standard'
    CHECK (kind IN ('standard', 'internet_access'));

-- What makes an internet access package: counted stock that can never go below zero, sold by the
-- piece, not a variant and not on the PC menu (a code is handed over at the till, after payment).
ALTER TABLE products ADD CONSTRAINT products_internet_access_shape
  CHECK (
    kind <> 'internet_access'
    OR (track_stock AND NOT allow_negative_stock AND unit_code = 'pc'
        AND parent_id IS NULL AND NOT client_menu)
  );
CREATE INDEX products_kind_idx ON products (kind) WHERE kind <> 'standard';

-- Loading and removing codes are stock movements of their own, so the stock history names them
-- and the money reports (which count adjustments as stock gained or lost) leave them out.
ALTER TABLE inventory_movements DROP CONSTRAINT inventory_movements_movement_type_check;
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_movement_type_check
  CHECK (movement_type IN (
    'purchase_receipt', 'purchase_return', 'sale', 'sale_return',
    'adjustment', 'stock_count', 'damaged', 'expired', 'missing', 'transfer', 'initial',
    'staff_out', 'codes_loaded', 'codes_removed'));

CREATE TABLE internet_access_codes (
  id            bigserial PRIMARY KEY,
  product_id    uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  -- Exactly as it was pasted (trimmed): codes are case-sensitive.
  code          text NOT NULL CHECK (length(code) BETWEEN 1 AND 64 AND code !~ '\s'),
  -- One paste = one batch, so a wrong paste can be taken back as a whole.
  batch_id      uuid NOT NULL,
  status        text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'sold')),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Filled in the moment the code is sold; a sold code is never changed or removed again.
  sale_id       uuid REFERENCES sales(id) ON DELETE RESTRICT,
  sale_item_id  bigint REFERENCES sale_items(id) ON DELETE RESTRICT,
  sold_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  sold_at       timestamptz,
  CONSTRAINT internet_access_codes_sold_pair CHECK (
    (status = 'available' AND sale_id IS NULL AND sale_item_id IS NULL AND sold_at IS NULL)
    OR (status = 'sold' AND sale_id IS NOT NULL AND sale_item_id IS NOT NULL AND sold_at IS NOT NULL)
  )
);
-- A code waits to be sold in one place only (whatever the package): it cannot be sold twice.
CREATE UNIQUE INDEX internet_access_codes_available_idx
  ON internet_access_codes (code) WHERE status = 'available';
-- The next code of a package: the oldest unused one.
CREATE INDEX internet_access_codes_next_idx
  ON internet_access_codes (product_id, id) WHERE status = 'available';
CREATE INDEX internet_access_codes_product_idx ON internet_access_codes (product_id, status, id);
CREATE INDEX internet_access_codes_code_idx ON internet_access_codes (code);
CREATE INDEX internet_access_codes_sale_item_idx
  ON internet_access_codes (sale_item_id) WHERE sale_item_id IS NOT NULL;
CREATE INDEX internet_access_codes_sale_idx
  ON internet_access_codes (sale_id) WHERE sale_id IS NOT NULL;
CREATE INDEX internet_access_codes_batch_idx ON internet_access_codes (batch_id);

-- A sold code stays as it is: what was sold, when, on which sale. (Who loaded or sold it may lose
-- its user when that account is removed; nothing else moves.)
CREATE FUNCTION internet_access_codes_keep_sold() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'sold' AND (
       TG_OP = 'DELETE'
       OR (NEW.code, NEW.product_id, NEW.batch_id, NEW.status, NEW.sale_id, NEW.sale_item_id, NEW.sold_at)
          IS DISTINCT FROM
          (OLD.code, OLD.product_id, OLD.batch_id, OLD.status, OLD.sale_id, OLD.sale_item_id, OLD.sold_at)
     ) THEN
    RAISE EXCEPTION 'a sold internet access code cannot be changed or removed'
      USING ERRCODE = '23514', CONSTRAINT = 'internet_access_codes_sold_is_final';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER internet_access_codes_keep_sold
  BEFORE UPDATE OR DELETE ON internet_access_codes
  FOR EACH ROW EXECUTE FUNCTION internet_access_codes_keep_sold();

-- Only an internet access package holds codes.
CREATE FUNCTION internet_access_codes_kind() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM products p WHERE p.id = NEW.product_id AND p.kind = 'internet_access') THEN
    RAISE EXCEPTION 'internet access codes belong to an internet access product'
      USING ERRCODE = '23514', CONSTRAINT = 'internet_access_codes_product_kind';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER internet_access_codes_kind
  BEFORE INSERT OR UPDATE OF product_id ON internet_access_codes
  FOR EACH ROW EXECUTE FUNCTION internet_access_codes_kind();

-- The stock of a package and its unused codes are one number. Checked when the transaction ends,
-- once for every package whose stock moved in it.
CREATE FUNCTION internet_access_stock_matches_codes() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_kind  text;
  current_stock bigint;
  unused        bigint;
BEGIN
  SELECT p.kind, p.stock_milli INTO current_kind, current_stock FROM products p WHERE p.id = NEW.id;
  IF current_kind IS DISTINCT FROM 'internet_access' THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO unused
    FROM internet_access_codes c WHERE c.product_id = NEW.id AND c.status = 'available';
  IF current_stock <> unused * 1000 THEN
    RAISE EXCEPTION 'the stock of an internet access product (%) must equal its unused codes (%)',
      current_stock / 1000.0, unused
      USING ERRCODE = '23514', CONSTRAINT = 'internet_access_stock_matches_codes';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER products_internet_access_stock
  AFTER INSERT OR UPDATE OF stock_milli, kind ON products
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION internet_access_stock_matches_codes();

-- The other side: codes that are added, sold or removed without the stock following. Checked once
-- per statement, for the packages that statement touched (the stock is always moved first).
CREATE FUNCTION internet_access_codes_match_stock() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bad record;
BEGIN
  FOR bad IN
    SELECT p.id, p.stock_milli,
           (SELECT count(*) FROM internet_access_codes c
             WHERE c.product_id = p.id AND c.status = 'available') AS unused
      FROM products p
     WHERE p.id IN (SELECT product_id FROM touched)
  LOOP
    IF bad.stock_milli <> bad.unused * 1000 THEN
      RAISE EXCEPTION 'the unused codes of an internet access product (%) must equal its stock (%)',
        bad.unused, bad.stock_milli / 1000.0
        USING ERRCODE = '23514', CONSTRAINT = 'internet_access_stock_matches_codes';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER internet_access_codes_stock_ins
  AFTER INSERT ON internet_access_codes
  REFERENCING NEW TABLE AS touched
  FOR EACH STATEMENT EXECUTE FUNCTION internet_access_codes_match_stock();
CREATE TRIGGER internet_access_codes_stock_upd
  AFTER UPDATE ON internet_access_codes
  REFERENCING NEW TABLE AS touched
  FOR EACH STATEMENT EXECUTE FUNCTION internet_access_codes_match_stock();
CREATE TRIGGER internet_access_codes_stock_del
  AFTER DELETE ON internet_access_codes
  REFERENCING OLD TABLE AS touched
  FOR EACH STATEMENT EXECUTE FUNCTION internet_access_codes_match_stock();
