-- 0.15.0 · Import from another program ("Importo nga program tjetër").
--
-- A LIKApos Pro backup (JSON) can be brought into LIKApcs from the Backups page: categories,
-- products (+ barcodes, opening stock, pictures), customers (+ PC login), open debts, the sales
-- history and expenses. The import runs in ONE transaction after an automatic backup
-- (`backup_history.kind = 'pre_import'`), so a failure leaves nothing behind and a mistake can be
-- rolled back with Restore.
--
-- * `import_runs`   one row per attempt (also dry runs are NOT recorded — only real imports),
--                   with the report the operator saw.
-- * `import_links`  external id → internal id per (source, entity). Running the same file twice
--                   skips everything already linked, so a partial file or a second export only adds
--                   what is new. Rows are never deleted by the application.

ALTER TABLE backup_history DROP CONSTRAINT backup_history_kind_check;
ALTER TABLE backup_history
  ADD CONSTRAINT backup_history_kind_check
  CHECK (kind IN ('manual', 'scheduled', 'pre_migration', 'pre_restore', 'pre_import'));

CREATE TABLE import_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source       text NOT NULL,                    -- 'likapos_pro'
  file_name    text,
  backup_id    uuid REFERENCES backup_history(id) ON DELETE SET NULL,
  started_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  report       jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE import_links (
  source       text NOT NULL,
  entity       text NOT NULL,                    -- category | product | customer | debt | sale | expense | expense_category
  external_id  text NOT NULL,
  internal_id  text NOT NULL,                    -- uuid for most entities, the code for expense categories
  run_id       uuid REFERENCES import_runs(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, entity, external_id)
);
CREATE INDEX import_links_internal_idx ON import_links (source, entity, internal_id);
