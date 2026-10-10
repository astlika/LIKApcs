-- ============================================================================
-- LIKApcs migration 0009 — cash register: default register and lookup indexes.
--
-- Phase 6 starts recording cash tenders (sales, session bills, drawer expenses) against cash
-- shifts. Every installation gets one register so the first shift can be opened immediately;
-- more registers can be added later without schema changes.
-- ============================================================================

INSERT INTO cash_registers (name)
SELECT 'Main register'
WHERE NOT EXISTS (SELECT 1 FROM cash_registers);

CREATE INDEX IF NOT EXISTS payments_shift_idx ON payments (shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sales_shift_idx    ON sales (shift_id)    WHERE shift_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS expenses_shift_idx ON expenses (shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS expenses_voided_idx ON expenses (voided_at) WHERE voided_at IS NULL;

-- Customer codes are generated from the shared document sequence (continuous, never reset).
INSERT INTO document_sequences (kind, period, prefix, next_value)
VALUES ('customer', '', 'C', 1)
ON CONFLICT (kind, period) DO NOTHING;
