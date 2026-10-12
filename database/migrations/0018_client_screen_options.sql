-- ============================================================================
-- LIKApcs migration 0018 — the locked screen of the gaming PCs, made configurable.
--
-- Until now the slideshow had one grid (2×2) and always sat inside the lock-screen chrome
-- (brand top-left, clock top-right, "This PC is locked" strip underneath). The owner can now
-- shape the whole screen from Settings › Client screen; every value travels in
-- `server.welcome.display.ads` / `server.display` and the Admin previews it live:
--   * `client.ads_grid`            columns × rows of a grid page: 2x2, 3x2, 4x2, 3x3, 4x3, 4x4
--   * `client.ads_fullscreen`      slideshow edge to edge, chrome becomes overlays
--   * `client.ads_show_clock`      } overlays / chrome, each one switchable
--   * `client.ads_show_brand`      }
--   * `client.ads_show_station`    } (PC code pill)
--   * `client.ads_show_status`     } ("This PC is locked — ask the staff" strip)
--   * `client.ads_show_category`   category chip above a product's name
--   * `client.ads_show_progress`   page dots + progress bar
--   * `client.ads_image_fit`       contain (whole picture) / cover (fills the frame)
--   * `client.ads_caption`         full layout: bottom / top / hidden caption
--   * `client.ads_motion`          slow zoom / pan on full-screen pictures
--   * `client.ads_background`      backdrop preset behind the slides (same names as ad themes)
--   * `client.ads_ticker_text`     scrolling line at the bottom (empty = none)
-- Defaults reproduce the 0.7.x look exactly, so nothing changes on upgrade.
-- ============================================================================

INSERT INTO settings (key, value) VALUES
  ('client.ads_grid',           '"2x2"'),
  ('client.ads_fullscreen',     'false'),
  ('client.ads_show_clock',     'true'),
  ('client.ads_show_brand',     'true'),
  ('client.ads_show_station',   'true'),
  ('client.ads_show_status',    'true'),
  ('client.ads_show_category',  'true'),
  ('client.ads_show_progress',  'true'),
  ('client.ads_image_fit',      '"contain"'),
  ('client.ads_caption',        '"bottom"'),
  ('client.ads_motion',         'true'),
  ('client.ads_background',     '"midnight"'),
  ('client.ads_ticker_text',    '""');
