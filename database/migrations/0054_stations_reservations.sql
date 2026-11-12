-- 0.32.0 (stations board): manual badges per PC, and PC reservations.
-- A reservation books one or more PCs for a start time. Each PC is a "hold" that stays until a
-- session starts on it (checked_in) or the tolerance passes (released). The server sweeps expiries.

ALTER TABLE stations
  ADD COLUMN badges text[] NOT NULL DEFAULT '{}';

CREATE TABLE reservations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  starts_at         timestamptz NOT NULL,
  tolerance_minutes integer NOT NULL CHECK (tolerance_minutes BETWEEN 1 AND 60),
  customer_id       uuid REFERENCES customers(id) ON DELETE SET NULL,
  customer_name     text NOT NULL,
  phone             text,
  notes             text,
  status            text NOT NULL DEFAULT 'scheduled'
                      CHECK (status IN ('scheduled', 'active', 'completed', 'expired', 'cancelled')),
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_name   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  cancelled_at      timestamptz
);
CREATE INDEX reservations_open_idx ON reservations (starts_at) WHERE status IN ('scheduled', 'active');

CREATE TABLE reservation_stations (
  reservation_id      uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  station_id          uuid NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  state               text NOT NULL DEFAULT 'held' CHECK (state IN ('held', 'checked_in', 'released')),
  checked_in_session_id uuid REFERENCES gaming_sessions(id) ON DELETE SET NULL,
  PRIMARY KEY (reservation_id, station_id)
);
CREATE INDEX reservation_stations_held_idx ON reservation_stations (station_id) WHERE state = 'held';
