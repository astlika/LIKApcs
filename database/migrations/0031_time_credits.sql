-- 0.19.0: prepaid time sold at the till. A sale line "PC 3 · 60 min" creates a credit for that PC;
-- the desk starts (or extends) a session on that PC by redeeming it — no new sale, no new money.
-- The credit is bound to one station (its pricing rule is the one it was sold under). Unused
-- minutes never expire; a refund is allowed only while none of them were used.

CREATE TABLE time_credits (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id           uuid NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  sale_item_id      bigint NOT NULL UNIQUE REFERENCES sale_items(id) ON DELETE CASCADE,
  station_id        uuid NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
  minutes_total     integer NOT NULL CHECK (minutes_total > 0),
  minutes_remaining integer NOT NULL CHECK (minutes_remaining >= 0 AND minutes_remaining <= minutes_total),
  price_cents       bigint NOT NULL CHECK (price_cents >= 0),
  cancelled_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX time_credits_open_idx ON time_credits (station_id)
  WHERE cancelled_at IS NULL AND minutes_remaining > 0;
