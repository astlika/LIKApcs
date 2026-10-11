-- ============================================================================
-- LIKApcs migration 0012 — POS checkout: cash first, no surprise printing.
--
-- * `pos.card_payments` (default off): card disappears from every payment choice in the app
--   (POS, session billing, refunds, purchases, expenses). The schema and the API still accept
--   `card`, so turning the setting on later needs no migration.
-- * `pos.auto_finish_seconds` (default 5): the "sale completed" screen shows the change due with
--   Print / Finish buttons and starts the next sale by itself after this many seconds.
-- * `pos.auto_print_receipt` is now off by default and existing installations are moved to
--   off as well: the print dialog used to pop up after every sale and block the cashier.
-- * `pos.scan_increments_quantity` is removed — the cart always merges repeated scans into one
--   line, the toggle never changed anything.
-- ============================================================================

INSERT INTO settings (key, value) VALUES
  ('pos.card_payments',       'false'),
  ('pos.auto_finish_seconds', '5');

UPDATE settings SET value = 'false' WHERE key = 'pos.auto_print_receipt';

DELETE FROM settings WHERE key = 'pos.scan_increments_quantity';
