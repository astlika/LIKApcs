-- ============================================================================
-- LIKApcs migration 0003 — catalog & inventory: tax categories, categories,
-- suppliers, products, barcodes, units, inventory movements, stock counts.
-- Implemented by the application in Phase 2.
-- ============================================================================

CREATE TABLE tax_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  rate_bp    integer NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
  is_default boolean NOT NULL DEFAULT false,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tax_categories_single_default_idx ON tax_categories (is_default) WHERE is_default;

CREATE TABLE categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  parent_id  uuid REFERENCES categories(id) ON DELETE SET NULL,
  color      text,                                  -- hex color for POS tiles
  sort_order integer NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX categories_name_parent_idx ON categories (lower(name), COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE TRIGGER categories_set_updated_at BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE suppliers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  business_name   text,
  tax_id          text,
  phone           text,
  email           text,
  address         text,
  contact_person  text,
  notes           text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX suppliers_name_idx ON suppliers (lower(name));
CREATE TRIGGER suppliers_set_updated_at BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE units_of_measure (
  code       text PRIMARY KEY,                     -- 'pc', 'bottle', 'can', 'pack', 'm', 'kg', custom
  name_en    text NOT NULL,
  name_sq    text NOT NULL,
  is_decimal boolean NOT NULL DEFAULT false,       -- allow fractional quantities (kg, m)
  is_system  boolean NOT NULL DEFAULT false
);
INSERT INTO units_of_measure (code, name_en, name_sq, is_decimal, is_system) VALUES
  ('pc',     'Piece',    'Copë',    false, true),
  ('bottle', 'Bottle',   'Shishe',  false, true),
  ('can',    'Can',      'Kanaçe',  false, true),
  ('pack',   'Pack',     'Pako',    false, true),
  ('m',      'Meter',    'Metër',   true,  true),
  ('kg',     'Kilogram', 'Kilogram', true, true);

CREATE TABLE products (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  sku                 text NOT NULL,
  category_id         uuid REFERENCES categories(id) ON DELETE SET NULL,
  brand               text,
  supplier_id         uuid REFERENCES suppliers(id) ON DELETE SET NULL,
  tax_category_id     uuid REFERENCES tax_categories(id) ON DELETE SET NULL,
  unit_code           text NOT NULL DEFAULT 'pc' REFERENCES units_of_measure(code),
  purchase_cost_cents bigint NOT NULL DEFAULT 0 CHECK (purchase_cost_cents >= 0),  -- last purchase cost
  average_cost_cents  bigint NOT NULL DEFAULT 0 CHECK (average_cost_cents >= 0),   -- weighted average (costing method)
  selling_price_cents bigint NOT NULL DEFAULT 0 CHECK (selling_price_cents >= 0),
  price_includes_tax  boolean NOT NULL DEFAULT true,
  stock_milli         bigint NOT NULL DEFAULT 0,          -- current quantity (milli units); maintained via inventory_movements
  min_stock_milli     bigint NOT NULL DEFAULT 0 CHECK (min_stock_milli >= 0),
  allow_negative_stock boolean NOT NULL DEFAULT false,
  track_stock         boolean NOT NULL DEFAULT true,
  image_path          text,
  description         text,
  storage_location    text,
  is_active           boolean NOT NULL DEFAULT true,       -- false = discontinued/archived
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX products_sku_idx ON products (lower(sku));
CREATE INDEX products_name_idx ON products (lower(name));
CREATE INDEX products_category_idx ON products (category_id);
CREATE INDEX products_low_stock_idx ON products (is_active) WHERE track_stock AND stock_milli <= min_stock_milli;
CREATE TRIGGER products_set_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE product_barcodes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  barcode    text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  /** Optional: barcode that sells a multiple of the base unit (e.g. a 6-pack). */
  quantity_milli bigint NOT NULL DEFAULT 1000 CHECK (quantity_milli > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_barcodes_format CHECK (barcode ~ '^[A-Za-z0-9._-]{3,64}$')
);
CREATE UNIQUE INDEX product_barcodes_barcode_idx ON product_barcodes (barcode);
CREATE INDEX product_barcodes_product_idx ON product_barcodes (product_id);
CREATE UNIQUE INDEX product_barcodes_one_primary_idx ON product_barcodes (product_id) WHERE is_primary;

-- Every stock change is a movement. products.stock_milli = SUM(quantity_milli_delta).
CREATE TABLE inventory_movements (
  id                   bigserial PRIMARY KEY,
  product_id           uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  movement_type        text NOT NULL CHECK (movement_type IN (
                         'purchase_receipt', 'purchase_return', 'sale', 'sale_return',
                         'adjustment', 'stock_count', 'damaged', 'expired', 'missing', 'transfer', 'initial')),
  quantity_milli_delta bigint NOT NULL CHECK (quantity_milli_delta <> 0),
  stock_after_milli    bigint NOT NULL,
  unit_cost_cents      bigint CHECK (unit_cost_cents IS NULL OR unit_cost_cents >= 0),
  reason               text,
  reference_type       text,                        -- 'sale' | 'purchase' | 'stock_count' | 'refund' ...
  reference_id         text,
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_movements_product_time_idx ON inventory_movements (product_id, created_at DESC);
CREATE INDEX inventory_movements_reference_idx ON inventory_movements (reference_type, reference_id);
CREATE INDEX inventory_movements_created_idx ON inventory_movements (created_at);

CREATE TABLE stock_counts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
  notes        text,
  started_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  completed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  completed_at timestamptz
);

CREATE TABLE stock_count_items (
  id              bigserial PRIMARY KEY,
  stock_count_id  uuid NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  product_id      uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  expected_milli  bigint NOT NULL,
  counted_milli   bigint,
  note            text,
  UNIQUE (stock_count_id, product_id)
);
