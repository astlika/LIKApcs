-- 0023 — order preparation check (0.13.0)
--
-- After an order from a PC is accepted, the desk prepares it: every line is scanned with the
-- barcode scanner (the exact quantity, the right product) or confirmed by hand. The check is
-- optional per line and can be switched off entirely (`orders.scan_check`). What was verified and
-- how is kept on the order for the audit trail; the PC is told when the order is on its way.

ALTER TABLE station_orders
  ADD COLUMN prepared_at timestamptz,
  ADD COLUMN prepared_by uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE station_order_items
  -- Quantity (milli units) verified at preparation; 0 until the order is prepared.
  ADD COLUMN verified_milli bigint NOT NULL DEFAULT 0 CHECK (verified_milli >= 0),
  -- How the line was verified: scanned with the barcode scanner, or confirmed by hand.
  ADD COLUMN verification text CHECK (verification IS NULL OR verification IN ('scan', 'manual'));

INSERT INTO settings (key, value) VALUES
  ('orders.scan_check', 'true');
