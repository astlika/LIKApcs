-- 0.18.0: free "gift minutes" on a running session.
-- The gift itself needs no schema: it is an `extended` session_event with `payload.gift = true`
-- and price 0, plus a `session.gift` audit row. Only the permission is new — the owner decides
-- who may give minutes away (defaults: owner/admin/manager).

INSERT INTO permissions (code, category, description) VALUES
  ('sessions.gift', 'stations', 'Give free minutes to a running session (audited)');

INSERT INTO role_permissions (role_id, permission_code)
  SELECT r.id, 'sessions.gift' FROM roles r WHERE r.code IN ('owner', 'admin', 'manager');
