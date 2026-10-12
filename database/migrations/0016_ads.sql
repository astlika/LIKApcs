-- ============================================================================
-- LIKApcs migration 0016 — advertisements for the customer screen ("Reklamat").
--
-- Until now LIKApcs-Client showed every active product that had a photo. From 0.7.0 the owner
-- curates the slideshow in LIKApcs Admin › Ads:
--   * `product` ads point at a product and may carry a promo price. An active promo is the price
--     the POS charges (the server derives it — the POS only sends product ids), so the shelf, the
--     screen and the receipt always agree.
--   * `custom` ads are free slides (title, text, optional picture) — opening hours, tournaments,
--     "Happy hour 18–20".
-- Both kinds share: badge ("-20%", "NEW"), schedule (`starts_at`/`ends_at`, open ended when NULL),
-- an enabled switch and a manual order. One ad per product keeps the promo price unambiguous.
-- `client.ads_enabled` (0014) stays the master switch for the slideshow itself.
--
-- The existing slideshow is kept as it was: every active product with a photo becomes a product
-- ad (no promo), so nothing disappears from the screens on upgrade.
-- ============================================================================

CREATE TABLE ads (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL CHECK (kind IN ('product', 'custom')),
  product_id        uuid REFERENCES products(id) ON DELETE CASCADE,
  title             text CHECK (title IS NULL OR length(title) BETWEEN 1 AND 80),
  body              text CHECK (body IS NULL OR length(body) <= 300),
  image_path        text,
  promo_price_cents bigint CHECK (promo_price_cents IS NULL OR promo_price_cents >= 0),
  badge             text CHECK (badge IS NULL OR length(badge) BETWEEN 1 AND 16),
  starts_at         timestamptz,
  ends_at           timestamptz,
  enabled           boolean NOT NULL DEFAULT true,
  sort_order        integer NOT NULL DEFAULT 0,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ads_kind_shape CHECK (
    (kind = 'product' AND product_id IS NOT NULL) OR
    (kind = 'custom'  AND product_id IS NULL AND title IS NOT NULL AND promo_price_cents IS NULL)
  ),
  CONSTRAINT ads_window CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);
CREATE UNIQUE INDEX ads_one_per_product ON ads (product_id) WHERE kind = 'product';
CREATE INDEX ads_order ON ads (sort_order, created_at);
CREATE TRIGGER ads_set_updated_at BEFORE UPDATE ON ads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Keep today's screens unchanged: the products that were in the slideshow become product ads.
INSERT INTO ads (kind, product_id, sort_order)
  SELECT 'product', p.id, row_number() OVER (ORDER BY p.updated_at DESC) * 10
    FROM products p
   WHERE p.is_active AND p.image_path IS NOT NULL;
