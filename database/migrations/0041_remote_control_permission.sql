-- 0.20.1 (remote control, phase 2): sending mouse and keyboard to a station PC is a separate,
-- stronger permission than watching it. Owner and admin only by default (not manager).
INSERT INTO permissions (code, category, description) VALUES
  ('remote.control', 'stations', 'Control the mouse and keyboard of station PCs (remote control)');

INSERT INTO role_permissions (role_id, permission_code)
  SELECT r.id, 'remote.control' FROM roles r WHERE r.code IN ('owner', 'admin');
