-- 0.19.8: a pay-later debt with installments gets a schedule. Each part has its own amount, due
-- date and repayments; a repayment is allocated to the part it pays (`debt_payments.installment_id`).
-- The debt keeps `due_date` = the next unpaid part's date, so the overdue lists keep working.
--
-- Existing installment debts that have no repayment yet get the schedule too (same rule as new
-- debts: the first part takes the extra cents, the parts fall due monthly from the debt's date).
-- Debts that already have repayments keep their old display; their parts cannot be split later
-- without choosing the dates, so they are left as they are.

CREATE TABLE debt_installments (
  id           bigserial PRIMARY KEY,
  debt_id      uuid NOT NULL REFERENCES customer_debts(id) ON DELETE RESTRICT,
  seq          smallint NOT NULL CHECK (seq >= 1),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  paid_cents   bigint NOT NULL DEFAULT 0,
  due_date     date NOT NULL,
  CONSTRAINT debt_installments_paid_ok CHECK (paid_cents >= 0 AND paid_cents <= amount_cents),
  CONSTRAINT debt_installments_seq_uniq UNIQUE (debt_id, seq)
);
CREATE INDEX debt_installments_due_idx ON debt_installments (due_date) WHERE paid_cents < amount_cents;

ALTER TABLE debt_payments
  ADD COLUMN installment_id bigint REFERENCES debt_installments(id) ON DELETE RESTRICT;
CREATE INDEX debt_payments_installment_idx ON debt_payments (installment_id);

INSERT INTO debt_installments (debt_id, seq, amount_cents, paid_cents, due_date)
SELECT d.id,
       s.seq,
       d.amount_cents / d.installment_count
         + CASE WHEN s.seq <= d.amount_cents % d.installment_count THEN 1 ELSE 0 END,
       0,
       (d.due_date + make_interval(months => s.seq - 1))::date
  FROM customer_debts d
  CROSS JOIN LATERAL generate_series(1, d.installment_count) AS s(seq)
 WHERE d.installment_count IS NOT NULL
   AND d.paid_cents = 0
   AND d.status IN ('open', 'partial');
