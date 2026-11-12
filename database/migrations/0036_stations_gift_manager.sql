-- 0.19.1: managers may give free minutes too. Grants `stations.gift` to the manager role; owner and
-- admin keep it. Nothing is removed, and the audit log still records who gave every gift.
-- Migration 0030 stays as released; this one only extends the grant.

INSERT INTO role_permissions (role_id, permission_code)
  SELECT r.id, 'stations.gift' FROM roles r WHERE r.code = 'manager'
  ON CONFLICT (role_id, permission_code) DO NOTHING;
