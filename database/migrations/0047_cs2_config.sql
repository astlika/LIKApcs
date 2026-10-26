-- 0.24.0: the CS2 match server (one PC runs it, the others join with one click, and staff send
-- match commands over RCON). One row only. It lives in its own table, not in `settings`, so that
-- the passwords it holds are never written to the audit log by the settings service.
CREATE TABLE IF NOT EXISTS cs2_config (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO cs2_config (id, config) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING;
