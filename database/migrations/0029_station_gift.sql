-- 0.18.0 · Gift minutes: staff can hand free time to a running prepaid / end-pay session.
--
-- The session timeline gets a new event type, `gifted` (the CHECK list is rebuilt: PostgreSQL
-- cannot extend a CHECK in place).
--
-- A gift moves the end of the session forward without money changing hands; it has its own
-- permission so that only the owner / administrators can give time away. The PC celebrates it
-- (the client shows a short party-popper animation). Owner and administrator get the permission
-- here; every other role gets it from Settings › Roles, like any other permission.
INSERT INTO permissions (code, category, description) VALUES
  ('stations.gift', 'stations', 'Give free minutes to a running session (the PC celebrates)')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
  SELECT r.id, 'stations.gift' FROM roles r WHERE r.code IN ('owner', 'admin')
ON CONFLICT DO NOTHING;

ALTER TABLE session_events DROP CONSTRAINT session_events_event_type_check;
ALTER TABLE session_events ADD CONSTRAINT session_events_event_type_check CHECK (event_type IN (
  'created', 'started', 'paused', 'resumed', 'extended', 'warning_sent',
  'expired', 'stopped', 'cancelled', 'transferred_out', 'transferred_in',
  'billed', 'discount_applied', 'correction', 'client_ack', 'client_timeout',
  'client_reconnected', 'lock_sent', 'unlock_sent', 'grace_started', 'grace_ended',
  'gifted'));
