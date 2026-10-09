-- ============================================================================
-- LIKApcs migration 0008 — gaming sessions: full pricing-terms snapshot and idempotent starts.
--
-- 0007 snapshotted only the hourly rate. The final charge also depends on the billing increment,
-- minimums and rounding of the rule in force when the session started; editing a rule later must
-- never change what a running session is charged, so the complete terms are frozen on the row.
-- ============================================================================

ALTER TABLE gaming_sessions
  ADD COLUMN billing_terms      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN client_request_id  text UNIQUE;      -- idempotency key supplied by the Admin app

COMMENT ON COLUMN gaming_sessions.billing_terms IS
  'Snapshot {rateCentsPerHour, billingIncrementMinutes, minimumMinutes, minimumChargeCents, roundingMode, roundingIncrementCents}';
