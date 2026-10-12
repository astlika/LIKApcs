-- ============================================================================
-- LIKApcs migration 0020 — paused PCs, orders from the PC, ads v2 (0.10.0).
--
-- 1. Pause. The PC is now really paused: the client covers the screen while a session is
--    paused and the customer may pause / resume from the PC (Settings › Stations). `paused_by`
--    records who paused (staff, the customer, or the server after a disconnect) so the PC can
--    say so and so a *customer* pause can be ended automatically after
--    `sessions.pause_max_minutes` (time cannot be parked for free indefinitely).
--
-- 2. Orders ("Porosit"). During a session the customer picks drinks / snacks from the menu the
--    owner curated (`products.client_menu`) and sends an order. Staff accept it in LIKApcs
--    either "pay now" (a real POS sale is recorded at once) or "on the bill" (settled together
--    with the session when it ends — the lines join the session's sale), or reject it with a
--    reason the PC shows. Prices are snapshotted on the order (promo-aware, the same price the
--    POS would charge); money only ever moves through `sales` / `payments`.
--
-- 3. Ads v2. Per-slide style (`style`), accent colour, call-to-action line, a weekly schedule
--    (`days_mask` bit 0 = Monday … bit 6 = Sunday, plus a daily `time_from`/`time_to` window that
--    may wrap midnight), a rotation weight, per-station targeting and video slides.
-- ============================================================================

-- ─── 1. Pause ───────────────────────────────────────────────────────────────
ALTER TABLE gaming_sessions
  ADD COLUMN paused_by text CHECK (paused_by IS NULL OR paused_by IN ('staff', 'customer', 'grace'));
UPDATE gaming_sessions SET paused_by = 'staff' WHERE status = 'paused' AND paused_by IS NULL;

-- ─── 2. Orders ──────────────────────────────────────────────────────────────
ALTER TABLE products
  ADD COLUMN client_menu       boolean NOT NULL DEFAULT false,
  ADD COLUMN client_menu_order integer NOT NULL DEFAULT 0;
CREATE INDEX products_client_menu_idx ON products (client_menu_order, lower(name))
  WHERE client_menu AND is_active;

CREATE TABLE station_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Short human number ("Order #412") for the desk and the PC.
  number        bigserial NOT NULL,
  station_id    uuid NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  device_id     uuid REFERENCES station_devices(id) ON DELETE SET NULL,
  session_id    uuid REFERENCES gaming_sessions(id) ON DELETE SET NULL,
  customer_id   uuid REFERENCES customers(id) ON DELETE SET NULL,
  -- pending   → the PC sent it, staff have not answered
  -- accepted  → on the bill: settled with the session (→ billed) or paid at the desk (→ paid)
  -- paid      → a sale was recorded for it (pay now / paid later at the desk)
  -- billed    → its lines joined the session's sale when the session ended
  -- rejected  → staff said no (`reason` shown on the PC)
  -- cancelled → the customer took it back while pending
  -- void      → an accepted order written off by staff (`reason`), nothing was sold
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'accepted', 'paid', 'billed', 'rejected', 'cancelled', 'void')),
  settlement    text CHECK (settlement IS NULL OR settlement IN ('pay_now', 'on_bill')),
  note          text CHECK (note IS NULL OR length(note) <= 200),
  total_cents   bigint NOT NULL CHECK (total_cents >= 0),
  reason        text CHECK (reason IS NULL OR length(reason) <= 200),
  sale_id       uuid REFERENCES sales(id) ON DELETE SET NULL,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  decided_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  settled_at    timestamptz,
  CONSTRAINT station_orders_decided CHECK ((status = 'pending') = (decided_at IS NULL)),
  CONSTRAINT station_orders_sold CHECK ((status IN ('paid', 'billed')) = (sale_id IS NOT NULL)),
  CONSTRAINT station_orders_settlement CHECK (status IN ('pending', 'cancelled', 'rejected') OR settlement IS NOT NULL)
);
CREATE INDEX station_orders_open_idx ON station_orders (station_id, requested_at)
  WHERE status IN ('pending', 'accepted');
CREATE INDEX station_orders_session_idx ON station_orders (session_id);
CREATE INDEX station_orders_recent_idx ON station_orders (requested_at DESC);

CREATE TABLE station_order_items (
  id               bigserial PRIMARY KEY,
  order_id         uuid NOT NULL REFERENCES station_orders(id) ON DELETE CASCADE,
  product_id       uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  name             text NOT NULL,
  quantity_milli   bigint NOT NULL CHECK (quantity_milli > 0),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  line_total_cents bigint NOT NULL CHECK (line_total_cents >= 0)
);
CREATE INDEX station_order_items_order_idx ON station_order_items (order_id);

-- ─── 3. Ads v2 ──────────────────────────────────────────────────────────────
ALTER TABLE ads
  ADD COLUMN style       text CHECK (style IS NULL OR style IN ('poster', 'hero', 'split', 'banner')),
  ADD COLUMN accent      text CHECK (accent IS NULL OR accent ~ '^#[0-9a-fA-F]{6}$'),
  ADD COLUMN cta         text CHECK (cta IS NULL OR length(cta) BETWEEN 1 AND 60),
  ADD COLUMN days_mask   smallint NOT NULL DEFAULT 127 CHECK (days_mask BETWEEN 1 AND 127),
  ADD COLUMN time_from   time,
  ADD COLUMN time_to     time,
  ADD COLUMN weight      smallint NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 3),
  ADD COLUMN station_ids uuid[] CHECK (station_ids IS NULL OR cardinality(station_ids) > 0),
  ADD COLUMN video_path  text,
  ADD CONSTRAINT ads_time_window CHECK ((time_from IS NULL) = (time_to IS NULL));

-- ─── Settings ───────────────────────────────────────────────────────────────
INSERT INTO settings (key, value) VALUES
  ('sessions.customer_pause',    'true'),
  ('sessions.customer_resume',   'true'),
  ('sessions.pause_max_minutes', '15'),
  ('orders.enabled',             'true'),
  ('orders.allow_note',          'true'),
  ('orders.settlement',          '"ask"'),
  ('client.ads_style',           '"hero"'),
  ('client.ads_shuffle',         'false'),
  ('client.ads_promo_countdown', 'true');
