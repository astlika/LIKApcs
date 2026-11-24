-- 0.36.0 — money on a session's bill that is not settled in one step.
--
-- unpaid_cents / unpaid_seconds: a PAID (prepaid) session can take more minutes "to pay at the
-- end". Those minutes are the last unpaid_seconds of planned_seconds and cost unpaid_cents; they
-- are not part of quoted_price_cents, which stays "what was paid for the time". The amount waits
-- at the desk when the session ends and joins quoted / final once it is paid.
--
-- paid_cents: an OPEN-TIME (postpaid) session can be paid while it runs on. This is what was
-- already taken for its time; the final bill takes it off.
--
-- pricing_rules.free_minutes: "up to N minutes free" — a session that lasts no longer costs
-- nothing; past it the whole time is charged. Snapshotted into gaming_sessions.billing_terms.
ALTER TABLE gaming_sessions
  ADD COLUMN unpaid_cents   bigint  NOT NULL DEFAULT 0 CHECK (unpaid_cents >= 0),
  ADD COLUMN unpaid_seconds integer NOT NULL DEFAULT 0 CHECK (unpaid_seconds >= 0),
  ADD COLUMN paid_cents     bigint  NOT NULL DEFAULT 0 CHECK (paid_cents >= 0);

ALTER TABLE pricing_rules
  ADD COLUMN free_minutes integer NOT NULL DEFAULT 0 CHECK (free_minutes BETWEEN 0 AND 60);

-- The desk's "waiting bills" list looks for ended sessions with something still to pay.
CREATE INDEX gaming_sessions_unpaid_idx ON gaming_sessions (ended_at)
  WHERE unpaid_cents > 0;
