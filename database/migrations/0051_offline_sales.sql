-- 0.28.0 (punkt 4, shtresa 1): POS sales made while a PC was offline.
-- The PC numbers its own sale (`PC<n>-000001`, local_number). The official receipt number
-- (`R-YYYY-NNNNNN`, gap-free) is still given by the server, when the sale is synced.
-- price_changed: the price the cashier saw differed from the price on the server at sync time.
ALTER TABLE sales
  ADD COLUMN local_number       text,
  ADD COLUMN device_code        text,
  ADD COLUMN offline_created_at timestamptz,
  ADD COLUMN price_changed      boolean NOT NULL DEFAULT false;

-- One local number per PC, ever: a retry of the same sale is caught by client_request_id first.
CREATE UNIQUE INDEX sales_device_local_number_uq
  ON sales (device_code, local_number) WHERE local_number IS NOT NULL;
