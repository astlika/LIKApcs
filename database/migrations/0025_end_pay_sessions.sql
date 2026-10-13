-- 0.14.0 · "Pay at the end" (End Pay) sessions.
--
-- A third billing mode next to prepaid / postpaid: the customer picks a fixed amount of time
-- (like prepaid — normal countdown, extensions add time), but nothing is paid when it starts.
-- When the time runs out the PC locks and the bill waits at the desk ("awaiting payment") until
-- staff collect it (cash / balance / pay later) — then the receipt is written. Ended early, the
-- used time is billed, capped at the reserved amount.
--
-- State of an End Pay session:
--   active/paused          running, quoted_price_cents = reserved amount (grows with extensions)
--   expired / completed    ended; billed_at NULL  → awaiting payment (final_price_cents = amount due)
--                          ended; billed_at set   → collected (sale_id = the receipt)
--   cancelled              freed without a charge (nothing was ever taken)

ALTER TABLE gaming_sessions DROP CONSTRAINT gaming_sessions_billing_mode_check;
ALTER TABLE gaming_sessions
  ADD CONSTRAINT gaming_sessions_billing_mode_check
  CHECK (billing_mode IN ('prepaid', 'postpaid', 'endpay'));

-- Like prepaid, an End Pay session always has a fixed expiry.
ALTER TABLE gaming_sessions
  ADD CONSTRAINT gaming_sessions_endpay_has_end
  CHECK (billing_mode <> 'endpay' OR ends_at IS NOT NULL);

-- The "awaiting payment" strip (Stations + Dashboard) reads exactly this set.
CREATE INDEX gaming_sessions_awaiting_payment_idx
  ON gaming_sessions (ended_at DESC)
  WHERE billing_mode = 'endpay' AND billed_at IS NULL AND status IN ('expired', 'completed');
