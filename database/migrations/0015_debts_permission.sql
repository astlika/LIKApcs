-- ============================================================================
-- LIKApcs migration 0015 — "pay later" is a permission, not a setting.
--
-- 0.6.0 hid the debt tender behind `pos.credit_sales` (default off) — in practice nobody found
-- it. From 0.7.0 the tender is offered to everyone who holds `debts.give`; the owner shapes who
-- that is under Employees → Roles. Owner, admin, manager and cashier start with it. The setting
-- row is removed (the shared settings schema no longer knows the key); `pos.credit_default_days`
-- stays.
-- ============================================================================

INSERT INTO permissions (code, category, description) VALUES
  ('debts.give', 'customers', 'Sell on credit — "pay later" with a due date (POS and session bills)');
INSERT INTO role_permissions (role_id, permission_code)
  SELECT r.id, 'debts.give' FROM roles r WHERE r.code IN ('owner', 'admin', 'manager', 'cashier');

DELETE FROM settings WHERE key = 'pos.credit_sales';
