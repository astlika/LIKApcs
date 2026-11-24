-- 0.40.0 — the time of each product on a PC's bill.
--
-- A customer who plays takes a drink, later something to eat; all of it goes on the PC's bill and
-- is paid at the end. When the bill is questioned ("I did not take that"), the desk has to know at
-- what time each product was put on it, to look at the camera recording of that minute.
--
-- While the bill is open that time is the order's (`station_orders.decided_at`: the moment the
-- desk added the product, or accepted what the customer sent from the PC). Once the bill is paid
-- the products become lines of the sale, and a sale line had no time of its own — only the sale's,
-- which is the time of the payment. `added_at` keeps the time on the line, so the receipt, a
-- reprint and the sales list still show it.
--
-- NULL on every other line (PC time, products sold at the till): there the time of the sale is
-- the time of the product.
ALTER TABLE sale_items ADD COLUMN added_at timestamptz;

-- The bills paid before this version. Each product line of such a sale came from one line of an
-- order that the sale settled (`station_orders.sale_id`):
--   • `billed`: the order was paid with the PC's bill — its lines are on the sale under that PC
--     (`sale_items.gaming_session_id`);
--   • `paid` after standing on the bill (`settlement = 'on_bill'`, accepted before it was
--     settled): the order was paid on its own at the desk — the sale holds nothing else.
-- An order paid in the very step it was added or accepted needs no time: the sale's own is it.
--
-- The sale lines were written in the order the orders are read (by request time, then by line),
-- so the n-th line of a product is the n-th order line of that product. A pair is taken only when
-- the quantities agree; a line without its pair keeps NULL (no time is better than a wrong one).
WITH sale_lines AS (
  SELECT si.id, si.sale_id, si.gaming_session_id, si.product_id, si.quantity_milli,
         row_number() OVER (PARTITION BY si.sale_id, si.gaming_session_id, si.product_id
                            ORDER BY si.line_no, si.id) AS n
    FROM sale_items si
   WHERE si.product_id IS NOT NULL
     AND si.sale_id IN (SELECT o.sale_id FROM station_orders o WHERE o.sale_id IS NOT NULL)
), order_lines AS (
  SELECT x.sale_id, x.bill_session_id, x.product_id, x.quantity_milli, x.added_at,
         row_number() OVER (PARTITION BY x.sale_id, x.bill_session_id, x.product_id
                            ORDER BY x.requested_at, x.item_id) AS n
    FROM (
      SELECT o.sale_id,
             CASE WHEN o.status = 'billed' THEN o.session_id END AS bill_session_id,
             i.product_id, i.quantity_milli, i.id AS item_id, o.requested_at,
             COALESCE(o.decided_at, o.requested_at) AS added_at
        FROM station_orders o
        JOIN station_order_items i ON i.order_id = o.id
       WHERE o.sale_id IS NOT NULL
         AND ((o.status = 'billed' AND o.session_id IS NOT NULL)
           OR (o.status = 'paid' AND o.settlement = 'on_bill' AND o.decided_at < o.settled_at))
    ) x
)
UPDATE sale_items si
   SET added_at = ol.added_at
  FROM sale_lines sl
  JOIN order_lines ol
    ON ol.sale_id = sl.sale_id
   AND ol.bill_session_id IS NOT DISTINCT FROM sl.gaming_session_id
   AND ol.product_id = sl.product_id
   AND ol.n = sl.n
   AND ol.quantity_milli = sl.quantity_milli
 WHERE si.id = sl.id;
