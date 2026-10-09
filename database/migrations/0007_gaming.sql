-- ============================================================================
-- LIKApcs migration 0007 — gaming: pricing rules, packages, sessions, events.
-- Implemented by the application in Phase 3 (server) and Phase 4 (client).
--
-- Billing model:
--   * The SERVER owns all timestamps. Clients only display time.
--   * A session's charge is finalised exactly once (billed_at / sale_id are set in the
--     same transaction that records the sale line). Corrections are new rows, never edits.
--   * Pause time is excluded from billable time (total_paused_seconds).
-- ============================================================================

CREATE TABLE pricing_rules (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      text NOT NULL,
  station_id                uuid REFERENCES stations(id) ON DELETE CASCADE,   -- NULL = applies to all stations
  days_of_week              smallint[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}',       -- ISO: 1 = Monday … 7 = Sunday
  start_time                time,                                               -- NULL = whole day
  end_time                  time,
  rate_cents_per_hour       bigint NOT NULL CHECK (rate_cents_per_hour >= 0),
  billing_increment_minutes integer NOT NULL DEFAULT 1 CHECK (billing_increment_minutes BETWEEN 1 AND 120),
  minimum_charge_cents      bigint NOT NULL DEFAULT 0 CHECK (minimum_charge_cents >= 0),
  minimum_minutes           integer NOT NULL DEFAULT 0 CHECK (minimum_minutes >= 0),
  rounding_mode             text NOT NULL DEFAULT 'up' CHECK (rounding_mode IN ('up', 'down', 'nearest')),
  rounding_increment_cents  bigint NOT NULL DEFAULT 1 CHECK (rounding_increment_cents >= 1),
  is_happy_hour             boolean NOT NULL DEFAULT false,
  priority                  integer NOT NULL DEFAULT 0,          -- higher wins when several rules match
  is_active                 boolean NOT NULL DEFAULT true,
  valid_from                date,
  valid_to                  date,
  created_by                uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pricing_rules_station_idx ON pricing_rules (station_id) WHERE is_active;
CREATE TRIGGER pricing_rules_set_updated_at BEFORE UPDATE ON pricing_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE gaming_packages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
  price_cents      bigint NOT NULL CHECK (price_cents >= 0),       -- 0 = free-time promotion
  station_ids      uuid[],                                         -- NULL = all stations
  days_of_week     smallint[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}',
  start_time       time,
  end_time         time,
  is_promotional   boolean NOT NULL DEFAULT false,
  valid_from       date,
  valid_to         date,
  is_active        boolean NOT NULL DEFAULT true,
  sort_order       integer NOT NULL DEFAULT 0,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER gaming_packages_set_updated_at BEFORE UPDATE ON gaming_packages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE gaming_sessions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id            uuid NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
  device_id             uuid REFERENCES station_devices(id) ON DELETE SET NULL,
  customer_id           uuid REFERENCES customers(id) ON DELETE SET NULL,
  customer_name         text,                                     -- walk-in name without a customer record
  billing_mode          text NOT NULL CHECK (billing_mode IN ('prepaid', 'postpaid')),
  status                text NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'cancelled', 'expired')),
  pricing_rule_id       uuid REFERENCES pricing_rules(id) ON DELETE SET NULL,
  package_id            uuid REFERENCES gaming_packages(id) ON DELETE SET NULL,
  rate_cents_per_hour   bigint NOT NULL DEFAULT 0 CHECK (rate_cents_per_hour >= 0),  -- snapshot
  planned_seconds       integer CHECK (planned_seconds IS NULL OR planned_seconds > 0), -- prepaid duration incl. extensions
  started_at            timestamptz NOT NULL,
  ends_at               timestamptz,                               -- prepaid: authoritative expiry (shifted by pauses/extensions)
  paused_at             timestamptz,
  total_paused_seconds  integer NOT NULL DEFAULT 0 CHECK (total_paused_seconds >= 0),
  ended_at              timestamptz,
  end_reason            text CHECK (end_reason IN ('expired', 'stopped_by_staff', 'cancelled', 'transferred', 'server_recovery')),
  billable_seconds      integer CHECK (billable_seconds IS NULL OR billable_seconds >= 0),
  quoted_price_cents    bigint CHECK (quoted_price_cents IS NULL OR quoted_price_cents >= 0),  -- shown before confirming prepaid
  discount_cents        bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  final_price_cents     bigint CHECK (final_price_cents IS NULL OR final_price_cents >= 0),
  sale_id               uuid REFERENCES sales(id) ON DELETE SET NULL,  -- the sale that billed this session
  billed_at             timestamptz,
  transferred_from_id   uuid REFERENCES gaming_sessions(id) ON DELETE SET NULL,
  created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  notes                 text,
  version               integer NOT NULL DEFAULT 1,                 -- optimistic concurrency
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gaming_sessions_prepaid_has_end CHECK (billing_mode <> 'prepaid' OR ends_at IS NOT NULL),
  CONSTRAINT gaming_sessions_billed_once CHECK ((sale_id IS NULL) = (billed_at IS NULL))
);
-- Only one live (active/paused) session per station — unless a future shared-session feature
-- deliberately relaxes this constraint in a dedicated migration.
CREATE UNIQUE INDEX gaming_sessions_one_live_per_station_idx
  ON gaming_sessions (station_id) WHERE status IN ('active', 'paused');
CREATE INDEX gaming_sessions_started_idx ON gaming_sessions (started_at DESC);
CREATE INDEX gaming_sessions_customer_idx ON gaming_sessions (customer_id);
CREATE INDEX gaming_sessions_status_idx ON gaming_sessions (status);
CREATE TRIGGER gaming_sessions_set_updated_at BEFORE UPDATE ON gaming_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Append-only event stream for every session (audit + reconciliation after disconnects).
CREATE TABLE session_events (
  id              bigserial PRIMARY KEY,
  session_id      uuid NOT NULL REFERENCES gaming_sessions(id) ON DELETE CASCADE,
  event_type      text NOT NULL CHECK (event_type IN (
                    'created', 'started', 'paused', 'resumed', 'extended', 'warning_sent',
                    'expired', 'stopped', 'cancelled', 'transferred_out', 'transferred_in',
                    'billed', 'discount_applied', 'correction', 'client_ack', 'client_timeout',
                    'client_reconnected', 'lock_sent', 'unlock_sent', 'grace_started', 'grace_ended')),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_device_id uuid REFERENCES station_devices(id) ON DELETE SET NULL,
  command_id      uuid UNIQUE,                                   -- idempotency key for commands
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX session_events_session_idx ON session_events (session_id, occurred_at);

-- Late foreign keys
ALTER TABLE sale_items
  ADD CONSTRAINT sale_items_gaming_session_fk
  FOREIGN KEY (gaming_session_id) REFERENCES gaming_sessions(id) ON DELETE SET NULL;
ALTER TABLE station_heartbeats
  ADD CONSTRAINT station_heartbeats_session_fk
  FOREIGN KEY (session_id) REFERENCES gaming_sessions(id) ON DELETE SET NULL;
