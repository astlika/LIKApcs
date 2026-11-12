-- 0.31.0 (live tracking): the live page and the sale notifications. Owner and admin by default;
-- the other roles get it only when an owner grants it.
INSERT INTO permissions (code, category, description) VALUES
  ('live.view', 'reports', 'Live tracking: today''s sales, drawer, staff and sale notifications');

INSERT INTO role_permissions (role_id, permission_code)
  SELECT r.id, 'live.view' FROM roles r WHERE r.code IN ('owner', 'admin');
