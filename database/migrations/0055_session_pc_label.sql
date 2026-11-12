-- 0.33.0: the name a PC shows for one session (the customer's name or a name staff type).
-- Session-scoped on purpose: when the session ends the PC shows its own name again.
ALTER TABLE gaming_sessions
  ADD COLUMN pc_label text CHECK (pc_label IS NULL OR char_length(pc_label) BETWEEN 1 AND 60);
