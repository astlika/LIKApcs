-- 0.27.0: change the price of a bill that is already paid (prepaid time, or a bill that was collected).
-- The new permission is granted to owner and admin; other roles can be given it in Roles & permissions.
INSERT INTO permissions (code, category, description) VALUES
  ('pos.adjust_paid', 'pos', 'Change the price of a bill that is already paid');

INSERT INTO role_permissions (role_id, permission_code)
  SELECT r.id, 'pos.adjust_paid' FROM roles r WHERE r.code IN ('owner', 'admin');

-- A price change that gives money back (or takes more) is stored as a refund with its own kind,
-- so reports can tell it apart from a refund of products.
ALTER TABLE refunds ADD COLUMN kind text NOT NULL DEFAULT 'refund'
  CHECK (kind IN ('refund', 'price_adjustment'));
