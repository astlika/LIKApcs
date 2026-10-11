-- ============================================================================
-- LIKApcs migration 0014 — PC hardware details + the client screen settings.
--
-- * `station_devices.hardware`: CPU / GPU / RAM / OS / disk as reported by LIKApcs-Client with
--   `client.hello` (static facts). Live load (CPU %, RAM, temperatures) keeps travelling in the
--   heartbeat and is served from the server's presence table — it is not worth a row per second.
-- * `client.*` settings: how the countdown widget looks on the customer PC (size, corner, style,
--   whether the paid / owed amounts show), what the lock screen title says (brand or the PC code)
--   and the lock-screen product slideshow ("ads": in-stock products with photos, layout,
--   transition, interval, price). All public: the Admin previews them and the client receives
--   them in `server.welcome.display` and on every change.
-- ============================================================================

ALTER TABLE station_devices ADD COLUMN hardware jsonb;

INSERT INTO settings (key, value) VALUES
  ('client.widget_size',          '"normal"'),
  ('client.widget_position',      '"top-right"'),
  ('client.widget_style',         '"detailed"'),
  ('client.widget_show_payment',  'true'),
  ('client.lock_title',           '"brand"'),
  ('client.ads_enabled',          'false'),
  ('client.ads_layout',           '"card"'),
  ('client.ads_transition',       '"slide-left"'),
  ('client.ads_interval_seconds', '8'),
  ('client.ads_show_price',       'true');
