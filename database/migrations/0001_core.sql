-- ============================================================================
-- LIKApcs migration 0001 — core: roles, permissions, users, sessions, audit,
-- settings, application versions, update & backup history.
--
-- Conventions used across all migrations:
--   * Primary keys are UUID v4 (gen_random_uuid(), PostgreSQL ≥ 13) unless a
--     table is append-only and high volume (then BIGSERIAL).
--   * Monetary amounts are BIGINT in MINOR units (cents). Never floats.
--   * Quantities are BIGINT in MILLI units (1 piece = 1000).
--   * Percentages are INTEGER basis points (18 % = 1800).
--   * Timestamps are TIMESTAMPTZ. Enumerations use TEXT + CHECK constraints so
--     they can be extended with a plain migration.
--   * Each migration runs inside one transaction (see server db/migrate.ts).
-- ============================================================================

-- Generic updated_at maintenance -------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Roles & permissions --------------------------------------------------------
CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text,
  is_system   boolean NOT NULL DEFAULT false,
  rank        integer NOT NULL DEFAULT 100,   -- lower = more powerful (owner = 0)
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  code        text PRIMARY KEY,
  category    text NOT NULL,
  description text NOT NULL
);

CREATE TABLE role_permissions (
  role_id         uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

-- Users ----------------------------------------------------------------------
CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username              text NOT NULL,
  full_name             text NOT NULL,
  password_hash         text NOT NULL,          -- scrypt, see server/src/security/password.ts
  email                 text,
  phone                 text,
  is_active             boolean NOT NULL DEFAULT true,
  must_change_password  boolean NOT NULL DEFAULT false,
  failed_login_attempts integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  last_login_at         timestamptz,
  created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_username_format CHECK (username ~ '^[a-zA-Z0-9._-]{3,32}$')
);
CREATE UNIQUE INDEX users_username_lower_idx ON users (lower(username));
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE user_roles (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, role_id)
);

-- Login sessions (opaque bearer tokens; only the SHA-256 hash is stored) ------
CREATE TABLE user_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  client_app   text NOT NULL DEFAULT 'admin',   -- admin | web | cli
  ip_address   text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX user_sessions_user_idx ON user_sessions (user_id);
CREATE INDEX user_sessions_expires_idx ON user_sessions (expires_at);

-- Audit log (append-only; rows are never updated or deleted by the app) ------
CREATE TABLE audit_logs (
  id              bigserial PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_device_id uuid,                          -- FK added in 0002 (station_devices)
  actor_label     text,                          -- snapshot: username or station code
  action          text NOT NULL,                 -- e.g. 'auth.login', 'station.create'
  entity_type     text,
  entity_id       text,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address      text,
  severity        text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical'))
);
CREATE INDEX audit_logs_occurred_idx ON audit_logs (occurred_at DESC);
CREATE INDEX audit_logs_action_idx   ON audit_logs (action);
CREATE INDEX audit_logs_actor_idx    ON audit_logs (actor_user_id);
CREATE INDEX audit_logs_entity_idx   ON audit_logs (entity_type, entity_id);

-- Settings (key → JSON value) ------------------------------------------------
CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);

-- Known application releases (populated by the update subsystem, Phase 7) ----
CREATE TABLE application_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  component          text NOT NULL CHECK (component IN ('admin', 'client', 'server')),
  version            text NOT NULL,
  channel            text NOT NULL DEFAULT 'stable' CHECK (channel IN ('stable', 'beta')),
  schema_version     integer,                     -- schema the server release requires
  min_server_version text,                        -- for admin/client releases
  released_at        timestamptz,
  release_notes      text,
  download_url       text,
  signature          text,                        -- detached signature of the installer
  sha256             text,
  is_latest          boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (component, version)
);

CREATE TABLE update_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  component      text NOT NULL CHECK (component IN ('admin', 'client', 'server')),
  device_id      uuid,                           -- FK added in 0002
  from_version   text,
  to_version     text NOT NULL,
  status         text NOT NULL CHECK (status IN ('pending', 'downloading', 'downloaded', 'installing', 'succeeded', 'failed', 'rolled_back')),
  initiated_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  error_message  text,
  details        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX update_history_component_idx ON update_history (component, started_at DESC);

CREATE TABLE backup_history (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('manual', 'scheduled', 'pre_migration', 'pre_restore')),
  status       text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'deleted')),
  file_path    text,
  size_bytes   bigint,
  sha256       text,
  schema_version integer,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  error_message text,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX backup_history_started_idx ON backup_history (started_at DESC);

