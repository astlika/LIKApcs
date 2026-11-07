-- 0.20.0 (remote view, phase 1): watching the live screen of a station PC is a separate permission.
-- Read-only; owner, admin and manager get it by default, like the other station views.
INSERT INTO permissions (code, category, description) VALUES
  ('remote.view', 'stations', 'View the live screen of station PCs (read-only)');

INSERT INTO role_permissions (role_id, permission_code)
  SELECT r.id, 'remote.view' FROM roles r WHERE r.code IN ('owner', 'admin', 'manager');
