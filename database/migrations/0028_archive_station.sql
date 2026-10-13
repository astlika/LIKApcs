-- 0.17.0 · Archive PC: a station can leave the floor without losing its money history.
--
-- Deleting a station is only honest while nothing was ever billed on it (gaming_sessions
-- references stations with ON DELETE RESTRICT). A PC that has served customers is therefore
-- ARCHIVED: it disappears from the map, its device is revoked (so the PC must be paired again —
-- as new, or under another name), and the reason is kept on the row and in the audit log.
ALTER TABLE stations
  ADD COLUMN archived_at     timestamptz,
  ADD COLUMN archived_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN archived_reason text;
