-- 0.39.0 («Skedar për AI»): one file with every figure of the business — every sale, session,
-- drawer and stock movement, customer and price — made on the Reports page to hand to an AI.
-- It holds far more than any single report, so it has a permission of its own. Owner and admin
-- by default; the other roles get it only when an owner grants it.
INSERT INTO permissions (code, category, description) VALUES
  ('reports.export_all', 'reports', 'Make the data file for an AI: every sale, session, drawer and stock movement in one file');

INSERT INTO role_permissions (role_id, permission_code)
  SELECT r.id, 'reports.export_all' FROM roles r WHERE r.code IN ('owner', 'admin');
