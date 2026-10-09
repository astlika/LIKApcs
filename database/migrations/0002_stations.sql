-- ============================================================================
-- LIKApcs migration 0002 — gaming stations, client devices, heartbeats.
-- ============================================================================

CREATE TABLE stations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number     integer NOT NULL UNIQUE CHECK (number BETWEEN 1 AND 999),
  code       text NOT NULL UNIQUE,                 -- 'PC 01', derived from number
  name       text NOT NULL,                        -- custom display name
  zone       text,                                 -- e.g. 'VIP room', 'Main hall'
  notes      text,
  is_enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER stations_set_updated_at BEFORE UPDATE ON stations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A device = one installation of LIKApcs-Client on one physical PC.
-- Lifecycle: pending → approved (bound to a station) → revoked. Rejected = never approved.
CREATE TABLE station_devices (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id               uuid REFERENCES stations(id) ON DELETE SET NULL,
  machine_id               text NOT NULL,          -- stable hardware/OS identifier reported by the client
  hostname                 text,
  os_info                  text,
  app_version              text,
  status                   text NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'approved', 'revoked', 'rejected')),
  token_hash               text UNIQUE,            -- SHA-256 of the device token (issued on approval)
  registration_secret_hash text,                   -- SHA-256 of the client-generated registration secret
  token_collected_at       timestamptz,            -- when the client fetched its token (one-time)
  registered_at            timestamptz NOT NULL DEFAULT now(),
  approved_at              timestamptz,
  approved_by              uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at               timestamptz,
  revoked_by               uuid REFERENCES users(id) ON DELETE SET NULL,
  last_seen_at             timestamptz,
  last_ip                  text,
  last_heartbeat           jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER station_devices_set_updated_at BEFORE UPDATE ON station_devices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One live (pending/approved) record per physical machine.
CREATE UNIQUE INDEX station_devices_machine_live_idx
  ON station_devices (machine_id) WHERE status IN ('pending', 'approved');
-- At most one approved device per station.
CREATE UNIQUE INDEX station_devices_one_approved_per_station_idx
  ON station_devices (station_id) WHERE status = 'approved' AND station_id IS NOT NULL;
CREATE INDEX station_devices_status_idx ON station_devices (status);

-- Heartbeat history (high volume; pruned by retention job, default 7 days).
CREATE TABLE station_heartbeats (
  id          bigserial PRIMARY KEY,
  device_id   uuid NOT NULL REFERENCES station_devices(id) ON DELETE CASCADE,
  station_id  uuid REFERENCES stations(id) ON DELETE SET NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  app_version text,
  session_id  uuid,                                -- FK added in 0007 (gaming_sessions)
  locked      boolean,
  metrics     jsonb
);
CREATE INDEX station_heartbeats_device_time_idx ON station_heartbeats (device_id, received_at DESC);
CREATE INDEX station_heartbeats_received_idx ON station_heartbeats (received_at);

-- Device connection / error log shown in the Admin (append-only).
CREATE TABLE station_connection_logs (
  id          bigserial PRIMARY KEY,
  device_id   uuid NOT NULL REFERENCES station_devices(id) ON DELETE CASCADE,
  station_id  uuid REFERENCES stations(id) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  event       text NOT NULL CHECK (event IN ('connected', 'disconnected', 'timeout', 'rejected', 'error', 'replaced')),
  details     jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX station_connection_logs_device_idx ON station_connection_logs (device_id, occurred_at DESC);

-- Late foreign keys from 0001
ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_actor_device_fk
  FOREIGN KEY (actor_device_id) REFERENCES station_devices(id) ON DELETE SET NULL;
ALTER TABLE update_history
  ADD CONSTRAINT update_history_device_fk
  FOREIGN KEY (device_id) REFERENCES station_devices(id) ON DELETE SET NULL;
