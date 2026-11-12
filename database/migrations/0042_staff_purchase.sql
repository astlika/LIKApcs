-- 0.20.7: a staff purchase is a sale settled with the non-cash tender `staff`. The items are
-- priced at their purchase cost, no money changes hands and the drawer does not move; the stock
-- goes out and the cost is booked as cost of goods sold.

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_method_check;
ALTER TABLE payments
  ADD CONSTRAINT payments_method_check
  CHECK (method IN ('cash', 'card', 'bank_transfer', 'wallet', 'credit', 'other', 'staff'));
