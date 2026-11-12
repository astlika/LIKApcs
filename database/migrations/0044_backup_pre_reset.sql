-- 0.20.11 — factory reset (Settings → Security). The safety backup taken right before a reset is
-- recorded with its own kind, so the backup list explains why it exists.

ALTER TABLE backup_history DROP CONSTRAINT backup_history_kind_check;
ALTER TABLE backup_history
  ADD CONSTRAINT backup_history_kind_check
  CHECK (kind IN ('manual', 'scheduled', 'pre_migration', 'pre_restore', 'pre_import', 'pre_reset'));
