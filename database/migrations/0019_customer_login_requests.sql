-- ============================================================================
-- LIKApcs migration 0019 — customer login on the gaming PCs + session requests.
--
-- A registered customer (Admin › Customers) may get a username and a PIN/password (≥ 4 chars,
-- stored hashed like staff passwords, never shown again). On the locked screen of any PC a small
-- "Client" button lets them sign in and ask for time: a quick duration (30/60/120/180 min by
-- default, see `requests.quick_minutes`) or one of the owner's gaming packages. During their own
-- running session they can ask for an extension the same way.
--
-- The request lands in LIKApcs (bell in the top bar, badge on the PC tile) where staff approve
-- it — which opens the normal start / extend dialog pre-filled, so payment (cash now or pay
-- later) is still decided by staff and the PC only ever unlocks through a server-started session
-- — or reject it with a short reason the customer sees on the PC.
--
-- Requests never expire by themselves: they stay `pending` until staff answer, the customer
-- cancels, or the PC's situation changes underneath them (a session is started / extended /
-- ended manually, the device is revoked) — then the server cancels them with a `reason`.
-- At most ONE pending request per station at a time (partial unique index).
-- ============================================================================

ALTER TABLE customers
  ADD COLUMN login_username      text,
  ADD COLUMN login_password_hash text,
  ADD COLUMN login_enabled       boolean NOT NULL DEFAULT false,
  ADD COLUMN login_failed_count  integer NOT NULL DEFAULT 0,
  ADD COLUMN login_locked_until  timestamptz,
  ADD COLUMN last_login_at       timestamptz;

-- One username per customer, case-insensitive; NULL = no login.
CREATE UNIQUE INDEX customers_login_username_idx ON customers (lower(login_username))
  WHERE login_username IS NOT NULL;
ALTER TABLE customers
  ADD CONSTRAINT customers_login_username_format
    CHECK (login_username IS NULL OR login_username ~ '^[A-Za-z0-9._-]{2,32}$'),
  ADD CONSTRAINT customers_login_pair
    CHECK (login_username IS NULL OR login_password_hash IS NOT NULL);

CREATE TABLE session_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id    uuid NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  device_id     uuid REFERENCES station_devices(id) ON DELETE SET NULL,
  customer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('start', 'extend')),
  -- Exactly one of the two: a quick duration or one of the owner's packages.
  minutes       integer CHECK (minutes IS NULL OR (minutes >= 1 AND minutes <= 1440)),
  package_id    uuid REFERENCES gaming_packages(id) ON DELETE SET NULL,
  -- `extend` requests: the customer's running session.
  session_id    uuid REFERENCES gaming_sessions(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  -- Rejection reason (shown to the customer) or why the server cancelled it.
  reason        text,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  decided_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT session_requests_duration CHECK ((minutes IS NULL) <> (package_id IS NULL)),
  CONSTRAINT session_requests_decided CHECK ((status = 'pending') = (decided_at IS NULL))
);
CREATE UNIQUE INDEX session_requests_one_pending_idx ON session_requests (station_id)
  WHERE status = 'pending';
CREATE INDEX session_requests_status_idx ON session_requests (status, requested_at DESC);
CREATE INDEX session_requests_customer_idx ON session_requests (customer_id, requested_at DESC);

INSERT INTO settings (key, value) VALUES
  ('requests.enabled',       'true'),
  ('requests.quick_minutes', '[30, 60, 120, 180]');
