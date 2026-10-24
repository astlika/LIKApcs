-- 0.20.8: prepaid PC time is sold to a NAME, not to a PC. The till sells minutes without choosing
-- a PC; the customer (or the generic name "Klient") gets a 4-digit PIN, printed once on the sale.
-- At any PC the customer types the name and the PIN, and the PC starts with the minutes left.
-- Old credits keep their PC (station_id) and have no PIN, so they stay desk-only.

ALTER TABLE time_credits ALTER COLUMN station_id DROP NOT NULL;

ALTER TABLE time_credits
  ADD COLUMN holder_name       text,
  ADD COLUMN customer_id       uuid REFERENCES customers(id) ON DELETE SET NULL,
  ADD COLUMN pin_hash          text,
  ADD COLUMN pin_failed_count  integer NOT NULL DEFAULT 0,
  ADD COLUMN pin_locked_until  timestamptz;

CREATE INDEX time_credits_holder_idx ON time_credits (lower(holder_name))
  WHERE cancelled_at IS NULL AND pin_hash IS NOT NULL;
