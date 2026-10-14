-- 0.18.1: the gift permission moves from `sessions.gift` (owner/admin/manager) to
-- `stations.gift`, granted to owner and admin only. Gifting is a house decision: a manager who
-- had it keeps everything else, but gives no free minutes unless the owner grants it again.
-- Migration 0029 stays as released; this one only corrects the permission.

INSERT INTO permissions (code, category, description) VALUES
  ('stations.gift', 'stations', 'Give free minutes to a running session (audited)')
  ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
  SELECT r.id, 'stations.gift' FROM roles r WHERE r.code IN ('owner', 'admin')
  ON CONFLICT (role_id, permission_code) DO NOTHING;

DELETE FROM role_permissions WHERE permission_code = 'sessions.gift';
DELETE FROM permissions WHERE code = 'sessions.gift';
