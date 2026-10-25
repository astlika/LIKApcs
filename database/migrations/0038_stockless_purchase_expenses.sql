-- 0.19.1: a purchase line for a product that does not track stock (a service, a consumable that is
-- not kept in stock) is an operating expense, booked automatically when it is received. A stock
-- product keeps going into inventory. The link to the receipt line makes the booking exactly-once.

ALTER TABLE expenses
  ADD COLUMN purchase_receipt_item_id bigint REFERENCES purchase_receipt_items(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX expenses_purchase_receipt_item_uidx
  ON expenses (purchase_receipt_item_id) WHERE purchase_receipt_item_id IS NOT NULL;
