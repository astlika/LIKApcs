-- 0.19.0: a session started from a time credit is billed — the money was taken at the till with
-- the credit's sale — so it has billed_at but no sale of its own. time_credit_id says which credit
-- paid for it (the audit trail, and reports count its minutes as billed).

ALTER TABLE gaming_sessions
  ADD COLUMN time_credit_id uuid REFERENCES time_credits(id) ON DELETE RESTRICT;

ALTER TABLE gaming_sessions DROP CONSTRAINT gaming_sessions_billed_once;
ALTER TABLE gaming_sessions ADD CONSTRAINT gaming_sessions_billed_once CHECK (
  (sale_id IS NULL) = (billed_at IS NULL)
  OR (time_credit_id IS NOT NULL AND sale_id IS NULL AND billed_at IS NOT NULL)
);
