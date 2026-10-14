-- 0.19.0: product variants (size, colour…). A variant is a product of its own — its own barcode,
-- price and stock — that points at a parent product and carries a label ("M", "42", "Red").
-- One level only: a variant cannot have variants, and a parent with variants cannot be a variant.
ALTER TABLE products
  ADD COLUMN parent_id uuid REFERENCES products(id) ON DELETE RESTRICT,
  ADD COLUMN variant_label varchar(40);

ALTER TABLE products ADD CONSTRAINT products_variant_label_pair
  CHECK ((parent_id IS NULL) = (variant_label IS NULL));

CREATE INDEX products_parent_idx ON products (parent_id) WHERE parent_id IS NOT NULL;
