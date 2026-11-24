-- 0.37.0 — speed on a small main PC.
--
-- The screens that are open all day (Stations, the till) asked the database questions whose cost
-- grew with every month of history: each one read the whole table of sessions or sales again.
-- The indexes below answer the same questions from the few rows that matter.

-- Stations list: "which ended sessions of this PC still wait for their money" was a full read of
-- gaming_sessions, twice per PC. The predicate is the one the list uses, word for word.
CREATE INDEX gaming_sessions_station_awaiting_idx ON gaming_sessions (station_id)
  WHERE status IN ('expired', 'completed')
    AND ((billing_mode IN ('endpay', 'postpaid') AND billed_at IS NULL)
      OR (billing_mode = 'prepaid' AND unpaid_cents > 0));

-- Stations list: "the customer of this PC's last ended session".
CREATE INDEX gaming_sessions_station_last_customer_idx
  ON gaming_sessions (station_id, ended_at DESC NULLS LAST)
  WHERE status IN ('expired', 'completed') AND customer_id IS NOT NULL;

-- The sessions of one PC, newest first (the PC's history, the session list filtered by PC).
CREATE INDEX gaming_sessions_station_started_idx ON gaming_sessions (station_id, started_at DESC);

-- Sales list: its totals look up the PC time sold on each sale; the list is ordered by the time
-- the sale was finished (or started, while it is parked).
CREATE INDEX time_credits_sale_idx ON time_credits (sale_id) WHERE sale_id IS NOT NULL;
CREATE INDEX sales_when_idx ON sales ((COALESCE(completed_at, created_at)) DESC);

-- What an offer has sold (the "Ofertat" card): only the sale lines of offers.
CREATE INDEX sale_items_offer_idx ON sale_items (offer_id) WHERE offer_id IS NOT NULL;

-- Product pictures: a small copy for the tiles and lists. The till shows a picture 48 px wide;
-- decoding the full picture for it (800 px, or whatever a link gave) is what made the till slow
-- to open. `image_thumb_of` names the picture the small copy was made from, so a copy that
-- belongs to an older picture is never shown.
ALTER TABLE products
  ADD COLUMN image_thumb_path text,
  ADD COLUMN image_thumb_of   text;

-- Heartbeats: every PC wrote a row here every 10 seconds and nothing ever read them. They were
-- meant to be kept for 7 days, but the clean-up only ran after the server had been up for 24
-- hours — a main PC that is switched off at night never got there, so the table (and every
-- backup, which copies it) only grew. From this version a PC leaves one sample every few
-- minutes and the clean-up runs at start-up. What "last seen" shows lives in station_devices.
TRUNCATE station_heartbeats;

-- Fresh statistics, so the planner uses the new indexes from the first query on.
ANALYZE gaming_sessions;
ANALYZE sales;
ANALYZE sale_items;
ANALYZE time_credits;
