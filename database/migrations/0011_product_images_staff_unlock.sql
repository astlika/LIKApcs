-- ============================================================================
-- LIKApcs migration 0011 — product images, staff unlock at the station PC,
-- shorter passwords/PINs.
--
-- Product images: the picture itself is a file in <data dir>/uploads/products/ (never in
-- the installation folder); `products.image_path` (added in 0003, unused so far) holds the
-- file name. The file name is unique per upload so it can be cached forever.
--
-- Staff unlock: a staff member standing at a locked station PC can unlock it for
-- maintenance with their own username/password. The server verifies the credentials and the
-- `stations.unlock` permission, records the grant on the station (so a reconnect does not
-- re-lock the PC) and locks it again when the grant expires.
-- ============================================================================

ALTER TABLE stations
  ADD COLUMN maintenance_until   timestamptz,
  ADD COLUMN maintenance_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN maintenance_by_name text;

INSERT INTO permissions (code, category, description) VALUES
  ('stations.unlock', 'stations', 'Unlock a station PC for maintenance with own credentials (at the PC)');

INSERT INTO role_permissions (role_id, permission_code)
  SELECT r.id, 'stations.unlock' FROM roles r WHERE r.code IN ('owner', 'admin', 'manager');

INSERT INTO settings (key, value) VALUES
  ('stations.maintenance_minutes', '15');

-- Short PINs are allowed (the login rate limit and account lockout protect against guessing);
-- installations that still carry the old seeded default move to the new one.
UPDATE settings SET value = '4' WHERE key = 'security.min_password_length' AND value = '8';