-- ============================================================================
-- Seed data: permissions, system roles, default settings.
-- (Mirrored in packages/shared/src/permissions.ts and settings.ts — a test checks sync.)
-- ============================================================================
INSERT INTO permissions (code, category, description) VALUES
  ('dashboard.view',   'dashboard', 'View the dashboard'),
  ('reports.view',     'reports',   'View financial and operational reports'),
  ('reports.export',   'reports',   'Export reports (PDF/CSV)'),
  ('stations.view',    'stations',  'View gaming stations and sessions'),
  ('stations.manage',  'stations',  'Create, edit, enable and disable stations'),
  ('stations.control', 'stations',  'Start, pause, resume, extend, transfer and stop sessions'),
  ('stations.power',   'stations',  'Restart or shut down station PCs'),
  ('devices.manage',   'stations',  'Approve, revoke and re-register client devices'),
  ('pricing.manage',   'stations',  'Manage pricing rules and gaming packages'),
  ('pos.sell',         'pos',       'Create sales at the point of sale'),
  ('pos.discount',     'pos',       'Apply discounts'),
  ('pos.refund',       'pos',       'Process refunds and returns'),
  ('pos.suspend',      'pos',       'Suspend and resume sales'),
  ('pos.reprint',      'pos',       'Reprint receipts and invoices'),
  ('products.view',    'inventory', 'View products and stock levels'),
  ('products.manage',  'inventory', 'Create, edit and archive products'),
  ('inventory.adjust', 'inventory', 'Adjust stock with a reason'),
  ('inventory.count',  'inventory', 'Perform stock counts'),
  ('purchases.view',   'purchasing','View purchases and suppliers'),
  ('purchases.manage', 'purchasing','Create purchases and receive stock'),
  ('purchases.pay',    'purchasing','Record supplier payments'),
  ('suppliers.manage', 'purchasing','Manage supplier profiles'),
  ('customers.view',   'customers', 'View customers'),
  ('customers.manage', 'customers', 'Create and edit customers'),
  ('users.view',       'staff',     'View employees'),
  ('users.manage',     'staff',     'Create, edit and deactivate employees'),
  ('cash.view',        'cash',      'View cash register and shifts'),
  ('cash.open_close',  'cash',      'Open and close cash shifts'),
  ('cash.move',        'cash',      'Record cash deposits and withdrawals'),
  ('expenses.view',    'finance',   'View expenses'),
  ('expenses.manage',  'finance',   'Record and edit expenses'),
  ('settings.view',    'system',    'View settings'),
  ('settings.manage',  'system',    'Change settings'),
  ('audit.view',       'system',    'View the audit log'),
  ('backups.manage',   'system',    'Create and restore backups'),
  ('updates.manage',   'system',    'Manage application updates');

INSERT INTO roles (code, name, description, is_system, rank) VALUES
  ('owner',      'Owner / Super Administrator', 'Full control, including other administrators', true, 0),
  ('admin',      'Administrator',               'Full operational and configuration access',    true, 10),
  ('manager',    'Manager',                     'Daily operations, staff supervision, reports', true, 20),
  ('cashier',    'Cashier',                     'POS sales and gaming session control',         true, 30),
  ('inventory',  'Inventory Manager',           'Products, stock and purchasing',               true, 30),
  ('accountant', 'Accountant (read-only)',      'Reports, finance and audit — read only',       true, 30);

INSERT INTO role_permissions (role_id, permission_code)
  SELECT r.id, p.code FROM roles r CROSS JOIN permissions p WHERE r.code IN ('owner', 'admin');

INSERT INTO role_permissions (role_id, permission_code)
  SELECT r.id, p.code FROM roles r CROSS JOIN permissions p
  WHERE r.code = 'manager'
    AND p.code NOT IN ('users.manage', 'settings.manage', 'backups.manage', 'updates.manage');

INSERT INTO role_permissions (role_id, permission_code)
  SELECT r.id, p.code FROM roles r CROSS JOIN permissions p
  WHERE r.code = 'cashier' AND p.code IN (
    'dashboard.view', 'stations.view', 'stations.control', 'pos.sell', 'pos.suspend', 'pos.reprint',
    'products.view', 'customers.view', 'customers.manage', 'cash.view', 'cash.open_close', 'cash.move');

INSERT INTO role_permissions (role_id, permission_code)
  SELECT r.id, p.code FROM roles r CROSS JOIN permissions p
  WHERE r.code = 'inventory' AND p.code IN (
    'dashboard.view', 'products.view', 'products.manage', 'inventory.adjust', 'inventory.count',
    'purchases.view', 'purchases.manage', 'suppliers.manage', 'reports.view');

INSERT INTO role_permissions (role_id, permission_code)
  SELECT r.id, p.code FROM roles r CROSS JOIN permissions p
  WHERE r.code = 'accountant' AND p.code IN (
    'dashboard.view', 'reports.view', 'reports.export', 'cash.view', 'expenses.view',
    'purchases.view', 'products.view', 'customers.view', 'audit.view', 'settings.view');

INSERT INTO settings (key, value) VALUES
  ('business.name',                '"LIKApcs Gaming Station"'),
  ('business.legal_name',          '""'),
  ('business.address',             '""'),
  ('business.city',                '""'),
  ('business.phone',               '""'),
  ('business.email',               '""'),
  ('business.website',             '""'),
  ('business.tax_id',              '""'),
  ('business.registration_no',     '""'),
  ('business.logo_path',           '""'),
  ('business.receipt_footer',      '""'),
  ('locale.default_language',      '"en"'),
  ('locale.currency',              '"EUR"'),
  ('locale.timezone',              '"Europe/Belgrade"'),
  ('locale.date_format',           '"DD.MM.YYYY"'),
  ('locale.time_format',           '"HH:mm"'),
  ('tax.default_rate_bp',          '1800'),
  ('tax.prices_include_tax',       'true'),
  ('security.session_hours',       '12'),
  ('security.min_password_length', '8'),
  ('security.max_failed_logins',   '5'),
  ('security.lockout_minutes',     '15'),
  ('stations.heartbeat_interval_seconds', '10'),
  ('stations.offline_after_seconds',      '35'),
  ('stations.session_grace_seconds',      '120'),
  ('stations.expiry_warning_minutes',     '[5, 1]'),
  ('stations.client_welcome_message',     '"Welcome! Please ask the staff to start your session."'),
  ('pos.scan_increments_quantity', 'true'),
  ('pos.receipt_width_mm',         '80'),
  ('pos.auto_print_receipt',       'true'),
  ('backup.enabled',               'true'),
  ('backup.time',                  '"04:00"'),
  ('backup.keep_count',            '30'),
  ('updates.channel',              '"stable"'),
  ('updates.check_on_startup',     'true'),
  ('updates.auto_download',        'false'),
  ('updates.client_policy',        '"idle_only"'),
  ('updates.maintenance_window',   '"03:00-06:00"');
