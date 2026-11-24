-- 0.36.0 — a bill that owes nothing is closed without a receipt.
--
-- A session whose time cost nothing (it ended inside the rule's free minutes, or all of it was
-- paid while it ran) and that has no product on its bill is billed without a sale: billed_at is
-- set, sale_id stays empty. It used to wait at the desk, or to make a receipt of 0.00.
-- (A time-credit session already was billed without a sale of its own.) The rule that stays:
-- a sale on the session means the session is billed.
ALTER TABLE gaming_sessions DROP CONSTRAINT gaming_sessions_billed_once;
ALTER TABLE gaming_sessions ADD CONSTRAINT gaming_sessions_billed_once
  CHECK (sale_id IS NULL OR billed_at IS NOT NULL);
