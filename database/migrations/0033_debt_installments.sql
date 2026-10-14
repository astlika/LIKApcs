-- 0.19.0: simple installments on a pay-later debt. The customer agrees to pay the debt in N parts;
-- there are no dates to schedule (the existing due date still applies). The debt shows the
-- installment count, the parts paid so far (repayments) and the amount of the next part.
ALTER TABLE customer_debts
  ADD COLUMN installment_count smallint CHECK (installment_count BETWEEN 2 AND 24);
